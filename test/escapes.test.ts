/**
 * The sequences that the terminal acts on itself: the clipboard (OSC 52) and the cursor's shape (DECSCUSR). A pty hands
 * its output over in pieces, so half a sequence at the end of a chunk has to wait for the rest of it.
 */
import { describe, expect, test } from "bun:test";
import { Escapes, clipboardReply } from "../src/escapes.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const scan = (escapes: Escapes, text: string) => escapes.scan(encode(text));

describe("the clipboard's OSC 52", () => {
    test("takes the text that a program copies, and which selection it went to", () => {
        const escapes = new Escapes();
        const copied = scan(escapes, "\u001b]52;c;aGVsbG8gd29ybGQ=\u0007");

        expect(copied.clipboard).toEqual({ selection: "c", text: "hello world" });
    });

    test("reads a sequence that ends with a string terminator as well as a bell", () => {
        const escapes = new Escapes();

        expect(scan(escapes, "\u001b]52;c;YmV0dGVy\u001b\\").clipboard).toEqual({ selection: "c", text: "better" });
    });

    test("hears a question, for a program that pastes from the clipboard", () => {
        const escapes = new Escapes();

        expect(scan(escapes, "\u001b]52;c;?\u0007").clipboard).toEqual({ selection: "c", text: null });
    });

    test("waits for the rest of a sequence that the pty cut in two", () => {
        const escapes = new Escapes();

        expect(scan(escapes, "\u001b]52;c;aGVs").clipboard).toBeUndefined();
        expect(scan(escapes, "bG8=\u0007").clipboard).toEqual({ selection: "c", text: "hello" });
    });

    test("keeps what a program printed around it", () => {
        const escapes = new Escapes();
        const copied = scan(escapes, "before\u001b]52;c;bWlkZGxl\u0007after\u001b]52;c;bGFzdA==\u0007");

        // The last copy of a chunk is the one that lands, as a program that copies twice means.
        expect(copied.clipboard).toEqual({ selection: "c", text: "last" });
    });

    test("ignores another OSC, and another program's numbering", () => {
        const escapes = new Escapes();

        expect(scan(escapes, "\u001b]0;a title\u0007\u001b]8;;https://example.com\u0007").clipboard).toBeUndefined();
    });

    test("answers a question with the same sequence, base64 and all", () => {
        expect(clipboardReply("c", "hello")).toBe("\u001b]52;c;aGVsbG8=\u001b\\");
    });
});

describe("the cursor's DECSCUSR", () => {
    const shapes = [
        ["0", { shape: "block", blink: true }],
        ["1", { shape: "block", blink: true }],
        ["2", { shape: "block", blink: false }],
        ["3", { shape: "underline", blink: true }],
        ["4", { shape: "underline", blink: false }],
        ["5", { shape: "bar", blink: true }],
        ["6", { shape: "bar", blink: false }],
    ] as const;

    for (const [value, shape] of shapes) {
        test(`${value} is ${shape.shape}, ${shape.blink ? "blinking" : "steady"}`, () => {
            expect(scan(new Escapes(), `\u001b[${value} q`).cursor).toEqual(shape);
        });
    }

    test("waits for the rest of a sequence that the pty cut in two", () => {
        const escapes = new Escapes();

        expect(scan(escapes, "\u001b[2").cursor).toBeUndefined();
        expect(scan(escapes, " q").cursor).toEqual({ shape: "block", blink: false });
    });

    test("is not confused by another control sequence that ends in q", () => {
        expect(scan(new Escapes(), "\u001b[?25l\u001b[0m\u001b[3g").cursor).toBeUndefined();
    });
});
