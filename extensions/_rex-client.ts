/**
 * One connection to one Rex server: the control WebSocket, its hello, its requests, and the events that it pushes.
 *
 * The protocol is Rex's own, documented by the server at `GET /llms.txt` and `GET /api/help`. Two things about it shape
 * this file. A server answers a request with the id that the request gave it, so calls can be in flight together. And a
 * server can add to the protocol, so this file sends the oldest revision it knows (`API_REVISION`) and ignores what it
 * does not recognize.
 *
 * The server listens on a Unix socket on its own machine, or on the network when someone asks it to. A Unix socket needs
 * `undici`'s `Agent`, because the WebSocket in Node has no other way to reach one; a network endpoint needs nothing.
 */
import type { Agent } from "undici";

/** The newest revision of the control API that this file speaks. The oldest server it talks to speaks 7. */
export const API_REVISION = 7;

/** The subprotocol of the control connection. A server refuses a connection that does not ask for it. */
export const CONTROL_PROTOCOL = "rex.control.v1";

/** The subprotocol of a terminal's data connection. */
export const TERMINAL_PROTOCOL = "rex.data.terminal.v1";

/** How long a request waits for its answer before the call fails. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long an endpoint has to accept a WebSocket before the next candidate is tried. */
const OPEN_TIMEOUT_MS = 6_000;

/** A server's answer to a call that failed. `code` is what a caller branches on; the message is for people. */
export class RexCallError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = "RexCallError";
        this.code = code;
        this.status = status;
    }
}

/** What the server sends once, when the connection opens. */
export interface RexWelcome {
    protocol: string;
    limits?: { max_message_bytes?: number };
    client?: { id: string; reconnect_token?: string; resumed?: boolean };
    api_revision?: number;
    api_server_revision?: number;
    api_min_revision?: number;
}

/** An event, as the server pushes it: the outermost `type` says how it is wrapped. */
export interface RexEvent {
    type: string;
    payload?: unknown;
}

/** One session, as `session.list` reports it. Only `session_id` is promised. */
export interface RexSession {
    session_id: string;
    label?: string;
    [field: string]: unknown;
}

/** One entry of a server's host list, as `hosts.list` reports it. */
export interface RexHostEntry {
    id: string;
    label: string;
    icon?: string;
    endpoints?: string[];
}

/** A place that a server answers: a URL to open, and the socket to reach it through when it is a file. */
export interface Endpoint {
    /** The `ws://` or `wss://` base that paths are added to, such as `wss://host:7297`. */
    base: string;
    /** The Unix socket, for a server that listens on one. */
    socketPath?: string;
}

/** The port that a Rex server listens on when it is asked to serve a tailnet. */
const TAILNET_PORT = 7297;

/**
 * The places to try for one endpoint, in the order to try them.
 *
 * A person writes an endpoint the way `rex -S` takes one: a host, optionally with a scheme and a port, or the path of a
 * Unix socket. A bare host is tried as the CLI tries it, over HTTPS on 443, then HTTPS on 7297, then HTTP on 7297.
 */
export function endpointCandidates(text: string): Endpoint[] {
    const value = text.trim();

    if (value === "") return [];

    if (value.startsWith("unix://")) return [{ base: "ws://localhost", socketPath: value.slice("unix://".length) }];
    if (value.startsWith("/")) return [{ base: "ws://localhost", socketPath: value }];

    if (value.startsWith("ws://") || value.startsWith("wss://")) return [{ base: value.replace(/\/+$/, "") }];

    if (value.startsWith("http://") || value.startsWith("https://")) {
        const url = new URL(value);
        const scheme = url.protocol === "https:" ? "wss:" : "ws:";
        const base = `${scheme}//${url.host}`;

        // A port that a person wrote is the port to use: they know something that a guess would not.
        if (url.port !== "") return [{ base }];

        return [
            { base: `wss://${url.host}` },
            { base: `wss://${url.host}:${TAILNET_PORT}` },
            { base: `ws://${url.host}:${TAILNET_PORT}` },
        ];
    }

    const bare = value.replace(/\/+$/, "");

    if (bare.includes(":")) return [{ base: `wss://${bare}` }];

    return [
        { base: `wss://${bare}` },
        { base: `wss://${bare}:${TAILNET_PORT}` },
        { base: `ws://${bare}:${TAILNET_PORT}` },
    ];
}

/** The dispatcher that carries a WebSocket to a Unix socket, which Node's own WebSocket cannot do by itself. */
async function dispatcherFor(endpoint: Endpoint): Promise<Agent | undefined> {
    if (endpoint.socketPath === undefined) return undefined;

    const { Agent } = await import("undici");

    return new Agent({ connect: { socketPath: endpoint.socketPath } });
}

/** A WebSocket to one endpoint, or the reason that it would not open. */
async function open(endpoint: Endpoint, path: string, protocols: string[], timeoutMs: number): Promise<WebSocket> {
    const dispatcher = await dispatcherFor(endpoint);
    const url = `${endpoint.base}${path}`;

    return new Promise<WebSocket>((resolve, reject) => {
        // `Node`'s WebSocket takes either the list of protocols or an options object that also carries a dispatcher.
        const socket =
            dispatcher === undefined
                ? new WebSocket(url, protocols)
                : new WebSocket(url, { protocols, dispatcher } as unknown as string[]);

        const timer = setTimeout(() => {
            socket.close();

            reject(new RexCallError("timeout", `${url} did not open within ${timeoutMs} ms`, 504));
        }, timeoutMs);

        socket.binaryType = "arraybuffer";

        socket.addEventListener("open", () => {
            clearTimeout(timer);
            resolve(socket);
        });

        socket.addEventListener("error", (event) => {
            clearTimeout(timer);
            const message = (event as unknown as { message?: string }).message ?? "the connection failed";

            reject(new RexCallError("unreachable", `${url}: ${message}`, 502));
        });
    });
}

export interface RexClientOptions {
    /** The endpoint as a person writes it: a host, a URL, or the path of a Unix socket. */
    endpoint: string;
    /** What this client calls itself, for the list of clients that a person sees in Rex. */
    app?: { name: string; version: string };
    /** How long a request waits, in milliseconds. */
    timeoutMs?: number;
}

/** The events and the state of one connection, as the module watches it. */
export interface RexClientEvents {
    event?(event: RexEvent): void;
    close?(reason: string): void;
}

/** A connection to one Rex server. It is opened once, and every call and event goes over it. */
export class RexClient {
    readonly endpoint: string;

    #app: { name: string; version: string };
    #timeoutMs: number;
    #socket: WebSocket | null = null;
    #welcome: RexWelcome | null = null;
    #seq = 0;
    #waiting = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    #events: RexClientEvents = {};
    /** The endpoint that answered, when it was not the first one tried. */
    #connected: Endpoint | null = null;

    constructor(options: RexClientOptions) {
        this.endpoint = options.endpoint;
        this.#app = options.app ?? { name: "Pi Pocket", version: "1" };
        this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    get welcome(): RexWelcome | null {
        return this.#welcome;
    }

    /** The endpoint that answered, such as `wss://host:7297`. */
    get address(): string {
        return this.#connected?.base ?? endpointCandidates(this.endpoint)[0]?.base ?? this.endpoint;
    }

    get connected(): boolean {
        return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
    }

    on(events: RexClientEvents): void {
        this.#events = { ...this.#events, ...events };
    }

    /** Opens the first endpoint that answers, and sends the hello that starts the connection. */
    async connect(): Promise<RexWelcome> {
        if (this.#socket !== null) throw new RexCallError("conflict", "This client is already connected", 409);

        const candidates = endpointCandidates(this.endpoint);

        if (candidates.length === 0) throw new RexCallError("bad_request", "No endpoint to connect to", 400);

        let last: Error | null = null;

        for (const candidate of candidates) {
            try {
                this.#socket = await open(candidate, "/api/control", [CONTROL_PROTOCOL], Math.min(OPEN_TIMEOUT_MS, this.#timeoutMs));
                this.#connected = candidate;
                break;
            } catch (error) {
                last = error as Error;
            }
        }

        if (this.#socket === null) throw last ?? new RexCallError("unreachable", "No endpoint answered", 502);

        this.#socket.addEventListener("message", (message) => this.#receive(message));
        this.#socket.addEventListener("close", (close) => this.#drop(`closed: ${close.reason || "no reason"}`));

        const welcome = new Promise<RexWelcome>((resolve, reject) => {
            const timer = setTimeout(() => reject(new RexCallError("timeout", "The server sent no welcome", 504)), this.#timeoutMs);

            this.#onWelcome = (value) => {
                clearTimeout(timer);
                resolve(value);
            };
        });

        this.#send({
            type: "hello",
            api_revision: API_REVISION,
            api_min_revision: API_REVISION,
            client: { kind: "app", name: this.#app.name, version: this.#app.version },
        });

        return welcome;
    }

    #onWelcome: ((welcome: RexWelcome) => void) | null = null;

    /** Calls one method and gives back its result, or throws the error that the server sent. */
    call<T = unknown>(method: string, payload?: unknown): Promise<T> {
        if (this.#socket === null) return Promise.reject(new RexCallError("conflict", "This client is not connected", 409));

        const id = String(++this.#seq);

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#waiting.delete(id);
                reject(new RexCallError("timeout", `${method} did not answer within ${this.#timeoutMs} ms`, 504));
            }, this.#timeoutMs);

            this.#waiting.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value as T);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
                timer,
            });

            this.#send(payload === undefined ? { type: "request", id, method } : { type: "request", id, method, payload });
        });
    }

    /** The sessions on this server, in the order that it keeps them. */
    async sessions(): Promise<RexSession[]> {
        const result = await this.call<{ sessions?: RexSession[] | null }>("session.list");

        return result?.sessions ?? [];
    }

    /** The other servers that this one knows about, which is what its client shows above its sessions. */
    async hosts(): Promise<RexHostEntry[]> {
        const result = await this.call<{ hosts?: RexHostEntry[] | null }>("hosts.list");

        return result?.hosts ?? [];
    }

    /** Closes the connection. The server keeps every session that this client was only watching. */
    close(): void {
        const socket = this.#socket;
        this.#socket = null;

        if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "bye");

        this.#drop("closed by Pi Pocket");
    }

    #send(message: unknown): void {
        const socket = this.#socket;

        if (socket === null || socket.readyState !== WebSocket.OPEN) return;

        socket.send(JSON.stringify(message));
    }

    #receive(message: MessageEvent): void {
        if (typeof message.data !== "string") return;

        let body: Record<string, unknown>;

        try {
            body = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
            return;
        }

        const type = body.type;

        if (type === "welcome") {
            this.#welcome = body as unknown as RexWelcome;
            this.#onWelcome?.(this.#welcome);
            this.#onWelcome = null;

            return;
        }

        if (type === "response") {
            const waiting = this.#waiting.get(String(body.id));

            if (waiting === undefined) return;

            this.#waiting.delete(String(body.id));

            const error = body.error as { code?: string; message?: string; status?: number } | undefined;

            if (error !== undefined && error !== null) {
                waiting.reject(new RexCallError(error.code ?? "internal", error.message ?? "The call failed", error.status ?? 500));

                return;
            }

            waiting.resolve(body.payload);

            return;
        }

        if (type === "event") {
            // An event arrives in a wrapper, with the server's place for it; the module wants the event itself.
            const event = body.payload as RexEvent | undefined;

            if (event !== undefined && typeof event.type === "string") this.#events.event?.(event);
        }

        // Any other type is newer than this file: skip it, as the protocol says.
    }

    /** Ends every waiting call, and tells the module once, however the connection ended. */
    #drop(reason: string): void {
        const waiting = [...this.#waiting.values()];
        this.#waiting.clear();

        for (const entry of waiting) {
            clearTimeout(entry.timer);
            entry.reject(new RexCallError("unavailable", `The connection ended: ${reason}`, 503));
        }

        this.#events.close?.(reason);
        this.#events = {};
        this.#socket = null;
    }
}
