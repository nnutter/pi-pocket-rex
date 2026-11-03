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
    stop: () => void;
}

export interface FakeRexOptions {
    /** Whether to send a welcome. A server that sends none is one that never finishes a connection. */
    welcome?: boolean;
    sessions?: FakeSession[];
    hosts?: FakeHost[];
    /** Answers one method instead of the defaults, and may throw a `RexCallError` to fail the call. */
    answer?: (method: string, payload: unknown) => unknown;
}

export function fakeRex(options: FakeRexOptions = {}): FakeRex {
    const hellos: Array<Record<string, unknown>> = [];
    const requests: Array<{ method: string; payload: unknown }> = [];
    const sockets = new Set<unknown>();
    const welcome = options.welcome ?? true;

    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request, self) {
            if (!self.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "rex.control.v1" } } as never)) {
                return new Response("upgrade only", { status: 426 });
            }

            return undefined;
        },
        websocket: {
            open(socket) {
                sockets.add(socket);

                if (welcome) {
                    socket.send(
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
            message(socket, data) {
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
                    socket.send(
                        JSON.stringify({ type: "response", id: body.id, seq: 0, payload: resolve(method, payload) }),
                    );
                } catch (error) {
                    const thrown = error as RexCallError;

                    socket.send(
                        JSON.stringify({
                            type: "response",
                            id: body.id,
                            seq: 0,
                            error: { code: thrown.code, message: thrown.message, status: thrown.status },
                        }),
                    );
                }
            },
            close(socket) {
                sockets.delete(socket);
            },
        },
    });

    function resolve(method: string, payload: unknown): unknown {
        if (options.answer !== undefined) return options.answer(method, payload);

        if (method === "session.list") return { sessions: options.sessions ?? [] };
        if (method === "hosts.list") return { hosts: options.hosts ?? [] };

        return { ok: method };
    }

    return {
        url: `ws://127.0.0.1:${server.port}`,
        hellos,
        requests,
        sockets,
        stop: () => server.stop(true),
    };
}
