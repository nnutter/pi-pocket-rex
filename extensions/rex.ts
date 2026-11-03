/**
 * Rex: a real terminal in Pi Pocket, hosted by a Rex session on this machine or another.
 *
 * The shell is not this module's. It lives in a Rex terminal block, where Rex keeps it and where a person can also reach
 * it from Rex's own app. This module is the middle: it opens the block's data connection, hands the bytes to a Bun
 * process that draws them with Ghostty's engine (`rex-host.ts`, in its runtime folder), and sends the page's keys and
 * text back as the events that the block takes.
 *
 * Pi Pocket runs on Node, and `libghostty-vt` needs Bun's FFI, so the two processes talk in JSON lines: commands on
 * stdin, frames on stdout. The internet between them and Rex is the part that a dropped connection is resumed from.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import { RexClient, RexStream, RexMessageFilter } from "./_rex-client.ts";
import type { Host, Web, WebRequest, WebSession } from "./_pocket.d.ts";

/**
 * A piece of a row that shares a look: `[text, foreground, background, flags, columns]`. An empty color is the default,
 * and `columns` is how many cells the text covers.
 */
type Run = [text: string, fg: string, bg: string, flags: number, columns: number];

/** The cursor as the running program asked for it: DECSCUSR's shape, and whether it blinks. */
type CursorShape = "block" | "underline" | "bar";

/** What the browser needs to draw the screen. Only the rows in `lines` are new since the frame before. */
interface Frame {
    seq: number;
    full: boolean;
    cols: number;
    rows: number;
    title: string;
    cursor: { x: number; y: number; visible: boolean; shape: CursorShape; blink: boolean };
    alt: boolean;
    scroll: { scrollback: number };
    lines: Array<{ y: number; runs: Run[] }>;
}

/** The block creator that every shell in Rex belongs to. */
const TERMINAL_CREATOR = "com.superlogical.terminal";

/** The most terminals at once. Beyond it, a new one is refused. */
const MAX_TERMINALS = 8;

/** How long a terminal that ended stays in the list, so its page can say what happened. */
const KEEP_ENDED_MS = 15 * 60_000;

/** How long a runner has to say that its screen is up. */
const RUNNER_START_MS = 10_000;

/** One terminal: a block in a Rex session, the runner that draws it, and the screen as it was after the last frame. */
interface Terminal {
    id: string;
    /** The Pi Pocket session that this terminal was opened from, and 0 for one that has none. */
    conversation: number;
    /** The Rex server, by the key that its host row uses. */
    hostKey: string;
    hostLabel: string;
    /** The Rex session and the block inside it. */
    sessionId: string;
    /** The session's own name, which is what a person calls it in Rex. */
    sessionLabel: string;
    blockId: string;
    cols: number;
    rows: number;
    createdAt: number;
    title: string;
    alive: boolean;
    exitCode: number | null;
    signal: string | null;
    proc: ChildProcessWithoutNullStreams;
    screen: Run[][];
    cursor: Frame["cursor"];
    alt: boolean;
    scrollback: number;
    seq: number;
    client: RexClient;
    stream: RexStream | null;
    filter: RexMessageFilter | null;
    /** Bytes that came before the screen was seeded: the stream starts before the first paint does. */
    pending: Uint8Array[];
    /** Whether the seed has been given to the runner, so that bytes can go straight through. */
    seeded: boolean;
    /** Resolves when the runner says that its screen is up. */
    markReady: () => void;
}

export default function createRex(_host: Host | null, web: Web) {
    const terminals = new Map<string, Terminal>();

    /** The socket that a Rex server on this machine listens on, which is what `rex server status` prints. */
    function defaultSocket(): string {
        const runtime =
            process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === "function" ? process.getuid() : 0}`;

        return join(runtime, "rex", "server.sock");
    }

    if (typeof web.settings === "function") {
        web.settings([
            {
                name: "local",
                label: "This machine's socket",
                type: "text",
                placeholder: defaultSocket(),
                description: "The Rex server on this machine. Empty uses XDG_RUNTIME_DIR/rex/server.sock.",
            },
            {
                name: "hosts",
                label: "Other machines",
                type: "text",
                placeholder: "work = rex-work.example.ts.net",
                description:
                    "One for each line: a label, =, and a host or URL, or just the host. Empty uses the hosts that this machine's Rex server knows.",
            },
            {
                name: "bun",
                label: "Bun",
                type: "text",
                placeholder: "bun",
                description: "The Bun binary that runs libghostty-vt. Empty finds it in PATH, or in mise's installs.",
            },
            {
                name: "runtime",
                label: "Runtime folder",
                type: "text",
                placeholder: join(homedir(), ".pi-pocket", "rex"),
                description: "The folder with rex-host.ts and libghostty-vt. Empty uses the placeholder.",
            },
        ]);
    }

    const setting = (name: string): string => {
        const value = typeof web.setting === "function" ? web.setting(name) : undefined;

        return typeof value === "string" ? value.trim() : "";
    };

    const runtimeDir = (): string => setting("runtime") || join(homedir(), ".pi-pocket", "rex");

    /** The Bun binary that can run the binding: the setting, `REX_HOST_BUN`, PATH, or mise's installs. */
    function findBun(): string | null {
        const named = setting("bun") || process.env.REX_HOST_BUN || "";

        if (named.includes("/")) {
            if (existsSync(named)) return named;
        } else if (named !== "") {
            for (const folder of (process.env.PATH ?? "").split(delimiter)) {
                if (existsSync(join(folder, named))) return join(folder, named);
            }
        }

        const installs = join(homedir(), ".local", "share", "mise", "installs", "bun");

        if (existsSync(installs)) {
            const found = readdirSync(installs)
                .map((each) => join(installs, each, "bin", "bun"))
                .filter((each) => existsSync(each))
                .sort();

            if (found.length > 0) return found.at(-1)!;
        }

        for (const candidate of [join(homedir(), ".bun", "bin", "bun"), "/usr/local/bin/bun", "/usr/bin/bun"]) {
            if (existsSync(candidate)) return candidate;
        }

        return null;
    }

    /**
     * One server in the person's list: where to reach it, and what to call it. Rex's own picker shows the same thing, a
     * machine above the sessions that it holds, so the fields here are the ones that the picker needs to draw it.
     */
    interface RexHost {
        /** What the page and the settings call it: the endpoint, which does not change when a label does. */
        key: string;
        label: string;
        /** Rex's own name for the icon, such as `macbook` or `server.rack`. */
        icon: string;
        endpoint: string;
        local: boolean;
    }

    /** The local server's socket: the setting, or the place that a Rex server on this machine listens. */
    function localSocket(): string {
        const named = setting("local");

        if (named === "") return defaultSocket();

        return named.startsWith("unix://") ? named.slice("unix://".length) : named;
    }

    /** The hosts that the `hosts` setting names, one for each line: `label = endpoint`, or just the endpoint. */
    function configuredHosts(): RexHost[] {
        return setting("hosts")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"))
            .map((line) => {
                const cut = line.indexOf("=");
                const endpoint = (cut < 0 ? line : line.slice(cut + 1)).trim();
                const named = cut < 0 ? "" : line.slice(0, cut).trim();

                return { key: endpoint, label: named || endpoint, icon: "globe", endpoint, local: false };
            });
    }

    /** The server on this machine, when it is running: no host list can name it, because it is the one being asked. */
    function localHost(): RexHost | null {
        const endpoint = localSocket();

        // A path is a socket that either is there or is not; a host or a URL is something to try.
        if (endpoint.startsWith("/") && !existsSync(endpoint)) return null;

        return { key: endpoint, label: hostname(), icon: "desktopcomputer", endpoint, local: true };
    }

    /** One connection for each host, kept for the life of the module so that the page does not reconnect on every look. */
    const rexByKey = new Map<string, RexClient>();
    const connecting = new Map<string, Promise<RexClient>>();

    function rexFor(host: RexHost): RexClient {
        const existing = rexByKey.get(host.key);

        if (existing !== undefined) return existing;

        const client = new RexClient({
            endpoint: host.endpoint,
            app: { name: "Pi Pocket", version: "0.1.0" },
            timeoutMs: 8_000,
        });

        client.on({ event: (event) => hear(host, event), close: () => void lostHost(host) });

        rexByKey.set(host.key, client);

        return client;
    }

    /** The host's connection, opened if it is not open. Two calls that arrive together share one connection. */
    async function online(host: RexHost): Promise<RexClient> {
        const client = rexFor(host);

        if (client.connected) return client;

        const started = connecting.get(host.key);

        if (started !== undefined) return started;

        const attempt = (async () => {
            try {
                await client.connect();

                return client;
            } finally {
                connecting.delete(host.key);
            }
        })();

        connecting.set(host.key, attempt);

        return attempt;
    }

    /** Forgets a host that failed, so that the next look at it starts a new connection rather than a dead one. */
    function offline(host: RexHost): void {
        const client = rexByKey.get(host.key);

        if (client === undefined) return;

        client.close();
        rexByKey.delete(host.key);
    }

    /**
     * Every server that the person can reach, in the order that Rex's picker shows them: this machine first, then the
     * hosts that it knows, then the ones that the setting names. Two entries for one endpoint are one entry.
     */
    async function hostList(): Promise<RexHost[]> {
        const hosts: RexHost[] = [];
        const seen = new Set<string>();

        const add = (host: RexHost): void => {
            if (host.endpoint === "" || seen.has(host.endpoint)) return;

            seen.add(host.endpoint);
            hosts.push(host);
        };

        const local = localHost();

        if (local !== null) {
            add(local);

            // The local server's host list is the one that Rex.app shows: read it, and fall back to the setting.
            try {
                const client = await online(local);

                for (const entry of await client.hosts()) {
                    const endpoint = entry.endpoints?.[0] ?? "";

                    add({
                        key: endpoint,
                        label: entry.label || endpoint,
                        icon: entry.icon || "globe",
                        endpoint,
                        local: false,
                    });
                }
            } catch {
                // The local server is down. The setting can still name the hosts that matter.
            }
        }

        for (const host of configuredHosts()) add(host);

        return hosts;
    }

    /** The host that a page named, by the key that its row carries. */
    async function hostOf(key: string): Promise<RexHost> {
        const hosts = await hostList();
        const found = hosts.find((host) => host.key === key);

        if (found === undefined) throw web.error(404, "No such machine. Refresh the list of machines.");

        return found;
    }

    /** The machine that a conversation's own terminal runs on: this one, because that is where Pi Pocket runs. */
    async function ownHost(): Promise<RexHost> {
        const local = localHost();

        if (local === null) {
            throw web.error(
                503,
                "This machine has no Rex server, so there is no terminal of its own. Install Rex here, or choose a session in Rex sessions.",
            );
        }

        return local;
    }

    /**
     * The session that belongs to one conversation: the one that is named after it, or a new one in the conversation's
     * folder.
     *
     * A session is found by its label rather than remembered, so that a person who restarts Pi Pocket, or opens the
     * terminal from another tab, comes back to the terminal that they left instead of a second one. The label is the
     * conversation's title, which is the name that the session has in Rex too.
     */
    async function ownSession(
        host: RexHost,
        conversation: number,
        sessions: readonly WebSession[],
        cols: number,
        rows: number,
        fresh = false,
    ): Promise<string> {
        const client = await online(host);
        // A shell that a person asks for by name -- the bar's New shell -- is a session of its own, whatever the
        // conversation is called.
        const label = fresh ? "" : (sessions.find((each) => each.id === conversation)?.title ?? "").trim();

        if (label !== "") {
            const found = (await client.sessions()).find((each) => (each.label ?? "").trim() === label);

            if (found !== undefined) return found.session_id;
        }

        const cwd = sessions.find((each) => each.id === conversation)?.cwd ?? homedir();
        const made = await client.call<{ session_id?: string }>("session.create", {
            ...(label === "" ? {} : { label }),
            initial_windows: [
                {
                    layout: {
                        block: {
                            flavor: `${TERMINAL_CREATOR}.shell`,
                            options: { cwd },
                            size: { columns: cols, rows },
                        },
                    },
                },
            ],
        });

        if (typeof made.session_id !== "string" || made.session_id === "") {
            throw web.error(502, "Rex made no session for this conversation.");
        }

        return made.session_id;
    }

    /** One host, and the sessions that it holds, or why it could not be asked. */
    async function describe(host: RexHost) {
        const base = { key: host.key, label: host.label, icon: host.icon, endpoint: host.endpoint, local: host.local };

        try {
            const client = await online(host);
            const sessions = await client.sessions();

            return {
                ...base,
                online: true,
                address: client.address,
                sessions: sessions.map((session) => ({ id: session.session_id, label: session.label ?? session.session_id })),
            };
        } catch (error) {
            offline(host);

            return { ...base, online: false, address: "", error: error instanceof Error ? error.message : String(error), sessions: [] };
        }
    }

    /** The terminal that a Rex block belongs to, when this module has one. */
    function terminalOf(hostKey: string, sessionId: string, blockId: string): Terminal | undefined {
        for (const terminal of terminals.values()) {
            if (terminal.hostKey === hostKey && terminal.sessionId === sessionId && terminal.blockId === blockId) return terminal;
        }

        return undefined;
    }

    /** What a Rex server says happened, as far as a terminal cares: its program exiting. */
    function hear(host: RexHost, event: { type: string; payload?: unknown }): void {
        if (event.type !== "session_event") return;

        const envelope = event.payload as { session_id?: string; event?: { type?: string; payload?: unknown } } | undefined;
        const inner = envelope?.event;

        if (inner?.type !== "block_event") return;

        const said = inner.payload as { block_id?: string; name?: string; payload?: { exit_code?: number } } | undefined;
        const terminal = terminalOf(host.key, envelope?.session_id ?? "", said?.block_id ?? "");

        if (terminal === undefined) return;

        if (said?.name === "child_exited") ended(terminal, typeof said.payload?.exit_code === "number" ? said.payload.exit_code : null);
    }

    /** A host's connection ended. The streams on it resume or end by themselves; the list says that it is offline. */
    async function lostHost(host: RexHost): Promise<void> {
        if (rexByKey.get(host.key) !== undefined) rexByKey.delete(host.key);
    }

    function summary(terminal: Terminal) {
        return {
            id: terminal.id,
            conversation: terminal.conversation,
            host: terminal.hostKey,
            hostLabel: terminal.hostLabel,
            session: terminal.sessionId,
            sessionLabel: terminal.sessionLabel,
            block: terminal.blockId,
            cols: terminal.cols,
            rows: terminal.rows,
            title: terminal.title,
            alive: terminal.alive,
            exitCode: terminal.exitCode,
            signal: terminal.signal,
            createdAt: terminal.createdAt,
        };
    }

    /** The whole screen, for a page that just opened or reloaded. */
    function snapshot(terminal: Terminal): Frame {
        return {
            seq: terminal.seq,
            full: true,
            cols: terminal.cols,
            rows: terminal.rows,
            title: terminal.title,
            cursor: terminal.cursor,
            alt: terminal.alt,
            scroll: { scrollback: terminal.scrollback },
            lines: terminal.screen.map((runs, y) => ({ y, runs })),
        };
    }

    function tell(terminal: Terminal, frame: Frame): void {
        web.send("frame", { id: terminal.id, frame });
    }

    /** Takes one JSON line from the runner: a frame, a word about the program, or an answer to give the terminal. */
    function read(terminal: Terminal, line: string): void {
        let message: Record<string, unknown>;

        try {
            message = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }

        if (message.t === "frame") {
            const frame = message as unknown as Frame;

            terminal.seq = frame.seq;
            terminal.cols = frame.cols;
            terminal.rows = frame.rows;
            terminal.title = frame.title;
            terminal.cursor = frame.cursor;
            terminal.alt = frame.alt;
            terminal.scrollback = frame.scroll?.scrollback ?? 0;

            if (frame.full || terminal.screen.length !== frame.rows) {
                terminal.screen = Array.from({ length: frame.rows }, () => []);
            }

            for (const { y, runs } of frame.lines) {
                if (y >= 0 && y < terminal.screen.length) terminal.screen[y] = runs;
            }

            tell(terminal, frame);
        } else if (message.t === "ready") {
            terminal.markReady();
        } else if (message.t === "exit") {
            if (terminal.alive) ended(terminal, typeof message.code === "number" ? message.code : null);
        } else if (message.t === "clipboard") {
            // A program copied something: the clipboard is the browser's and the system's, so the page writes it.
            web.send("clipboard", { id: terminal.id, selection: message.selection, text: message.text });
        } else if (message.t === "clipboard-query") {
            // A program asked what the clipboard holds: the page reads it, and answers through the route.
            web.send("clipboard-read", { id: terminal.id, selection: message.selection });
        } else if (message.t === "error" || message.t === "bell") {
            web.send("notice", { id: terminal.id, kind: String(message.t), message: String(message.message ?? "bell") });
        }
    }

    function write(terminal: Terminal, message: Record<string, unknown>): void {
        if (terminal.proc === null || terminal.proc.stdin.destroyed) return;

        terminal.proc.stdin.write(`${JSON.stringify(message)}\n`);
    }

    /** Types text into the block: the same call for a key's text, a paste, and the terminal's own answers. */
    async function type(terminal: Terminal, data: string): Promise<void> {
        if (data === "") return;

        await terminal.client.call("com.superlogical.terminal.write", {
            session_id: terminal.sessionId,
            block_id: terminal.blockId,
            args: { data },
        });
    }

    /** Hands a piece of the stream to the runner, without the parts that a screen cannot take. */
    function feed(terminal: Terminal, bytes: Uint8Array): void {
        const rest = terminal.filter === null ? bytes : terminal.filter.push(bytes);

        if (rest !== null && rest.length > 0) {
            write(terminal, { op: "feed", data: Buffer.from(rest).toString("base64") });
        }
    }

    /** Ends a terminal whose program exited, and says so once. */
    function ended(terminal: Terminal, code: number | null): void {
        if (!terminal.alive) return;

        terminal.alive = false;
        terminal.exitCode = code;
        terminal.signal = null;

        web.send("exit", { id: terminal.id, code, signal: null });
    }

    /** Starts the runner, which draws the screen that the stream fills, and gives the terminal its process. */
    function runner(terminal: Terminal, cols: number, rows: number): void {
        const bun = findBun();
        const host = join(runtimeDir(), "rex-host.ts");

        if (bun === null) {
            throw web.error(
                503,
                "This extension needs Bun to run libghostty-vt. Install Bun (https://bun.sh), or set the Bun binary in Menu → Extensions → Rex.",
            );
        }

        if (!existsSync(host)) {
            throw web.error(
                503,
                `This extension needs its runtime folder, ${runtimeDir()}. Run the install step again (the extension's README tells how).`,
            );
        }

        const proc = spawn(bun, ["run", host], {
            cwd: runtimeDir(),
            env: process.env as Record<string, string>,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let buffer = "";

        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
            buffer += chunk;

            const cut = buffer.lastIndexOf("\n");

            if (cut < 0) return;

            const lines = buffer.slice(0, cut).split("\n");

            buffer = buffer.slice(cut + 1);

            for (const line of lines) {
                if (line.trim() !== "") read(terminal, line);
            }
        });

        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            const text = chunk.trim();

            if (text !== "") web.send("notice", { id: terminal.id, kind: "stderr", message: text.slice(0, 500) });
        });

        proc.on("error", (error) => {
            web.send("notice", { id: terminal.id, kind: "error", message: error.message });
        });

        proc.on("exit", (code) => {
            if (terminal.alive) {
                terminal.alive = false;
                terminal.exitCode = code;
                terminal.signal = null;
                web.send("exit", { id: terminal.id, code, signal: null });
            }
        });

        terminal.proc = proc;

        write(terminal, { op: "start", cols, rows });
    }

    /**
     * Opens a terminal: attach to the Rex session, take its terminal block, own it so that the size is this page's, and
     * start the stream and the screen together.
     */
    async function start(
        request: WebRequest,
        host: RexHost,
        sessionId: string,
        conversation: number,
        cols: number,
        rows: number,
    ): Promise<Terminal> {
        const client = await online(host);

        await client.call("session.attach", { session_id: sessionId });

        const listing = await client.call<{ blocks?: Array<{ block_id: string; creator_name?: string }> | null }>(
            "session.list_blocks",
            { session_id: sessionId },
        );

        let blockId = (listing.blocks ?? []).find((each) => each.creator_name === TERMINAL_CREATOR)?.block_id ?? "";

        if (blockId === "") {
            // A session with no terminal is a session that has nothing to show, so it gets one in the folder of the
            // conversation that asked for it.
            const session = request.sessions().find((each) => each.id === conversation);
            const made = await client.call<{ block_ids?: string[] | null }>("session.new_window", {
                session_id: sessionId,
                layout: { block: { flavor: `${TERMINAL_CREATOR}.shell`, options: { cwd: session?.cwd ?? homedir() } } },
            });

            blockId = made.block_ids?.[0] ?? "";
        }

        if (blockId === "") throw web.error(502, "Rex made no terminal for that session.");

        // The session's own name, for the bar: a person looking at a terminal should see which one it is.
        const named = (await client.sessions()).find((each) => each.session_id === sessionId);

        // The owner's size is the terminal's size, and its colors are the terminal's colors.
        await client.call("session.own_block", { session_id: sessionId, block_ids: [blockId], mode: "request" });
        await client.call(`${TERMINAL_CREATOR}.resize`, {
            session_id: sessionId,
            block_id: blockId,
            args: { columns: cols, rows },
        });

        const terminal: Terminal = {
            id: randomUUID(),
            conversation,
            hostKey: host.key,
            hostLabel: host.label,
            sessionId,
            sessionLabel: named?.label ?? sessionId,
            blockId,
            cols,
            rows,
            createdAt: Date.now(),
            title: "",
            alive: true,
            exitCode: null,
            signal: null,
            proc: null as unknown as ChildProcessWithoutNullStreams,
            screen: Array.from({ length: rows }, () => []),
            cursor: { x: 0, y: 0, visible: true, shape: "block", blink: false },
            alt: false,
            scrollback: 0,
            seq: 0,
            client,
            stream: null,
            filter: null,
            pending: [],
            seeded: false,
            markReady: () => {},
        };

        const ready = new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), RUNNER_START_MS);

            terminal.markReady = () => {
                clearTimeout(timer);
                resolve();
            };
        });

        runner(terminal, cols, rows);
        terminals.set(terminal.id, terminal);

        // The stream starts first, so that nothing printed between the paint and the connection is lost: what arrives
        // before the seed waits in `pending`.
        const stream = await RexStream.open({
            client,
            sessionId,
            blockId,
            onData: (bytes) => {
                if (!terminal.seeded) {
                    terminal.pending.push(bytes);

                    return;
                }

                feed(terminal, bytes);
            },
            onEnd: (reason) => {
                ended(terminal, null);
                web.send("notice", { id: terminal.id, kind: "stream", message: reason });
            },
        });

        terminal.stream = stream;
        terminal.filter = new RexMessageFilter(stream.welcome?.nonce ?? 0n);

        // The screen that is already there: escape sequences that redraw it, so that the page opens on the session as
        // it stands rather than on an empty screen that the next line of output would half fill.
        const painted = await client.call<{ content?: string }>(`${TERMINAL_CREATOR}.format`, {
            session_id: sessionId,
            block_id: blockId,
            args: { format: "vt", extra_cursor: true, extra_palette: true, extra_modes: true, max_bytes: 900_000 },
        });

        await ready;

        write(terminal, { op: "seed", text: painted.content ?? "" });

        terminal.seeded = true;

        for (const bytes of terminal.pending.splice(0)) feed(terminal, bytes);

        return terminal;
    }

    /**
     * Ends the terminals of a session that is archived: an archived session has nowhere to show a terminal, so a shell
     * that nobody can see does not keep running.
     */
    function close(conversation: number): void {
        for (const terminal of [...terminals.values()]) {
            if (terminal.conversation !== conversation) continue;

            end(terminal);
        }
    }

    /**
     * Ends a terminal, and says that it ended. A person asked for this, or their session went, so the page closes the
     * panel and says nothing about it. The Rex session keeps running: this module was only watching it.
     */
    function end(terminal: Terminal): void {
        terminals.delete(terminal.id);

        terminal.stream?.close();
        terminal.stream = null;

        void terminal.client
            .call("session.disown_block", { session_id: terminal.sessionId, block_ids: [terminal.blockId] })
            .catch(() => {});

        write(terminal, { op: "kill" });

        const timer = setTimeout(() => terminal.proc.kill(), 1000);

        timer.unref?.();
        terminal.proc.once("exit", () => clearTimeout(timer));

        if (terminal.alive) {
            terminal.alive = false;
            terminal.exitCode = null;
            terminal.signal = null;

            web.send("exit", { id: terminal.id, code: null, signal: null });
        }
    }

    /** Ends the terminals of the sessions that this person sees as archived, for an archive that this module did not hear. */
    function closeArchived(sessions: readonly WebSession[]): void {
        for (const session of sessions) {
            if (session.archived) close(session.id);
        }
    }

    // Pi Pocket sends this after the archive is stored. An older server sends none, and the routes' own check covers it.
    const stop = _host?.on?.("session.archived", ({ conversationId, archived }) => {
        if (archived) close(conversationId);
    });

    if (typeof stop === "function") web.onDispose(stop);

    /** The terminal that a path names, or the 404 that a page cannot tell from a route that is not there. */
    function find(request: WebRequest): Terminal {
        const terminal = terminals.get(request.params.id ?? "");

        if (terminal === undefined) throw web.error(404, "No such terminal");

        return terminal;
    }

    /** A whole number in a range, or the fallback. */
    function size(value: unknown, least: number, most: number, fallback: number): number {
        const number = Math.round(Number(value));

        return Number.isFinite(number) && number >= least && number <= most ? number : fallback;
    }

    // The picker's own call: every machine, with the sessions under it, as Rex shows them.
    web.route("GET", "hosts", async () => ({ hosts: await Promise.all((await hostList()).map((host) => describe(host))) }));

    web.route("GET", "terminals", (request) => {
        closeArchived(request.sessions());

        return {
            // Every terminal, with the session that it was opened from: the page that lists them all says whose each one
            // is, so that a person can tell the terminal beside their work from the one that a closed tab left behind.
            terminals: [...terminals.values()].map((each) => ({ ...summary(each), session: each.hostLabel })),
            max: MAX_TERMINALS,
            bun: findBun() !== null,
            runner: existsSync(join(runtimeDir(), "rex-host.ts")),
        };
    });

    // A machine that the person names, kept where Rex keeps its own list: on this machine's server, so that Rex.app
    // shows it too. Without a server here there is nothing to write it to, and the setting is the way in.
    web.route("POST", "machines", async (request) => {
        const label = String(request.body.label ?? "").trim();
        const endpoint = String(request.body.endpoint ?? "").trim();

        if (label === "" || endpoint === "") throw web.error(400, "A machine needs a name and an address.");

        const local = localHost();

        if (local === null) {
            throw web.error(
                503,
                "This machine has no Rex server to keep the list of machines. Add it in Menu → Extensions → Rex.",
            );
        }

        const client = await online(local);

        await client.call("hosts.put", {
            host: { label, endpoints: [endpoint], icon: "globe", added_from: "Pi Pocket" },
        });

        return { ok: true, label, endpoint };
    });

    // A new session on a machine, with a shell in it: the row that Rex's own picker has at the bottom.
    web.route("POST", "sessions", async (request) => {
        const named = String(request.body.host ?? "");
        const host = named === "" ? await ownHost() : await hostOf(named);
        const label = String(request.body.label ?? "").trim();
        const cwd = String(request.body.cwd ?? "") || homedir();

        const client = await online(host);
        const made = await client.call<{ session_id?: string }>("session.create", {
            ...(label === "" ? {} : { label }),
            initial_windows: [{ layout: { block: { flavor: `${TERMINAL_CREATOR}.shell`, options: { cwd } } } }],
        });

        if (typeof made.session_id !== "string" || made.session_id === "") {
            throw web.error(502, "Rex made no session.");
        }

        const made_ = (await client.sessions()).find((each) => each.session_id === made.session_id);

        return { host: host.key, session: made.session_id, label: made_?.label ?? made.session_id };
    });

    web.route("POST", "terminals", async (request) => {
        closeArchived(request.sessions());

        const cols = size(request.body.cols, 20, 400, 80);
        const rows = size(request.body.rows, 5, 200, 24);
        const conversation = Number(request.body.conversation) || 0;

        // A page that names a session shows that one. A page that names none is this conversation's own terminal, which
        // is a session of the person's on this machine, made for the conversation the first time that it is asked for.
        const named = String(request.body.host ?? "") !== "" && String(request.body.session ?? "") !== "";
        // The bar's New shell: another shell where this one is, rather than the one that is already there.
        const fresh = request.body.new === true;
        const host = named ? await hostOf(String(request.body.host)) : await ownHost();
        const sessionId =
            named && !fresh ? String(request.body.session) : await ownSession(host, conversation, request.sessions(), cols, rows, fresh);

        // One terminal for each block: a page that reloads finds the one that it left rather than a second stream.
        const existing = [...terminals.values()].find(
            (each) => each.alive && each.hostKey === host.key && each.sessionId === sessionId,
        );

        if (existing !== undefined) {
            if (existing.cols !== cols || existing.rows !== rows) {
                existing.cols = cols;
                existing.rows = rows;
                write(existing, { op: "resize", cols, rows });
                void existing.client
                    .call(`${TERMINAL_CREATOR}.resize`, {
                        session_id: existing.sessionId,
                        block_id: existing.blockId,
                        args: { columns: cols, rows },
                    })
                    .catch(() => {});
            }

            return { terminal: summary(existing), frame: snapshot(existing) };
        }

        if ([...terminals.values()].filter((each) => each.alive).length >= MAX_TERMINALS) {
            throw web.error(429, `That is ${MAX_TERMINALS} terminals at once. End one first.`);
        }

        const terminal = await start(request, host, sessionId, conversation, cols, rows);

        const timer = setTimeout(() => {
            if (!terminal.alive) terminals.delete(terminal.id);
        }, KEEP_ENDED_MS);

        timer.unref();

        return { terminal: summary(terminal), frame: snapshot(terminal) };
    });

    web.route("GET", "terminals/:id", (request) => {
        const terminal = find(request);

        return { terminal: summary(terminal), frame: snapshot(terminal) };
    });

    web.route("POST", "terminals/:id/input", async (request) => {
        const terminal = find(request);

        if (typeof request.body.text === "string" && request.body.text !== "") await type(terminal, request.body.text);

        for (const key of Array.isArray(request.body.keys) ? (request.body.keys as unknown[]).slice(0, 32) : []) {
            await terminal.client.call("block.event", {
                session_id: terminal.sessionId,
                block_id: terminal.blockId,
                event: { type: "key", payload: rexKeyOf(key as never) },
            });
        }

        return { ok: true };
    });

    web.route("POST", "terminals/:id/paste", async (request) => {
        const terminal = find(request);

        await terminal.client.call("block.event", {
            session_id: terminal.sessionId,
            block_id: terminal.blockId,
            event: { type: "paste", payload: { text: String(request.body.text ?? "") } },
        });

        return { ok: true };
    });

    web.route("POST", "terminals/:id/focus", async (request) => {
        const terminal = find(request);

        await terminal.client.call("block.event", {
            session_id: terminal.sessionId,
            block_id: terminal.blockId,
            event: { type: "focus", payload: { action: request.body.inside === true ? "in" : "out" } },
        });

        return { ok: true };
    });

    /** The clipboard's text, for a program that asked for it: the page read it, and this is the answer to that ask. */
    web.route("POST", "terminals/:id/clipboard", async (request) => {
        const terminal = find(request);
        const selection = typeof request.body.selection === "string" ? request.body.selection : "c";
        const text = typeof request.body.text === "string" ? request.body.text : "";

        await type(terminal, `\u001b]52;${selection};${Buffer.from(text, "utf8").toString("base64")}\u001b\\`);

        return { ok: true };
    });

    web.route("POST", "terminals/:id/resize", async (request) => {
        const terminal = find(request);
        const cols = size(request.body.cols, 20, 400, terminal.cols);
        const rows = size(request.body.rows, 5, 200, terminal.rows);

        if (cols !== terminal.cols || rows !== terminal.rows) {
            terminal.cols = cols;
            terminal.rows = rows;
            write(terminal, { op: "resize", cols, rows });

            await terminal.client
                .call(`${TERMINAL_CREATOR}.resize`, {
                    session_id: terminal.sessionId,
                    block_id: terminal.blockId,
                    args: { columns: cols, rows },
                })
                .catch(() => {});
        }

        return { ok: true, cols, rows };
    });

    web.route("POST", "terminals/:id/scroll", (request) => {
        const terminal = find(request);
        const to =
            request.body.to === "bottom" || request.body.to === "top" ? request.body.to : Math.trunc(Number(request.body.to ?? request.body.lines)) || 0;

        write(terminal, { op: "scroll", to });

        return { ok: true };
    });

    web.route("DELETE", "terminals/:id", (request) => {
        end(find(request));

        return { ok: true };
    });

    web.client("rex");

    web.onDispose(() => {
        for (const terminal of terminals.values()) {
            terminal.stream?.close();
            terminal.proc.kill();
        }

        terminals.clear();

        // A Rex session keeps running without this module, so the connections only stop being watched.
        for (const client of rexByKey.values()) client.close();

        rexByKey.clear();
    });
}

/** The key names that a Rex terminal takes, as `block.event` lists them. */
const KEY_NAMES = new Set(
    (
        "unidentified backquote backslash bracket_left bracket_right comma equal minus period quote semicolon slash " +
        "intl_backslash intl_ro intl_yen alt_left alt_right backspace caps_lock context_menu control_left control_right " +
        "enter meta_left meta_right shift_left shift_right space tab convert kana_mode non_convert delete end help home " +
        "insert page_down page_up arrow_down arrow_left arrow_right arrow_up num_lock escape fn fn_lock print_screen " +
        "scroll_lock pause browser_back browser_favorites browser_forward browser_home browser_refresh browser_search " +
        "browser_stop eject launch_app_1 launch_app_2 launch_mail media_play_pause media_select media_stop " +
        "media_track_next media_track_previous power sleep audio_volume_down audio_volume_mute audio_volume_up wake_up " +
        "copy cut paste " +
        Array.from({ length: 26 }, (_, index) => `key_${String.fromCharCode(97 + index)}`).join(" ") +
        " " +
        Array.from({ length: 10 }, (_, index) => `digit_${index}`).join(" ") +
        " " +
        Array.from({ length: 10 }, (_, index) => `numpad_${index}`).join(" ") +
        " " +
        Array.from({ length: 25 }, (_, index) => `f${index + 1}`).join(" ") +
        " numpad_add numpad_backspace numpad_clear numpad_clear_entry numpad_comma numpad_decimal numpad_divide " +
        "numpad_enter numpad_equal numpad_memory_add numpad_memory_clear numpad_memory_recall numpad_memory_store " +
        "numpad_memory_subtract numpad_multiply numpad_paren_left numpad_paren_right numpad_subtract numpad_separator " +
        "numpad_up numpad_down numpad_right numpad_left numpad_begin numpad_home numpad_end numpad_insert numpad_delete " +
        "numpad_page_up numpad_page_down"
    )
        .split(" ")
        .filter((name) => name !== ""),
);

/** The key that a browser names, as Rex names it: `KeyA` is `key_a`, `PageUp` is `page_up`. */
export function rexKeyName(code: string): string {
    if (KEY_NAMES.has(code)) return code;

    // A function key keeps its number: `F1` is `f1`, not `f_1`.
    if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();

    const named = code
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Za-z])(\d)/g, "$1_$2")
        .toLowerCase();

    return KEY_NAMES.has(named) ? named : "unidentified";
}

/** The modifiers held, in the order that Rex reads them, or an empty string for none. */
function modsOf(mods: Record<string, boolean | undefined> | undefined): string {
    const held: string[] = [];

    if (mods?.shift === true) held.push("shift");
    if (mods?.ctrl === true) held.push("ctrl");
    if (mods?.alt === true) held.push("alt");
    if (mods?.super === true) held.push("super");

    return held.join("+");
}

/** The code point that a key types without shift, for the bindings that follow the keyboard's layout. */
function unshiftedOf(name: string): number {
    const letter = /^key_([a-z])$/.exec(name);

    if (letter !== null) return letter[1]!.charCodeAt(0);

    const digit = /^digit_(\d)$/.exec(name);

    return digit === null ? 0 : digit[1]!.charCodeAt(0);
}

/** A keydown, as the key event that a Rex terminal takes. */
export function rexKeyOf(event: { key?: string; mods?: Record<string, boolean>; utf8?: string }): Record<string, unknown> {
    const name = rexKeyName(String(event.key ?? ""));
    const text = typeof event.utf8 === "string" ? event.utf8 : "";

    return {
        action: "press",
        key: name,
        mods: modsOf(event.mods),
        // A browser does not say which modifiers the layout spent on a character, and Rex accepts an empty list.
        consumed_mods: "",
        text,
        unshifted_codepoint: unshiftedOf(name),
        composing: false,
    };
}
