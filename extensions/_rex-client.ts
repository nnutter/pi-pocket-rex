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

/** One block of a window, as `session.view` reports it. Only `block_id` is promised. */
export interface RexBlock {
    block_id?: string | null;
    creator_name?: string;
    flavor?: string;
    label?: string;
}

/** One window of a session, with the layers that hold its blocks, as `session.view` reports it. */
export interface RexWindow {
    window_id: string;
    label?: string;
    focused_block_id?: string | null;
    layers?: Array<{ blocks?: RexBlock[] | null }> | null;
}

/** One session's windows and their blocks, as `session.view` reports them. */
export interface RexView {
    session_id?: string | null;
    label?: string;
    revision?: number;
    active_window_id?: string | null;
    windows?: RexWindow[] | null;
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

/**
 * A WebSocket to one endpoint, or the reason that it would not open.
 *
 * `listen` is called with the socket before it opens, because a server sends its first message as soon as it accepts:
 * a listener that is added after the open event is a listener that can miss the welcome that came with it.
 */
async function open(
    endpoint: Endpoint,
    path: string,
    protocols: string[],
    timeoutMs: number,
    listen?: (socket: WebSocket) => void,
): Promise<WebSocket> {
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

        listen?.(socket);

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

    /** The endpoint that answered, for the other connections that this server wants, such as a terminal's data. */
    get location(): Endpoint | null {
        return this.#connected;
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

        // A server that accepts a connection and then says nothing would cost a person their machine for a reason that
        // has nothing to do with the machine, so every endpoint is tried again once before the failure is theirs.
        for (let pass = 0; pass < 2; pass += 1) {
            for (const candidate of candidates) {
                try {
                    this.#socket = await open(
                        candidate,
                        "/api/control",
                        [CONTROL_PROTOCOL],
                        Math.min(OPEN_TIMEOUT_MS, this.#timeoutMs),
                        (socket) => {
                            socket.addEventListener("message", (message) => this.#receive(message));
                            socket.addEventListener("close", (close) => this.#drop(`closed: ${close.reason || "no reason"}`));
                        },
                    );
                    this.#connected = candidate;

                    return await this.#hello();
                } catch (error) {
                    last = error as Error;
                    this.#abandon();
                }
            }
        }

        throw last ?? new RexCallError("unreachable", "No endpoint answered", 502);
    }

    /** Sends the hello, and waits for the welcome that answers it. */
    #hello(): Promise<RexWelcome> {
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

    /** Drops a connection that this client is giving up on, without telling the module that the host is gone. */
    #abandon(): void {
        const socket = this.#socket;

        this.#socket = null;
        this.#welcome = null;
        this.#onWelcome = null;

        if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.close();
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

    /** The session's windows and the blocks in them, in one snapshot. */
    async view(sessionId: string): Promise<RexView> {
        return await this.call<RexView>("session.view", { session_id: sessionId });
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

/**
 * The terminal's stream with the parts that a screen cannot take taken out of it.
 *
 * A stream begins with the terminal's whole state in Ghostty's snapshot format, which is not escape sequences. Rex also
 * puts messages of its own into the stream, where they are safe to apply: an APC that carries the connection's nonce,
 * a resize or a theme. Neither belongs on the screen -- the module paints the screen with
 * `com.superlogical.terminal.format`, and it reads the size from the terminal itself -- so both are dropped, and what a
 * program actually printed goes through.
 *
 * The nonce is what makes this safe: a program that prints the same bytes is printing a look-alike, and it stays.
 */
export class RexMessageFilter {
    readonly #marker: Buffer;
    readonly #terminator = Buffer.from("\u001b\\", "latin1");
    #pending = Buffer.alloc(0);
    /** Where the filter is: in the snapshot, inside one of Rex's messages, or in what a program printed. */
    #state: "snapshot" | "message" | "stream";

    /** `started` is for a stream that is being resumed: its snapshot went when the stream began. */
    constructor(nonce: bigint, started = false) {
        this.#marker = Buffer.from(`\u001b_rex1;${nonce};`, "latin1");
        this.#state = started ? "stream" : "snapshot";
    }

    /** The bytes that a screen can take, or null while there are none yet. */
    push(bytes: Uint8Array): Uint8Array | null {
        this.#pending = Buffer.concat([this.#pending, Buffer.from(bytes)]);

        const out: Buffer[] = [];

        for (;;) {
            if (this.#state === "snapshot") {
                const at = this.#pending.indexOf(this.#marker);

                if (at < 0) {
                    // Everything so far is the snapshot, and the snapshot is not for a screen. Keep only what could be
                    // the start of the marker, so that one that splits across two arrivals is still found.
                    const keep = prefixTail(this.#pending, this.#marker);

                    this.#pending = this.#pending.subarray(this.#pending.length - keep);

                    break;
                }

                this.#pending = this.#pending.subarray(at + this.#marker.length);
                this.#state = "message";

                continue;
            }

            if (this.#state === "message") {
                const end = this.#pending.indexOf(this.#terminator);

                // A message that has not finished arriving is not one to end early.
                if (end < 0) break;

                this.#pending = this.#pending.subarray(end + this.#terminator.length);
                this.#state = "stream";

                continue;
            }

            const at = this.#pending.indexOf(this.#marker);

            if (at < 0) {
                // A marker can split across two arrivals, so the bytes that could still become one wait for the next
                // arrival. Only those wait: a prompt that a program printed must not sit in a buffer until it prints
                // more.
                const cut = this.#pending.length - prefixTail(this.#pending, this.#marker);

                if (cut > 0) {
                    out.push(this.#pending.subarray(0, cut));
                    this.#pending = this.#pending.subarray(cut);
                }

                break;
            }

            if (at > 0) {
                out.push(this.#pending.subarray(0, at));
                this.#pending = this.#pending.subarray(at);
            }

            this.#pending = this.#pending.subarray(at + this.#marker.length);
            this.#state = "message";
        }

        if (out.length === 0) return null;

        return new Uint8Array(Buffer.concat(out));
    }
}

/** The stream's welcome: what a resume needs, and the nonce that marks Rex's own messages in it. */
export interface RexStreamWelcome {
    token: Uint8Array;
    keepMs: number;
    nonce: bigint;
}

/** One data connection's messages, as the module watches it. */
export interface RexStreamOptions {
    client: RexClient;
    sessionId: string;
    blockId: string;
    /** The stream's bytes, after the handshake. They arrive in order, and mean nothing apart from one another. */
    onData(bytes: Uint8Array): void;
    /** The stream ended, and could not be resumed. */
    onEnd(reason: string): void;
}

/** How long to wait before a resume, so that a compute that dropped is not hammered. */
const RESUME_DELAY_MS = 250;

/**
 * One terminal's bytes, from a Rex server: the ticket, the handshake, the stream, and the resume when the network blinks.
 *
 * A stream outlives its connection. When one drops, the server keeps the terminal's output for a minute; a resume says
 * how many bytes arrived, and the server sends the rest. That is what keeps a phone that lost its signal from losing the
 * screen that it was drawing.
 */
export class RexStream {
    readonly #options: RexStreamOptions;
    #socket: WebSocket | null = null;
    #welcome: RexStreamWelcome | null = null;
    #received = 0;
    #closed = false;
    #ended = false;
    #resumeTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(options: RexStreamOptions) {
        this.#options = options;
    }

    /** Asks for a ticket, opens the data connection, and hands the first bytes to `onData`. */
    static async open(options: RexStreamOptions): Promise<RexStream> {
        const stream = new RexStream(options);
        const ticket = await options.client.call<{ ticket: string }>("data.connect", {
            session_id: options.sessionId,
            block_id: options.blockId,
            data_ref_id: "terminal",
            subprotocol: TERMINAL_PROTOCOL,
        });

        await stream.#handshake(ticket.ticket, false);

        return stream;
    }

    /** How many bytes of the stream have arrived, which is what a resume reports. */
    get received(): number {
        return this.#received;
    }

    get welcome(): RexStreamWelcome | null {
        return this.#welcome;
    }

    /** Ends the stream for good. A stream that is only dropped is resumed. */
    close(): void {
        this.#closed = true;

        if (this.#resumeTimer !== null) clearTimeout(this.#resumeTimer);

        const socket = this.#socket;
        this.#socket = null;

        // A clean close tells the server to end the stream rather than keep it for a resume.
        if (socket !== null && socket.readyState === WebSocket.OPEN) socket.close(1000, "bye");
    }

    async #handshake(ticket: string, resume: boolean): Promise<void> {
        const client = this.#options.client;
        const location = client.location;

        if (location === null) throw new RexCallError("conflict", "The control connection has no endpoint", 409);

        // The listeners go on before the socket opens: the server answers the handshake immediately, and a message that
        // arrives before a listener is a message that is lost.
        const welcome = new Promise<RexStreamWelcome>((resolve, reject) => {
            const timer = setTimeout(() => reject(new RexCallError("timeout", "The stream sent no welcome", 504)), 10_000);
            // A resume arrives on a stream whose welcome is already known, so the handshake has its own place to stand.
            let handshaking = !resume;

            const done = (error: Error | null, value?: RexStreamWelcome): void => {
                clearTimeout(timer);

                if (error === null && value !== undefined) resolve(value);
                else reject(error);
            };

            void open(location, "/api/data", [TERMINAL_PROTOCOL], 10_000, (socket) => {
                socket.addEventListener("message", (message) => {
                    if (typeof message.data === "string") return;

                    // The first message is the handshake's answer, and everything after it is the stream.
                    if (handshaking) {
                        handshaking = false;

                        let answer: ReturnType<typeof readHandshake>;

                        try {
                            answer = readHandshake(new Uint8Array(message.data as ArrayBuffer));
                        } catch (error) {
                            done(error as Error);

                            return;
                        }

                        if (answer.type === "reject") {
                            done(new RexCallError("refused", `The server refused the stream: reason ${answer.reason}`, 403));

                            return;
                        }

                        this.#welcome = answer;
                        done(null, answer);

                        return;
                    }

                    const bytes = new Uint8Array(message.data as ArrayBuffer);

                    this.#received += bytes.length;
                    this.#options.onData(bytes);
                });

                socket.addEventListener("close", (close) => {
                    if (handshaking) {
                        done(new RexCallError("unavailable", `The stream closed during the handshake: ${close.reason}`, 503));

                        return;
                    }

                    this.#dropped(close.code, close.reason);
                });

                socket.addEventListener("error", () => {
                    if (handshaking) done(new RexCallError("unreachable", "The data connection failed", 502));
                });
            })
                .then((socket) => {
                    this.#socket = socket;

                    // The handshake goes as soon as the socket opens: the server waits for it, and knows the stream by it.
                    socket.send(resume ? frame(0x02, this.#resumeBody()) : frame(0x01, Buffer.from(ticket, "base64url")));
                })
                .catch((error: Error) => done(error));
        });

        await welcome;
    }

    #resumeBody(): Buffer {
        const body = Buffer.alloc(24);

        body.set(this.#welcome?.token ?? Buffer.alloc(16), 0);
        body.writeBigUInt64LE(BigInt(this.#received), 16);

        return body;
    }

    /** A connection that dropped: keep the stream, and resume it while the server still holds it. */
    #dropped(code: number, reason: string): void {
        this.#socket = null;

        if (this.#closed || this.#ended) return;

        // A stream that the block itself ended is not one to resume.
        if (code === 1000 || code === 4000 || this.#welcome === null) {
            this.#ended = true;
            this.#options.onEnd(reason || "the stream ended");

            return;
        }

        this.#resumeTimer = setTimeout(() => {
            this.#resumeTimer = null;

            if (this.#closed) return;

            this.#handshake("", true).catch(() => {
                if (this.#ended || this.#closed) return;

                this.#ended = true;
                this.#options.onEnd(`could not resume: ${reason}`);
            });
        }, RESUME_DELAY_MS);
    }
}

/** How many bytes at the end of `buffer` could be the start of `marker`. */
function prefixTail(buffer: Buffer, marker: Buffer): number {
    const most = Math.min(buffer.length, marker.length - 1);

    for (let length = most; length > 0; length -= 1) {
        if (buffer.subarray(buffer.length - length).equals(marker.subarray(0, length))) return length;
    }

    return 0;
}

/** One handshake message: a tag and its body. */
function frame(tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(1 + body.length);

    out[0] = tag;
    out.set(body, 1);

    return out;
}

/** What the server answers a handshake with: a welcome that a resume needs, or a refusal with its reason. */
function readHandshake(bytes: Uint8Array): (RexStreamWelcome & { type: "welcome" }) | { type: "reject"; reason: number } {
    if (bytes[0] === 0x82) return { type: "reject", reason: bytes[1] ?? 0 };

    if (bytes[0] !== 0x81 || bytes.length < 32) throw new RexCallError("internal", "A handshake message that is not one", 502);

    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return {
        type: "welcome",
        token: new Uint8Array(view.subarray(1, 17)),
        keepMs: view.readUInt32LE(20),
        nonce: view.readBigUInt64LE(24),
    };
}
