/**
 * The escape sequences that a terminal has to act on itself, rather than draw: the clipboard (OSC 52) and the cursor's
 * shape (DECSCUSR).
 *
 * Ghostty's engine parses these into a screen, but this binding does not hand them back: `TerminalSnapshot` has no
 * cursor style, and an OSC 52 sequence is not a screen change at all. So the bytes are read here as they go to the
 * engine, and the two things that a program asked for come out. Sequences that continue in the next chunk of bytes are
 * kept, since a pty hands them over in pieces.
 */

/** The ways that a program asks for the cursor to look, from DECSCUSR: `ESC [ Ps SP q`. */
export type CursorShape = "block" | "underline" | "bar";

export interface CursorStyle {
    shape: CursorShape;
    blink: boolean;
}

/** What one chunk of a pty's output asked for. */
export interface Output {
    /** OSC 52 with a selection: the text to copy, or null when the program asks what the clipboard holds. */
    clipboard?: { selection: string; text: string | null };
    cursor?: CursorStyle;
}

const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x5d;
const CSI = 0x5b;

/** The longest sequence that is kept while it waits for the rest of itself: a clipboard's text can be large. */
const MAX_CARRY = 1_048_576;

/** DECSCUSR's value as the shape and the blink that it asks for. */
function cursorOf(value: number): CursorStyle | null {
    switch (value) {
        case 0:
        case 1:
            return { shape: "block", blink: true };
        case 2:
            return { shape: "block", blink: false };
        case 3:
            return { shape: "underline", blink: true };
        case 4:
            return { shape: "underline", blink: false };
        case 5:
            return { shape: "bar", blink: true };
        case 6:
            return { shape: "bar", blink: false };
        default:
            return null;
    }
}

/** OSC 52's body, `52 ; <selection> ; <base64 or ?>`, as the text to copy or a question. */
function clipboardOf(body: string): Output["clipboard"] | undefined {
    if (!body.startsWith("52;")) return undefined;

    const cut = body.indexOf(";", 3);

    if (cut < 0) return undefined;

    const selection = body.slice(3, cut) || "c";
    const data = body.slice(cut + 1);

    if (data === "?") return { selection, text: null };

    try {
        return { selection, text: Buffer.from(data, "base64").toString("utf8") };
    } catch {
        return undefined;
    }
}

/** Reads pty output a chunk at a time, and says what it asked for. */
export class Escapes {
    #carry = new Uint8Array(0);

    scan(bytes: Uint8Array): Output {
        const out: Output = {};
        const chunk = this.#carry.length === 0 ? bytes : Buffer.concat([this.#carry, bytes]);
        // A view, so that the pieces of a sequence can be read as text as well as searched as bytes.
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
        let at = 0;

        this.#carry = new Uint8Array(0);

        while (at < buffer.length) {
            const start = buffer.indexOf(ESC, at);

            if (start < 0) break;

            const kind = buffer[start + 1];

            if (kind === OSC) {
                const end = this.#oscEnd(buffer, start + 2);

                if (end === undefined) {
                    this.#keep(buffer.subarray(start));
                    break;
                }

                const clipboard = clipboardOf(buffer.toString("utf8", start + 2, end.body));

                if (clipboard !== undefined) out.clipboard = clipboard;

                at = end.after;
                continue;
            }

            if (kind === CSI) {
                const end = this.#csiEnd(buffer, start + 2);

                if (end === undefined) {
                    this.#keep(buffer.subarray(start));
                    break;
                }

                const final = buffer[end.final];
                const params = buffer.toString("latin1", start + 2, end.final);

                if (final === 0x71 /* q */ && params.endsWith(" ")) {
                    const cursor = cursorOf(Number.parseInt(params.slice(0, -1), 10));

                    if (cursor !== null) out.cursor = cursor;
                }

                at = end.after;
                continue;
            }

            at = start + 1;
        }

        return out;
    }

    #keep(rest: Uint8Array): void {
        if (rest.length <= MAX_CARRY) this.#carry = Buffer.from(rest);
    }

    /** Where an OSC body ends: a bell, or `ESC \`. */
    #oscEnd(buffer: Uint8Array, from: number): { body: number; after: number } | undefined {
        for (let at = from; at < buffer.length; at += 1) {
            if (buffer[at] === BEL) return { body: at, after: at + 1 };
            if (buffer[at] === ESC && buffer[at + 1] === 0x5c) return { body: at, after: at + 2 };
        }

        return undefined;
    }

    /** Where a control sequence ends: its final byte, in `@` to `~`. */
    #csiEnd(buffer: Uint8Array, from: number): { final: number; after: number } | undefined {
        for (let at = from; at < buffer.length; at += 1) {
            const byte = buffer[at]!;

            if (byte >= 0x40 && byte <= 0x7e) return { final: at, after: at + 1 };
        }

        return undefined;
    }
}

/** OSC 52 as a program reads it back from the terminal. */
export function clipboardReply(selection: string, text: string): string {
    return `\u001b]52;${selection};${Buffer.from(text, "utf8").toString("base64")}\u001b\\`;
}
