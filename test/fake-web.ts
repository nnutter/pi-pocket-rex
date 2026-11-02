/**
 * Enough of `Web` for a test: it keeps the routes and the browser module's registrations, and records what the module
 * sends to the tabs. The handlers a test calls are the module's own, with the person and sessions that it asks for.
 */
import type { Web } from "../src/_pocket.d.ts";

export interface Sent {
    event: string;
    data: unknown;
}

export interface Session {
    id: number;
    title: string;
    cwd: string;
    archived: boolean;
    updatedAt: number;
}

export interface Call {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: string;
    sessions?: Session[];
}

export interface FakeWeb {
    web: Web;
    /**
     * Enough of `Host` for a test: the events that the app sends (`host.on`), and `emit` to send one as the app does.
     */
    host: {
        on(event: string, listener: (data: never) => unknown): () => void;
    };
    /** Sends an app event to the module, as Pi Pocket does after the change is stored. */
    emit(event: string, data: unknown): void;
    /** The sessions that `sessions()` gives the module: a test changes it as the app would. */
    sessions: Session[];
    sent: Sent[];
    routes: string[];
    clients: string[];
    settings: unknown[];
    get disposed(): boolean;
    dispose(): Promise<void>;
    call<T = unknown>(call: Call): Promise<T>;
    /** Waits for an event that the module sends, such as a frame with a word in it. */
    waitFor<T = unknown>(event: string, matches?: (data: T) => boolean, timeoutMs?: number): Promise<T>;
}

const PERSON = { id: "person-1", name: "Test", role: "owner" };

export function fakeWeb(options: { settings?: Record<string, string | number | boolean>; sessions?: Session[] } = {}): FakeWeb {
    const handlers = new Map<string, (request: unknown) => unknown>();
    const sent: Sent[] = [];
    const routes: string[] = [];
    const clients: string[] = [];
    const settings: unknown[] = [];
    const dispose: Array<() => unknown> = [];
    const state: { disposed: boolean } = { disposed: false };
    const sessions: Session[] = [...(options.sessions ?? [])];
    const listeners = new Map<string, Set<(data: never) => unknown>>();
    const waiting: Array<{ event: string; matches?: (data: unknown) => boolean; resolve: (data: unknown) => void }> = [];

    const web = {
        api: 2,
        module: "rex",
        route(method: string, path: string, handle: (request: unknown) => unknown) {
            routes.push(`${method} ${path}`);
            handlers.set(`${method} ${path}`, handle);

            return {
                update() {},
                remove() {
                    handlers.delete(`${method} ${path}`);
                },
            };
        },
        client(entry: string) {
            clients.push(entry);
        },
        settings(fields: unknown[]) {
            settings.push(...fields);
        },
        setting(name: string) {
            return options.settings?.[name];
        },
        send(event: string, data: unknown) {
            sent.push({ event, data });

            for (const listener of [...waiting]) {
                if (listener.event !== event) continue;
                if (listener.matches !== undefined && !listener.matches(data)) continue;

                waiting.splice(waiting.indexOf(listener), 1);
                listener.resolve(data);
            }
        },
        error(status: number, message: string) {
            const error = new Error(message) as Error & { status: number };
            error.status = status;

            return error;
        },
        onDispose(run: () => unknown) {
            dispose.push(run);
        },
    } as unknown as Web;

    async function call<T>(request: Call): Promise<T> {
        const handler = handlers.get(`${request.method} ${request.path}`);

        if (handler === undefined) throw new Error(`No route ${request.method} ${request.path} in ${routes.join(", ")}`);

        return (await handler({
            method: request.method,
            params: request.params ?? {},
            query: new URLSearchParams(request.query ?? ""),
            body: request.body ?? {},
            user: PERSON,
            signal: new AbortController().signal,
            sessions: () => sessions,
        })) as T;
    }

    function waitFor<T>(event: string, matches?: (data: T) => boolean, timeoutMs = 10_000): Promise<T> {
        const already = sent.find((each) => each.event === event && (matches === undefined || matches(each.data as T)));

        if (already !== undefined) return Promise.resolve(already.data as T);

        return new Promise<T>((resolve, reject) => {
            const listener: (typeof waiting)[number] = {
                event,
                matches: matches as ((data: unknown) => boolean) | undefined,
                resolve: resolve as (data: unknown) => void,
            };

            waiting.push(listener);

            const timer = setTimeout(() => {
                const index = waiting.indexOf(listener);
                if (index >= 0) waiting.splice(index, 1);
                reject(new Error(`No ${event} in ${timeoutMs} ms`));
            }, timeoutMs);

            const done = listener.resolve;

            listener.resolve = (data: unknown) => {
                clearTimeout(timer);
                done(data);
            };
        });
    }

    const host = {
        on(event: string, listener: (data: never) => unknown) {
            const set = listeners.get(event) ?? new Set();

            set.add(listener);
            listeners.set(event, set);

            return () => set.delete(listener);
        },
    };

    function emit(event: string, data: unknown): void {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(data as never);
    }

    return {
        web,
        host,
        emit,
        sessions,
        sent,
        routes,
        clients,
        settings,
        get disposed() {
            return state.disposed;
        },
        async dispose() {
            state.disposed = true;
            for (const run of dispose.splice(0)) await run();
        },
        call,
        waitFor,
    };
}

/** A frame as the module sends it. */
export interface FrameEvent {
    id: string;
    frame: {
        seq: number;
        full: boolean;
        cols: number;
        rows: number;
        title: string;
        cursor: { x: number; y: number; visible: boolean };
        alt: boolean;
        scroll: { scrollback: number };
        lines: Array<{ y: number; runs: Array<[string, string, string, number]> }>;
    };
}

/** The words on a frame's rows, joined by lines: what a person would read. */
export function textOf(frame: FrameEvent["frame"]): string {
    const rows: string[] = [];

    for (const line of frame.lines) {
        rows[line.y] = line.runs.map((run) => run[0]).join("");
    }

    return rows.map((row) => (row ?? "").replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
}
