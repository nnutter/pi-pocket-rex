/**
 * A Rex server for a test: the control connection, the welcome, the hello, and the methods that these tests use. It is a
 * `Bun.serve` WebSocket on the loopback, so a test needs no Rex and no network beyond this machine.
 */
import { RexCallError } from "../extensions/_rex-client.ts";

export interface FakeSession {
    session_id: string;
    label?: string;
}

/** A block of a window that this server made: the shell that a terminal opens on. */
export interface FakeBlock {
    block_id: string;
    creator_name: string;
    label: string;
}

/** A window of a session that this server made, with the blocks in it. */
export interface FakeWindow {
    window_id: string;
    label: string;
    blocks: FakeBlock[];
}

export interface FakeHost {
    id: string;
    label: string;
    icon?: string;
    endpoints?: string[];
}

export interface FakeRex {
    url: string;
    /** The sessions that this server has made, which `session.list` then reports. */
    made: FakeSession[];
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
    /** The blocks that `session.list_blocks` reports, for a session that this server did not make. */
    blocks?: Array<{ block_id: string; creator_name?: string; label?: string }>;
    /** The windows that a session already holds, by session: what a server looks like after a restart. */
    windows?: Record<string, FakeWindow[]>;
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
    const made: FakeSession[] = [];

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

    /** The blocks that closed, and the sessions that went: a list after them is a list without them. */
    const closed = new Set<string>();
    const gone = new Set<string>();

    /** The windows of each session that this server made, and the blocks in each of them. */
    const windows = new Map<string, FakeWindow[]>(
        Object.entries(options.windows ?? {}).map(([sessionId, kept]) => [sessionId, [...kept]] as const),
    );
    let counted = 0;

    /** A new block, with a name that no other block in this server has. */
    function newBlock(creator_name = "com.superlogical.terminal", label = ""): FakeBlock {
        counted += 1;

        return { block_id: `block:made-${counted}`, creator_name, label };
    }

    function newWindow(label: string, blocks: FakeBlock[]): FakeWindow {
        counted += 1;

        return { window_id: `window:made-${counted}`, label, blocks };
    }

    /** The sessions that the connection is attached to, which every method that takes one needs. */
    const attached = new Set<string>();

    /** The sessions that this server reports: the ones a test named, the ones it made, minus the ones that went. */
    const listed = (): FakeSession[] => [...(options.sessions ?? []), ...made].filter((each) => !gone.has(each.session_id));

    /** The session that a call names, as Rex treats it: it must be there, and the connection must be attached to it. */
    function attachedTo(payload: unknown): string {
        const sessionId = (payload as { session_id?: string }).session_id ?? "";

        if (!listed().some((each) => each.session_id === sessionId)) {
            throw new RexCallError("session_not_found", `No session ${sessionId}`, 404);
        }

        if (!attached.has(sessionId)) {
            throw new RexCallError("conflict", `stream is not attached to session ${sessionId}`, 409);
        }

        return sessionId;
    }

    function resolve(method: string, payload: unknown): unknown {
        if (options.answer !== undefined) return options.answer(method, payload);

        if (method === "session.list") return { sessions: listed() };
        if (method === "session.attach") {
            const sessionId = (payload as { session_id?: string }).session_id ?? "";

            if (!listed().some((each) => each.session_id === sessionId)) {
                throw new RexCallError("session_not_found", `No session ${sessionId}`, 404);
            }

            attached.add(sessionId);

            return { client_id: "client:fake", seq: 0 };
        }
        if (method === "session.detach") {
            attached.delete((payload as { session_id?: string }).session_id ?? "");

            return {};
        }
        if (method === "block.close") {
            const asked = payload as { block_id?: string };

            closed.add(asked.block_id ?? "");

            return { block_id: asked.block_id, revision: 1 };
        }
        if (method === "session.destroy") {
            const sessionId = attachedTo(payload);

            attached.delete(sessionId);
            gone.add(sessionId);

            return {};
        }
        if (method === "session.create") {
            const asked = payload as {
                label?: string;
                initial_windows?: Array<{ label?: string; window_label?: string; layout?: { block?: { label?: string } } }> | null;
            };
            const created: FakeSession = { session_id: `session:made-${made.length + 1}`, label: asked.label ?? "made" };

            made.push(created);

            const opened = (asked.initial_windows ?? []).map((each) =>
                newWindow(each.window_label ?? each.label ?? "", [newBlock("com.superlogical.terminal", each.layout?.block?.label ?? "")]),
            );

            windows.set(created.session_id, opened);

            return {
                session_id: created.session_id,
                initial_windows:
                    opened.length === 0
                        ? null
                        : opened.map((each) => ({ window_id: each.window_id, block_ids: each.blocks.map((block) => block.block_id), revision: 1 })),
            };
        }
        if (method === "session.new_window") {
            const asked = payload as {
                session_id?: string;
                window_label?: string;
                layout?: { block?: { label?: string; options?: { cwd?: string } } };
            };
            const sessionId = attachedTo(payload);
            const opened = newWindow(asked.window_label ?? "", [newBlock("com.superlogical.terminal", asked.layout?.block?.label ?? "")]);

            windows.set(sessionId, [...(windows.get(sessionId) ?? []), opened]);

            return { window_id: opened.window_id, block_ids: opened.blocks.map((block) => block.block_id), revision: 1 };
        }
        if (method === "session.set_window_label") {
            const asked = payload as { session_id?: string; window_id?: string; label?: string };
            const window = (windows.get(attachedTo(payload)) ?? []).find((each) => each.window_id === asked.window_id);

            if (window === undefined) throw new RexCallError("window_not_found", `No window ${asked.window_id}`, 404);

            window.label = asked.label ?? "";

            return {};
        }
        if (method === "session.close_window") {
            const asked = payload as { session_id?: string; window_id?: string };
            const sessionId = attachedTo(payload);
            const kept = windows.get(sessionId) ?? [];
            const window = kept.find((each) => each.window_id === asked.window_id);

            if (window === undefined) throw new RexCallError("window_not_found", `No window ${asked.window_id}`, 404);

            for (const block of window.blocks) closed.add(block.block_id);

            windows.set(
                sessionId,
                kept.filter((each) => each !== window),
            );

            return {};
        }
        if (method === "session.view") {
            const sessionId = attachedTo(payload);
            // A block that closed leaves its window, and a window that lost its last block goes, as Rex does it.
            const kept = (windows.get(sessionId) ?? [])
                .map((each) => ({ ...each, blocks: each.blocks.filter((block) => !closed.has(block.block_id)) }))
                .filter((each) => each.blocks.length > 0);
            const session = listed().find((each) => each.session_id === sessionId);

            return {
                session_id: sessionId,
                label: session?.label ?? "",
                revision: 1,
                active_window_id: kept[0]?.window_id ?? "",
                windows: kept.map((each) => ({
                    window_id: each.window_id,
                    label: each.label,
                    focused_block_id: each.blocks[0]?.block_id ?? "",
                    layers: [
                        {
                            blocks: each.blocks.map((block) => ({
                                block_id: block.block_id,
                                creator_name: block.creator_name,
                                flavor: `${block.creator_name}.shell`,
                                host_id: "host:1",
                                label: block.label,
                                owner: "me",
                            })),
                        },
                    ],
                })),
            };
        }
        if (method === "hosts.list") return { hosts: options.hosts ?? [] };
        if (method === "data.connect") return { ticket: Buffer.alloc(16, 9).toString("base64url"), expires_in_ms: 60_000 };
        if (method === "session.list_blocks") {
            const sessionId = attachedTo(payload);
            const kept = <T extends { block_id: string }>(blocks: T[]) => blocks.filter((each) => !closed.has(each.block_id));

            if (windows.has(sessionId)) {
                // The shells that this server made for the session, which the module then adopts.
                return { blocks: kept((windows.get(sessionId) ?? []).flatMap((each) => each.blocks)) };
            }

            return { blocks: kept(options.blocks ?? []) };
        }
        if (method === "com.superlogical.terminal.format") return { content: options.screen ?? "" };
        if (method === "com.superlogical.terminal.write") return { bytes_written: String((payload as { args?: { data?: string } }).args?.data ?? "").length };

        return { ok: method };
    }

    return {
        url: `ws://127.0.0.1:${server.port}`,
        made,
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
