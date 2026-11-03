/**
 * The Rex runner: one process, one libghostty-vt screen, and the bytes of a Rex terminal's stream.
 *
 * This is the pty host's other half. Where that one gives the screen a pty and reads it, this one is given bytes by the
 * module, because they come from a Rex server's data connection instead. Everything after the bytes -- the runs, the
 * cursor, the frames -- is `screen.ts`, which both hosts share.
 *
 * The protocol is JSON lines, as the pty host's is: commands on stdin, frames on stdout.
 *
 *     printf '%s\n' '{"op":"start","cols":80,"rows":24}' \
 *                   '{"op":"seed","text":"hello\r\n"}' '' | bun src/rex-host.ts
 */
import { Screen } from "./screen.ts";

function write(message: unknown): void {
    Bun.stdout.write(`${JSON.stringify(message)}\n`);
}

let screen: Screen | null = null;

function bytes(data: unknown): Uint8Array {
    return new Uint8Array(Buffer.from(String(data ?? ""), "base64"));
}

function handle(message: Record<string, unknown>): void {
    const op = message.op;

    if (op === "start") {
        if (screen !== null) {
            write({ t: "error", message: "This runner already has a screen." });
            return;
        }

        screen = new Screen({
            cols: Number(message.cols ?? 80),
            rows: Number(message.rows ?? 24),
            maxScrollback: Number(message.maxScrollback ?? 5000),
            onFrame: (frame) => write({ t: "frame", ...frame }),
            // What the terminal itself answers a program: a device-attributes reply, a cursor-position report. A pty
            // host would write it to the pty; this one hands it to the module, which types it into the Rex terminal.
            onWritePty: (answer) => write({ t: "write", data: Buffer.from(answer).toString("base64") }),
            onBell: () => write({ t: "bell" }),
            onClipboard: (selection, text) => {
                write({ t: text === null ? "clipboard-query" : "clipboard", selection, text });
            },
        });

        write({ t: "ready" });

        return;
    }

    if (screen === null) {
        write({ t: "error", message: `No screen yet: ${String(op)} came first.` });
        return;
    }

    switch (op) {
        case "seed":
            // The screen before the stream: the escape sequences that redraw a terminal that is already running.
            screen.write(new TextEncoder().encode(String(message.text ?? "")));
            break;
        case "feed":
            screen.write(bytes(message.data));
            break;
        case "resize":
            screen.resize(Number(message.cols), Number(message.rows));
            break;
        case "scroll":
            screen.scroll(message.to as "top" | "bottom" | number);
            break;
        case "flush":
            screen.flush();
            break;
        case "kill":
            screen.close();
            write({ t: "exit", code: null, signal: null });
            setTimeout(() => process.exit(0), 50);
            break;
        case "ping":
            write({ t: "pong" });
            break;
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
