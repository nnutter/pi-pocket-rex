/**
 * One libghostty-vt screen, and the frames that a page draws from it.
 *
 * The engine keeps the screen; this file turns it into the rows that changed since the last frame, at most one frame
 * each 16 ms, so that a busy program cannot flood the socket. It owns nothing outside itself: bytes come in through
 * `write`, the answers that the terminal gives a program go out through `onWritePty`, and the frames go out through
 * `onFrame`. A pty host and a Rex host differ only in where those bytes come from and go to.
 */
import { RenderState, Terminal } from "libghostty-vt";
import { Escapes, type CursorStyle } from "./escapes.ts";
import type { CellStyle, RenderCell } from "libghostty-vt";

/** The shortest time between two frames, so a busy program cannot flood the socket: about 60 frames a second. */
const MIN_FRAME_MS = 16;

/** Style bits of a run, as the browser module reads them. */
const BOLD = 1;
const FAINT = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const STRIKE = 16;
const OVERLINE = 32;
const BLINK = 64;
const INVERSE = 128;
const INVISIBLE = 256;

/**
 * A piece of a row that shares a look: `[text, foreground, background, flags, columns]`. An empty color is the default,
 * and `columns` is how many of the terminal's own cells the text covers, which is what the page draws it in: a font
 * decides how wide a glyph is, and a terminal decides how many cells it takes.
 */
export type Run = [text: string, fg: string, bg: string, flags: number, columns: number];

/** What the browser needs to draw the screen. Only the rows in `lines` are new since the frame before. */
export interface Frame {
    seq: number;
    full: boolean;
    cols: number;
    rows: number;
    title: string;
    cursor: { x: number; y: number; visible: boolean; shape: "block" | "underline" | "bar"; blink: boolean };
    alt: boolean;
    scroll: { scrollback: number };
    lines: Array<{ y: number; runs: Run[] }>;
}

/** What a screen says to whoever owns it. */
export interface ScreenEvents {
    /** A frame: the rows that changed, and the cursor, title, and scroll position when they did. */
    onFrame(frame: Frame): void;
    /** Bytes that the terminal answers a program with, such as a reply to a device-attributes query. */
    onWritePty(bytes: Uint8Array): void;
    /** A program set the title, and the frame that follows carries it. */
    onBell?(): void;
    /** A program copied to the clipboard, or asked what it holds when `text` is null. */
    onClipboard?(selection: string, text: string | null): void;
}

export interface ScreenOptions extends ScreenEvents {
    cols: number;
    rows: number;
    /** How many rows above the screen to keep. Leave it out for 5000. */
    maxScrollback?: number;
}

interface CellLook {
    readonly fg: string;
    readonly bg: string;
    readonly flags: number;
}

const DEFAULT_LOOK: CellLook = { fg: "", bg: "", flags: 0 };

/** A color as CSS reads it, or `""` for the terminal's default. */
function colorOf(value: CellStyle["fg"], palette: readonly (readonly [number, number, number])[] | null): string {
    if (value === undefined) return "";

    const rgb = "palette" in value ? palette?.[value.palette] : ([value[0], value[1], value[2]] as const);

    if (rgb === undefined) return "";

    const [r, g, b] = rgb;

    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function lookOf(style: CellStyle | undefined, palette: readonly (readonly [number, number, number])[] | null): CellLook {
    if (style === undefined) return DEFAULT_LOOK;

    let flags = 0;

    if (style.bold) flags |= BOLD;
    if (style.faint) flags |= FAINT;
    if (style.italic) flags |= ITALIC;
    if (style.underline !== "none") flags |= UNDERLINE;
    if (style.strikethrough) flags |= STRIKE;
    if (style.overline) flags |= OVERLINE;
    if (style.blink) flags |= BLINK;
    if (style.inverse) flags |= INVERSE;
    if (style.invisible) flags |= INVISIBLE;

    const fg = style.inverse ? colorOf(style.bg, palette) : colorOf(style.fg, palette);
    const bg = style.inverse ? colorOf(style.fg, palette) : colorOf(style.bg, palette);

    return { fg, bg, flags };
}

function sameLook(a: CellLook, b: CellLook): boolean {
    return a.fg === b.fg && a.bg === b.bg && a.flags === b.flags;
}

/** One row's cells as runs, with the spaces at its end that look like nothing left out. */
function runsOf(cells: readonly RenderCell[], palette: readonly (readonly [number, number, number])[] | null): Run[] {
    const runs: Run[] = [];
    let pending = "";

    for (const cell of cells) {
        // The second half of a wide character: the character before it takes both columns.
        if (cell.isWideContinuation) continue;

        const look = lookOf(cell.style, palette);
        const text = cell.text === "" ? " " : cell.text;
        const columns = cell.wide ? 2 : 1;
        const last = runs.at(-1);

        if (last !== undefined && sameLook({ fg: last[1], bg: last[2], flags: last[3] }, look)) {
            last[0] += text;
            last[4] += columns;
        } else {
            runs.push([text, look.fg, look.bg, look.flags, columns]);
        }

        if (text === " ") pending += " ";
        else pending = "";
    }

    // A row's end that looks like the screen's own background needs no run of its own.
    if (pending !== "" && runs.length > 0) {
        const last = runs.at(-1)!;
        last[0] = last[0].slice(0, last[0].length - pending.length);
        last[4] -= pending.length;

        if (last[0] === "") runs.pop();
    }

    return runs;
}

/** A screen: the engine, the rows that changed, and the frames that carry them. */
export class Screen {
    readonly #term: Terminal;
    readonly #render = new RenderState();
    readonly #escapes = new Escapes();
    readonly #events: ScreenEvents;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #lastFrame = 0;
    #seq = 0;
    #title = "";
    #cursorShape: CursorStyle = { shape: "block", blink: false };
    #screen = "";
    #cursorKey = "";
    #closed = false;

    constructor(options: ScreenOptions) {
        this.#events = options;

        this.#term = new Terminal({
            cols: options.cols,
            rows: options.rows,
            maxScrollback: options.maxScrollback ?? 5000,
            onWritePty: (bytes) => this.#events.onWritePty(bytes),
            onTitleChanged: (title) => {
                this.#title = title;
                this.#schedule();
            },
            onBell: () => this.#events.onBell?.(),
        });

        // Colors come from the engine once, and change only when a program changes them.
        this.colors = this.#term.colors();
    }

    /** The palette that a frame's colors resolve against. */
    colors: ReturnType<Terminal["colors"]> | null;

    get terminal(): Terminal {
        return this.#term;
    }

    get title(): string {
        return this.#title;
    }

    /** Whether a mode that a program can set, such as bracketed paste, is on. */
    mode(name: Parameters<Terminal["mode"]>[0]): boolean {
        return this.#term.mode(name);
    }

    /** Takes bytes from the program: the screen keeps them, and the frame that follows says what changed. */
    write(bytes: Uint8Array): void {
        // The engine keeps the screen; these two things are the term's own work, and it does not tell them.
        const asked = this.#escapes.scan(bytes);

        if (asked.clipboard !== undefined) {
            this.#events.onClipboard?.(asked.clipboard.selection, asked.clipboard.text);
        }

        if (asked.cursor !== undefined) {
            if (asked.cursor.shape !== this.#cursorShape.shape) {
                this.#cursorShape = asked.cursor;
                this.#schedule();
            } else {
                this.#cursorShape = asked.cursor;
            }
        }

        this.#term.vtWrite(bytes);
        this.#schedule();
    }

    resize(cols: number, rows: number): void {
        this.#term.resize(cols, rows);
        this.#flush(true);
    }

    scroll(to: "top" | "bottom" | number): void {
        this.#term.scrollViewport(to);
        this.#flush(true);
    }

    /** Ends the screen, and sends one last whole frame so that a page can draw how it stood. */
    close(): void {
        if (this.#closed) return;

        this.#closed = true;
        this.#flush(true);
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** A frame of the whole screen, whether or not anything changed. */
    flush(): void {
        this.#flush(true);
    }

    #schedule(): void {
        if (this.#timer !== null || this.#closed) return;

        const wait = Math.max(0, MIN_FRAME_MS - (Date.now() - this.#lastFrame));

        this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#flush(false);
        }, wait);
    }

    /** Sends the rows that changed, and the cursor, the title, and the scroll position when they did. */
    #flush(full: boolean): void {
        if (this.#closed && !full) return;

        this.#lastFrame = Date.now();

        const snapshot = this.#term.snapshot();

        // A program that goes to the other screen, or comes back, leaves rows of the screen below with nothing new to
        // say: only a whole frame can put them right.
        const switched = snapshot.activeScreen !== this.#screen;

        this.#screen = snapshot.activeScreen;
        full = full || switched;

        this.#render.update(this.#term);

        const size = this.#render.size();
        const cursor = this.#render.cursor() ?? { x: 0, y: 0, visible: false, wideTail: false };
        const key = `${snapshot.activeScreen}/${snapshot.scrollbackRows}/${cursor.x},${cursor.y},${cursor.visible}/${this.#cursorShape.shape}${this.#cursorShape.blink}`;

        const palette = this.colors?.palette ?? null;
        const lines: Array<{ y: number; runs: Run[] }> = [];

        for (const row of this.#render.rows()) {
            if (full || row.dirty) lines.push({ y: row.y, runs: runsOf([...row.cells()], palette) });
        }

        this.#render.markClean();

        const moved = key !== this.#cursorKey;
        this.#cursorKey = key;

        if (!full && lines.length === 0 && !moved) return;

        this.#seq += 1;

        this.#events.onFrame({
            seq: this.#seq,
            full,
            cols: size.cols,
            rows: size.rows,
            title: this.#title,
            cursor: {
                x: cursor.x,
                y: cursor.y,
                visible: cursor.visible,
                shape: this.#cursorShape.shape,
                blink: this.#cursorShape.blink,
            },
            alt: snapshot.activeScreen === "alternate",
            scroll: { scrollback: snapshot.scrollbackRows },
            lines,
        });
    }
}
