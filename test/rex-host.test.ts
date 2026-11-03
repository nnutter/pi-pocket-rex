/**
 * The Rex runner without Rex: bytes go in as a Rex stream would send them, and the frames that come out are the screen
 * that a page draws. This is the contract that the module depends on, and the reason a Rex terminal and a pty terminal
 * can be the same page.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "src", "rex-host.ts");

interface Event {
    t: string;
    [key: string]: unknown;
}

interface Frame extends Event {
    seq: number;
    full: boolean;
    cols: number;
    rows: number;
    title: string;
    cursor: { x: number; y: number; visible: boolean };
    alt: boolean;
    scroll: { scrollback: number };
    lines: Array<{ y: number; runs: Array<[string, string, string, number, number]> }>;
}

/** The words on a frame's rows: what a person would read. */
function textOf(frame: Frame): string {
    const rows: string[] = [];

    for (const line of frame.lines) rows[line.y] = line.runs.map((run) => run[0]).join("");

    return rows.map((row) => (row ?? "").replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
}

/** A runner, and the messages that it sent. */
class Runner {
    readonly #proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
    readonly events: Event[] = [];
    #buffer = "";

    constructor() {
        this.#proc = Bun.spawn(["bun", "run", runner], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });

        void this.#read();
    }

    async #read(): Promise<void> {
        const decoder = new TextDecoder();

        for await (const chunk of this.#proc.stdout) {
            this.#buffer += decoder.decode(chunk, { stream: true });

            let cut = this.#buffer.indexOf("\n");

            while (cut >= 0) {
                const line = this.#buffer.slice(0, cut);

                this.#buffer = this.#buffer.slice(cut + 1);
                if (line.trim() !== "") this.events.push(JSON.parse(line) as Event);
                cut = this.#buffer.indexOf("\n");
            }
        }
    }

    send(message: Record<string, unknown>): void {
        this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
        this.#proc.stdin.flush();
    }

    /** Starts the screen, and feeds text the way that a terminal's program prints it. */
    feed(text: string): void {
        this.send({ op: "feed", data: Buffer.from(text, "utf8").toString("base64") });
    }

    async wait<T extends Event>(kind: string, matches: (event: T) => boolean = () => true, timeoutMs = 10_000): Promise<T> {
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const found = this.events.find((each) => each.t === kind && matches(each as T));

            if (found !== undefined) return found as T;

            if (Date.now() > deadline) throw new Error(`No ${kind} in ${timeoutMs} ms: ${JSON.stringify(this.events.slice(-3))}`);

            await Bun.sleep(10);
        }
    }

    /** The last frame, once the screen has drawn everything that was fed. */
    async lastFrame(): Promise<Frame> {
        await Bun.sleep(120);

        const frames = this.events.filter((each) => each.t === "frame") as Frame[];

        return frames.at(-1)!;
    }

    stop(): void {
        this.#proc.kill();
    }
}

const made: Runner[] = [];

function runnerWith(cols = 40, rows = 8): Runner {
    const made_ = new Runner();

    made.push(made_);
    made_.send({ op: "start", cols, rows });

    return made_;
}

import { afterEach } from "bun:test";

afterEach(() => {
    for (const each of made.splice(0)) each.stop();
});

describe("the screen that the module starts", () => {
    test("says that it is ready before it draws anything", async () => {
        const screen = runnerWith();

        expect(await screen.wait("ready")).toMatchObject({ t: "ready" });
    });

    test("draws what the stream prints", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.feed("hello from rex\r\nsecond line\r\n");

        const frame = await screen.lastFrame();

        expect(frame.cols).toBe(40);
        expect(frame.rows).toBe(8);
        expect(textOf(frame)).toBe("hello from rex\nsecond line");
    });

    test("seeds a screen that is already running, and then draws what comes after it", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        // What `com.superlogical.terminal.format` gives for a terminal that is mid-session.
        screen.send({ op: "seed", text: "\u001b[2J\u001b[Hnnutter@frame:/tmp$ echo old\r\nold\r\nnnutter@frame:/tmp$ " });
        screen.feed("echo new\r\nnew\r\n");

        const frame = await screen.lastFrame();
        const text = textOf(frame);

        expect(text).toContain("echo old");
        expect(text).toContain("old");
        expect(text).toContain("new");
    });

    test("keeps the color that the stream asks for", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.feed("\u001b[31mred\u001b[0m plain\r\n");

        const frame = await screen.lastFrame();
        const runs = frame.lines.flatMap((line) => line.runs);
        const red = runs.find((run) => run[0] === "red");

        expect(red).toBeDefined();
        expect(red![1]).toMatch(/^#[0-9a-f]{6}$/);
        // The run after it is the terminal's own color again.
        expect(runs.find((run) => run[0] === " plain")![1]).toBe("");
    });

    test("resizes to the columns and rows that the page asks for", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.feed("a line that is longer than twenty columns\r\n");
        await screen.lastFrame();

        screen.send({ op: "resize", cols: 20, rows: 4 });

        const frame = await screen.wait<Frame>("frame", (each) => each.cols === 20 && each.rows === 4 && each.full);

        expect(frame.cols).toBe(20);
        expect(frame.rows).toBe(4);
    });

    test("keeps the scrollback that a full screen pushes off, and scrolls to it", async () => {
        const screen = runnerWith(20, 3);

        await screen.wait("ready");

        for (let index = 0; index < 8; index += 1) screen.feed(`line ${index}\r\n`);

        const drawn = await screen.lastFrame();

        expect(drawn.scroll.scrollback).toBeGreaterThan(0);

        screen.send({ op: "scroll", to: "top" });

        const top = await screen.wait<Frame>("frame", (each) => each.full && textOf(each).includes("line 0"));

        expect(textOf(top)).toContain("line 0");
    });

    test("answers nothing itself, because the program talks to Rex's terminal and not to this one", async () => {
        const screen = runnerWith();

        await screen.wait("ready");

        // The two questions that a line editor asks on every redraw: where the cursor is, and what the terminal is.
        screen.feed("\u001b[6n\u001b[c");
        await Bun.sleep(200);

        // An answer from here would reach the program a second time, as text at its prompt: `^[[21;1R`.
        expect(screen.events.filter((each) => each.t === "write")).toEqual([]);
    });

    test("says when a program copies to the clipboard", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.feed("\u001b]52;c;SGVsbG8=\u0007");

        expect(await screen.wait("clipboard")).toMatchObject({ selection: "c", text: "Hello" });
    });

    test("says when a program asks what the clipboard holds", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.feed("\u001b]52;c;?\u0007");

        expect(await screen.wait("clipboard-query")).toMatchObject({ selection: "c", text: null });
    });

    test("ends when the module says so, and says how", async () => {
        const screen = runnerWith();

        await screen.wait("ready");
        screen.send({ op: "kill" });

        expect(await screen.wait("exit")).toMatchObject({ code: null, signal: null });
    });

    test("refuses an operation that came before the screen", async () => {
        const screen = new Runner();

        made.push(screen);
        screen.feed("hello");

        expect(await screen.wait("error")).toMatchObject({ t: "error" });
    });
});
