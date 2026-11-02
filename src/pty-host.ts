/**
 * The rex runner: one process, one pty, one libghostty-vt screen.
 *
 * Pi Pocket's server runs on Node, and `libghostty-vt` needs Bun's FFI. So the module spawns this file with Bun and
 * talks to it in JSON lines: commands on stdin, frames on stdout. See `src/rex.ts`, which owns it.
 *
 * Run by hand to try it:
 *
 *     printf '%s\n' '{"op":"spawn","argv":["bash","-l"],"cols":80,"rows":24}' '' | bun src/pty-host.ts
 */
import { Formatter, RenderState, Terminal, KeyEncoder } from "libghostty-vt";
import { Escapes, clipboardReply, type CursorStyle } from "./escapes.ts";
import type { CellStyle, KeyEvent, RenderCell, TerminalColors } from "libghostty-vt";

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
type Run = [text: string, fg: string, bg: string, flags: number, columns: number];

interface CellLook {
    readonly fg: string;
    readonly bg: string;
    readonly flags: number;
}

const DEFAULT_LOOK: CellLook = { fg: "", bg: "", flags: 0 };

/** A color as CSS reads it, or `""` for the terminal's default. */
function colorOf(value: CellStyle["fg"], palette: readonly (readonly [number, number, number])[] | null): string {
    if (value === undefined) return "";

    const rgb =
        "palette" in value
            ? palette?.[value.palette]
            : ([value[0], value[1], value[2]] as const);

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

function write(message: unknown): void {
    Bun.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The pty, the screen that reads it, and the frames that they make. */
class Session {
    readonly #term: Terminal;
    readonly #render: RenderState;
    readonly #keys: KeyEncoder;
    readonly #escapes = new Escapes();
    readonly #proc: ReturnType<typeof Bun.spawn>;
    #colors: TerminalColors | null = null;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #lastFrame = 0;
    #seq = 0;
    #title = "";
    #cursorShape: CursorStyle = { shape: "block", blink: false };
    #screen = "";
    #cursorKey = "";
    #closed = false;

    constructor(argv: string[], cwd: string, cols: number, rows: number, env: Record<string, string>) {
        this.#term = new Terminal({
            cols,
            rows,
            maxScrollback: 5000,
            onWritePty: (bytes) => {
                this.#proc.terminal?.write(bytes);
            },
            onTitleChanged: (title) => {
                this.#title = title;
                this.#schedule();
            },
            onBell: () => {
                write({ t: "bell" });
            },
        });
        this.#render = new RenderState();
        this.#keys = new KeyEncoder({ terminal: this.#term });
        this.#colors = this.#term.colors();
        this.#proc = Bun.spawn(argv, {
            cwd,
            env,
            terminal: {
                cols,
                rows,
                data: (_terminal, data) => {
                    // The engine keeps the screen; these two things are the term's own work, and it does not tell them.
                    const asked = this.#escapes.scan(data);

                    if (asked.clipboard !== undefined) {
                        write({
                            t: asked.clipboard.text === null ? "clipboard-query" : "clipboard",
                            selection: asked.clipboard.selection,
                            text: asked.clipboard.text,
                        });
                    }

                    if (asked.cursor !== undefined && asked.cursor.shape !== this.#cursorShape.shape) {
                        this.#cursorShape = asked.cursor;
                        this.#schedule();
                    } else if (asked.cursor !== undefined) {
                        this.#cursorShape = asked.cursor;
                    }

                    this.#term.vtWrite(data);
                    this.#schedule();
                },
                exit: (_terminal, _code, signal) => {
                    this.#closed = true;
                    this.#flush(true);

                    // The callback's own code is not the program's: Bun gives 1 for every pty that ends, so the program
                    // is asked for how it went. Its signal is there too, and the end callback has none.
                    void this.#proc.exited.then((code) => {
                        write({ t: "exit", code, signal: this.#proc.signalCode ?? signal ?? null });
                        setTimeout(() => process.exit(0), 50);
                    });
                },
            },
        });
    }

    /** The palette that a frame's colors resolve against, or null before the first one. */
    #palette() {
        return this.#colors?.palette ?? null;
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

        const palette = this.#palette();
        const lines: Array<{ y: number; runs: Run[] }> = [];

        for (const row of this.#render.rows()) {
            if (full || row.dirty) lines.push({ y: row.y, runs: runsOf([...row.cells()], palette) });
        }

        this.#render.markClean();

        const moved = key !== this.#cursorKey;
        this.#cursorKey = key;

        if (!full && lines.length === 0 && !moved) return;

        this.#seq += 1;

        write({
            t: "frame",
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

    input(text: string | undefined, keys: readonly KeyEvent[] | undefined): void {
        const out: Uint8Array[] = [];

        if (typeof text === "string" && text !== "") out.push(new TextEncoder().encode(text));

        for (const event of keys ?? []) {
            try {
                out.push(this.#keys.encode(event));
            } catch {
                // A key that libghostty does not know: the person's own text still goes.
            }
        }

        const bytes = Buffer.concat(out.map((each) => Buffer.from(each)));

        if (bytes.length > 0) this.#proc.terminal?.write(bytes);
    }

    /** Text from a paste: wrapped as a paste when the running program asked for that, so its own indenting holds. */
    paste(text: string): void {
        const body = this.#term.mode("bracketed_paste") ? `\u001b[200~${text}\u001b[201~` : text;

        this.#proc.terminal?.write(body);
    }

    /** Tells a program that watches for it whether this terminal has the person's attention. */
    focus(inside: boolean): void {
        if (!this.#term.mode("focus_event")) return;

        this.#proc.terminal?.write(inside ? "\u001b[I" : "\u001b[O");
    }

    /** Answers a program that asked what the clipboard holds. */
    answer(selection: string, text: string): void {
        this.#proc.terminal?.write(clipboardReply(selection, text));
    }

    resize(cols: number, rows: number): void {
        this.#term.resize(cols, rows);
        this.#proc.terminal?.resize(cols, rows);
        this.#flush(true);
    }

    scroll(to: "top" | "bottom" | number): void {
        this.#term.scrollViewport(to);
        this.#flush(true);
    }

    kill(): void {
        this.#closed = true;
        this.#proc.terminal?.close();
        this.#proc.kill();
    }

    get pid(): number {
        return this.#proc.pid;
    }

    get terminal(): Terminal {
        return this.#term;
    }
}

let session: Session | null = null;

function handle(message: Record<string, unknown>): void {
    const op = message.op;

    if (op === "spawn") {
        if (session !== null) {
            write({ t: "error", message: "This runner already has a pty." });
            return;
        }

        try {
            session = new Session(
                message.argv as string[],
                String(message.cwd ?? process.cwd()),
                Number(message.cols ?? 80),
                Number(message.rows ?? 24),
                message.env as Record<string, string>,
            );
            write({ t: "ready", pid: session.pid });
            (session as Session).resize(Number(message.cols ?? 80), Number(message.rows ?? 24));
        } catch (error) {
            write({ t: "error", message: error instanceof Error ? error.message : String(error) });
        }

        return;
    }

    if (session === null) {
        write({ t: "error", message: `No pty yet: ${String(op)} came first.` });
        return;
    }

    switch (op) {
        case "input":
            session.input(message.text as string | undefined, message.keys as KeyEvent[] | undefined);
            break;
        case "paste":
            session.paste(String(message.text ?? ""));
            break;
        case "focus":
            session.focus(message.inside === true);
            break;
        case "clipboard":
            session.answer(String(message.selection ?? "c"), String(message.text ?? ""));
            break;
        case "resize":
            session.resize(Number(message.cols), Number(message.rows));
            break;
        case "scroll":
            session.scroll(message.to as "top" | "bottom" | number);
            break;
        case "kill":
            session.kill();
            break;
        case "ping":
            write({ t: "pong" });
            break;
        case "screen": {
            using formatter = new Formatter({ format: "plain" });

            write({ t: "screen", text: formatter.formatString(session.terminal) });
            break;
        }
        default:
            write({ t: "error", message: `Unknown op: ${String(op)}` });
    }
}

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    let cut = buffer.indexOf("\n");

    while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);

        if (line.trim() !== "") {
            try {
                handle(JSON.parse(line) as Record<string, unknown>);
            } catch (error) {
                write({ t: "error", message: error instanceof Error ? error.message : String(error) });
            }
        }

        cut = buffer.indexOf("\n");
    }
}
