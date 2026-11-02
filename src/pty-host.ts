/**
 * The pty runner: one process, one pty, one libghostty-vt screen.
 *
 * Pi Pocket's server runs on Node, and `libghostty-vt` needs Bun's FFI. So the module spawns this file with Bun and
 * talks to it in JSON lines: commands on stdin, frames on stdout. See `extensions/rex.ts`, which owns it.
 *
 * Run by hand to try it:
 *
 *     printf '%s\n' '{"op":"spawn","argv":["bash","-l"],"cols":80,"rows":24}' '' | bun src/pty-host.ts
 */
import { Formatter, KeyEncoder, Terminal } from "libghostty-vt";
import { clipboardReply } from "./escapes.ts";
import { Screen } from "./screen.ts";
import type { KeyEvent } from "libghostty-vt";

function write(message: unknown): void {
    Bun.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The pty, the screen that reads it, and the frames that they make. */
class Session {
    readonly #screen: Screen;
    readonly #keys: KeyEncoder;
    readonly #proc: ReturnType<typeof Bun.spawn>;

    constructor(argv: string[], cwd: string, cols: number, rows: number, env: Record<string, string>) {
        this.#screen = new Screen({
            cols,
            rows,
            onFrame: (frame) => write({ t: "frame", ...frame }),
            onWritePty: (bytes) => {
                this.#proc.terminal?.write(bytes);
            },
            onBell: () => {
                write({ t: "bell" });
            },
            // The page reads the clipboard, and answers through the route: this only says that it was asked.
            onClipboard: (selection, text) => {
                write({
                    t: text === null ? "clipboard-query" : "clipboard",
                    selection,
                    text,
                });
            },
        });
        this.#keys = new KeyEncoder({ terminal: this.#screen.terminal });
        this.#proc = Bun.spawn(argv, {
            cwd,
            env,
            terminal: {
                cols,
                rows,
                data: (_terminal, data) => {
                    this.#screen.write(data);
                },
                exit: (_terminal, _code, signal) => {
                    this.#screen.close();

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
        const body = this.#screen.mode("bracketed_paste") ? `\u001b[200~${text}\u001b[201~` : text;

        this.#proc.terminal?.write(body);
    }

    /** Tells a program that watches for it whether this terminal has the person's attention. */
    focus(inside: boolean): void {
        if (!this.#screen.mode("focus_event")) return;

        this.#proc.terminal?.write(inside ? "\u001b[I" : "\u001b[O");
    }

    /** Answers a program that asked what the clipboard holds. */
    answer(selection: string, text: string): void {
        this.#proc.terminal?.write(clipboardReply(selection, text));
    }

    resize(cols: number, rows: number): void {
        this.#screen.resize(cols, rows);
        this.#proc.terminal?.resize(cols, rows);
    }

    scroll(to: "top" | "bottom" | number): void {
        this.#screen.scroll(to);
    }

    kill(): void {
        this.#screen.close();
        this.#proc.terminal?.close();
        this.#proc.kill();
    }

    get pid(): number {
        return this.#proc.pid;
    }

    get terminal(): Terminal {
        return this.#screen.terminal;
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
