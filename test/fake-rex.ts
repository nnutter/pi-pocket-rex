/**
 * A Rex server for a test: the control connection, the welcome, the hello, and the methods that these tests use. It is a
 * `Bun.serve` WebSocket on the loopback, so a test needs no Rex and no network beyond this machine.
 */
import { RexCallError } from "../extensions/_rex-client.ts";

export interface FakeSession {
    session_id: string;
    label?: string;
}

export interface FakeHost {
    id: string;
    label: string;
    icon?: string;
    endpoints?: string[];
}

export interface FakeRex {
    url: string;
    hellos: Array<Record<string, unknown>>;
    requests: Array<{ method: string; payload: unknown }>;
    sockets: Set<unknown>;
    /** The bytes that each data connection sent: a hello, or a resume. */
    dataMessages: Uint8Array[];
    /** Sends bytes to every open data connection, as a terminal's program would. */
    push: (bytes: Uint8Array) => void;
    /** Closes every data connection, as a network that dropped would. */
    drop: () => void;
    stop: () => void;
}

export interface FakeRexOptions {
    /** Whether to send a welcome. A server that sends none is one that never finishes a connection. */
    welcome?: boolean;
    sessions?: FakeSession[];
    hosts?: FakeHost[];
    /** The blocks that `session.list_blocks` reports. */
    blocks?: Array<{ block_id: string; creator_name?: string; label?: string }>;
    /** What `com.superlogical.terminal.format` paints: the screen that a terminal opens on. */
    screen?: string;
    /** Answers one method instead of the defaults, and may throw a `RexCallError` to fail the call. */
    answer?: (method: string, payload: unknown) => unknown;
    /** Serves a terminal's data connection too, with this nonce and keep time. */
    data?: { nonce?: bigint; keepMs?: number; reject?: number };
}

export function fakeRex(options: FakeRexOptions = {}): FakeRex {
    const hellos: Array<Record<string, unknown>> = [];
    const requests: Array<{ method: string; payload: unknown }> = [];
    const sockets = new Set<unknown>();
    const dataSockets = new Set<unknown>();
    const dataMessages: Uint8Array[] = [];
    const welcome = options.welcome ?? true;

    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request, self) {
            const isData = new URL(request.url).pathname === "/api/data";
            const protocol = isData ? "rex.data.terminal.v1" : "rex.control.v1";

            if (!self.upgrade(request, { data: { data: isData }, headers: { "Sec-WebSocket-Protocol": protocol } } as never)) {
                return new Response("upgrade only", { status: 426 });
            }

            return undefined;
        },
        websocket: {
            open(socket: unknown) {
                const isData = (socket as { data?: { data?: boolean } }).data?.data === true;

                if (isData) {
                    dataSockets.add(socket);

                    return;
                }

                sockets.add(socket);

                if (welcome) {
                    (socket as { send: (value: string) => void }).send(
                        JSON.stringify({
                            type: "welcome",
                            protocol: "rex.control.v1",
                            limits: { max_message_bytes: 1048576 },
                            client: { id: "client:test", reconnect_token: "token" },
                            api_revision: 7,
                            api_server_revision: 10,
                        }),
                    );
                }
            },
            message(socket: unknown, data: unknown) {
                const isData = (socket as { data?: { data?: boolean } }).data?.data === true;

                if (isData) {
                    const bytes = new Uint8Array(data as ArrayBuffer);
                    const tag = bytes[0];

                    dataMessages.push(bytes);

                    if (tag !== 0x01 && tag !== 0x02) return;

                    if (options.data?.reject !== undefined) {
                        const reject = new Uint8Array([0x82, options.data.reject]);

                        (socket as { send: (value: Uint8Array) => void }).send(reject);

                        return;
                    }

                    (socket as { send: (value: Uint8Array) => void }).send(welcomeBytes(options.data?.nonce ?? 7n, options.data?.keepMs ?? 60_000));

                    return;
                }

                const body = JSON.parse(String(data)) as Record<string, unknown>;

                if (body.type === "hello") {
                    hellos.push(body);

                    return;
                }

                if (body.type !== "request") return;

                const method = String(body.method);
                const payload = body.payload ?? {};

                requests.push({ method, payload });

                try {
                    (socket as { send: (value: string) => void }).send(
                        JSON.stringify({ type: "response", id: body.id, seq: 0, payload: resolve(method, payload) }),
                    );
                } catch (error) {
                    const thrown = error as RexCallError;

                    (socket as { send: (value: string) => void }).send(
                        JSON.stringify({
                            type: "response",
                            id: body.id,
                            seq: 0,
                            error: { code: thrown.code, message: thrown.message, status: thrown.status },
                        }),
                    );
                }
            },
            close(socket: unknown) {
                sockets.delete(socket);
                dataSockets.delete(socket);
            },
        },
    });

    /** The 32 bytes of a welcome: the tag, the reconnect token, three zero bytes, the keep time, and the nonce. */
    function welcomeBytes(nonce: bigint, keepMs: number): Uint8Array {
        const bytes = new Uint8Array(32);
        const view = Buffer.from(bytes.buffer);

        bytes[0] = 0x81;
        view.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 1);
        view.writeUInt32LE(keepMs, 20);
        view.writeBigUInt64LE(nonce, 24);

        return bytes;
    }

    function resolve(method: string, payload: unknown): unknown {
        if (options.answer !== undefined) return options.answer(method, payload);

        if (method === "session.list") return { sessions: options.sessions ?? [] };
        if (method === "hosts.list") return { hosts: options.hosts ?? [] };
        if (method === "data.connect") return { ticket: Buffer.alloc(16, 9).toString("base64url"), expires_in_ms: 60_000 };
        if (method === "session.list_blocks") return { blocks: options.blocks ?? [] };
        if (method === "session.new_window") return { window_id: "window:made", block_ids: ["block:made"], revision: 1 };
        if (method === "com.superlogical.terminal.format") return { content: options.screen ?? "" };
        if (method === "com.superlogical.terminal.write") return { bytes_written: String((payload as { args?: { data?: string } }).args?.data ?? "").length };

        return { ok: method };
    }

    return {
        url: `ws://127.0.0.1:${server.port}`,
        hellos,
        requests,
        sockets,
        dataMessages,
        push: (bytes) => {
            for (const socket of dataSockets) (socket as { send: (value: Uint8Array) => void }).send(bytes);
        },
        // 1001 is a connection that went away: not a stream that the block ended, which a resume must not restart.
        drop: () => {
            for (const socket of [...dataSockets]) (socket as { close: (code: number) => void }).close(1001);
        },
        stop: () => server.stop(true),
    };
}
