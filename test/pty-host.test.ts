/**
 * The runner against a real pty, without the module: what a program asks of a terminal beyond its words -- the
 * clipboard, the cursor's shape, a bracketed paste, a focus change -- and the rule that the frames alone can rebuild the
 * screen that the engine holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "src", "pty-host.ts");

/** ESC, spelled out for the byte-level expectations below. */
const ESC = "\u001b";

interface Event {
    t: string;
    [key: string]: unknown;
}

/** A runner with a pty, and the messages that it sent. */
class Runner {
    readonly #proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
    readonly events: Event[] = [];
    #buffer = "";

    constructor() {
        this.#proc = Bun.spawn(["bun", "run", runner], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
            env: { ...process.env, TERM: "xterm-256color" },
        });

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

    spawn(argv: string[], cols = 40, rows = 8): void {
        this.send({ op: "spawn", argv, cwd: process.cwd(), cols, rows, env: { ...process.env, TERM: "xterm-256color" } });
    }

    /** Waits for a message of a kind, and gives it back. */
    async wait<T extends Event>(kind: string, matches: (event: T) => boolean = () => true, timeoutMs = 10_000): Promise<T> {
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const found = this.events.find((each) => each.t === kind && matches(each as T));

            if (found !== undefined) return found as T;
            if (Date.now() > deadline) throw new Error(`No ${kind} in ${timeoutMs} ms`);
            await Bun.sleep(20);
        }
    }

    /** Waits for the first whole frame, so that the pty has started. */
    async started(): Promise<void> {
        await this.wait("frame", (event) => (event as unknown as { full: boolean }).full);
        await Bun.sleep(200);
    }

    /** Asks the runner what its engine holds, as words. */
    async screen(): Promise<string> {
        this.send({ op: "screen" });

        const answer = await this.wait<Event & { text: string }>("screen", (each) => each.text !== undefined);

        return answer.text;
    }

    /** The screen as the frames alone make it: what a page would be showing. */
    frames(): string {
        const rows = new Map<number, string>();

        for (const event of this.events) {
            if (event.t !== "frame") continue;

            const frame = event as unknown as {
                full: boolean;
                lines: Array<{ y: number; runs: Array<[string, ...unknown[]]> }>;
            };

            if (frame.full) rows.clear();

            for (const line of frame.lines) rows.set(line.y, line.runs.map((run) => run[0]).join(""));
        }

        return [...rows.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, text]) => text.replace(/\s+$/, ""))
            .join("\n")
            .replace(/\n+$/, "");
    }

    stop(): void {
        this.#proc.kill();
    }
}

/** A file for what a program is sent, so that a test can read the bytes that landed on the pty. */
function recordFile(): string {
    return join(process.env.TMPDIR ?? "/tmp", `rex-${Math.random().toString(36).slice(2)}.bin`);
}

/** Waits until a file has something in it, or gives up. */
async function readBytes(file: string, timeoutMs = 4000): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            const text = readFileSync(file, "latin1");

            if (text !== "") return text;
        } catch {
            // Not there yet.
        }

        if (Date.now() > deadline) return "";
        await Bun.sleep(25);
    }
}

/**
 * Runs a program that keeps the pty open, with everything that it is sent copied into a file: `stty raw -echo` so that
 * the bytes arrive at once, and no echo of them in the way.
 */
async function record(run: (host: Runner, file: string) => Promise<void>, before = ""): Promise<string> {
    const file = recordFile();
    const host = new Runner();

    try {
        host.spawn(["bash", "-c", `stty raw -echo; ${before}cat > ${file}; sleep 3`]);
        await host.started();
        await run(host, file);

        return await readBytes(file);
    } finally {
        host.stop();
        rmSync(file, { force: true });
    }
}

describe("the clipboard's OSC 52", () => {
    test("sends a program's copy to the module, with the text decoded", async () => {
        const host = new Runner();

        try {
            host.spawn(["bash", "-c", `printf '${ESC}]52;c;aGVsbG8=\\a'; sleep 2`]);

            expect(await host.wait<Event & { text: string; selection: string }>("clipboard")).toMatchObject({
                selection: "c",
                text: "hello",
            });
        } finally {
            host.stop();
        }
    });

    test("tells the module that a program asked what the clipboard holds", async () => {
        const host = new Runner();

        try {
            host.spawn(["bash", "-c", `printf '${ESC}]52;c;?\\a'; sleep 2`]);

            expect(await host.wait<Event & { selection: string }>("clipboard-query")).toMatchObject({ selection: "c" });
        } finally {
            host.stop();
        }
    });

    test("answers a program's question with the text, as it reads it back", async () => {
        const bytes = await record((host) => {
            host.send({ op: "clipboard", selection: "c", text: "hi" });

            return Promise.resolve();
        });

        expect(bytes).toBe(`${ESC}]52;c;aGk=${ESC}\\`);
    });
});

describe("the cursor's DECSCUSR", () => {
    test("a program's bar is the frame's bar, and its block is the frame's block", async () => {
        const host = new Runner();

        try {
            host.spawn(["bash", "-c", `sleep 0.1; printf '${ESC}[6 q'; sleep 0.4; printf '${ESC}[2 q'; sleep 2`]);

            const bar = await host.wait("frame", (event) => cursorShape(event) === "bar");

            await host.wait("frame", (event) => cursorShape(event) === "block" && event !== bar);

            expect(cursorShape(bar)).toBe("bar");
        } finally {
            host.stop();
        }
    });
});

describe("a paste and a focus change", () => {
    test("wraps a paste when the program asked for bracketed paste", async () => {
        const bytes = await record((host) => {
            host.send({ op: "paste", text: "abc" });

            return Promise.resolve();
        }, `printf '${ESC}[?2004h'; `);

        expect(bytes).toBe(`${ESC}[200~abc${ESC}[201~`);
    });

    test("sends no bracketed paste to a program that did not ask", async () => {
        const bytes = await record((host) => {
            host.send({ op: "paste", text: "abc" });

            return Promise.resolve();
        });

        expect(bytes).toBe("abc");
    });

    test("tells a program that watches for it when the terminal has the person's attention", async () => {
        const bytes = await record(async (host) => {
            host.send({ op: "focus", inside: true });
            await Bun.sleep(250);
            host.send({ op: "focus", inside: false });
            await Bun.sleep(250);
        }, `printf '${ESC}[?1004h'; `);

        expect(bytes).toBe(`${ESC}[I${ESC}[O`);
    });

    test("sends no focus change to a program that does not watch for it", async () => {
        const bytes = await record((host) => {
            host.send({ op: "focus", inside: true });

            return Promise.resolve();
        });

        expect(bytes).toBe("");
    });
});

describe("the frames make the engine's screen", () => {
    /**
     * A program that writes, goes to the alternate screen as an editor does, comes back, and writes again. The rows of
     * the screen that comes back are not all new, so only a whole frame can put a page right.
     */
    test("a program that goes to the other screen and comes back", async () => {
        const host = new Runner();

        try {
            host.spawn([
                "bash",
                "-c",
                [
                    "printf 'first\\nsecond\\nthird\\n'",
                    "sleep 0.2",
                    `printf '${ESC}[?1049h${ESC}[2J${ESC}[H'; printf 'editor line one\\neditor line two\\n'`,
                    "sleep 0.2",
                    `printf '${ESC}[?1049l'`,
                    "sleep 0.2",
                    "printf 'after the editor\\n'",
                    "sleep 3",
                ].join("; "),
            ]);

            await Bun.sleep(1200);

            expect(host.frames()).toBe((await host.screen()).replace(/\n+$/, ""));
        } finally {
            host.stop();
        }
    }, 20_000);

    test("a program that draws a whole screen, as an editor does", async () => {
        const host = new Runner();

        try {
            host.spawn([
                "bash",
                "-c",
                [
                    `printf '${ESC}[?1049h'`,
                    "for row in 1 2 3 4 5 6; do printf 'row %s of the editor\\n' $row; done",
                    `printf '${ESC}[3;5H'; printf 'moved'`,
                    "sleep 3",
                ].join("; "),
            ]);

            await Bun.sleep(1200);

            expect(host.frames()).toBe((await host.screen()).replace(/\n+$/, ""));
        } finally {
            host.stop();
        }
    }, 20_000);
});

/** The shape of a frame's cursor. */
function cursorShape(event: Event): string | undefined {
    return (event as unknown as { cursor?: { shape?: string } }).cursor?.shape;
}

describe("how a program ended", () => {
    /** The exit message that the runner sends when its program ends. */
    async function exitOf(command: string): Promise<{ code: number | null; signal: string | null }> {
        const host = new Runner();

        try {
            host.spawn(["bash", "-c", command]);

            const ended = await host.wait<Event & { code: number | null; signal: string | null }>("exit", () => true, 15_000);

            return { code: ended.code, signal: ended.signal };
        } finally {
            host.stop();
        }
    }

    // Bun's pty gives 1 for every program that it ends, so the runner asks the program instead.
    test("a program that ends well is a code of zero", async () => {
        expect(await exitOf("exit 0")).toEqual({ code: 0, signal: null });
    });

    test("a program that ends badly says with what", async () => {
        expect(await exitOf("exit 3")).toEqual({ code: 3, signal: null });
    });

    test("a program that a signal stops says with what", async () => {
        expect(await exitOf("kill -TERM $$")).toEqual({ code: 143, signal: "SIGTERM" });
    });

    test("a shell that a person leaves ends with the status of its last command", async () => {
        // None of these is a signal: the shell was left, and its status is its own. `exit` with no argument is what a
        // shell does at the end of its input, so `false` and then a Ctrl-D leaves a shell with 1.
        expect(await exitOf("true; exit")).toEqual({ code: 0, signal: null });
        expect(await exitOf("false; exit")).toEqual({ code: 1, signal: null });
    });
});
