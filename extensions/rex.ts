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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { RexCallError, RexClient, RexStream, RexMessageFilter } from "./_rex-client.ts";
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

/** How long a tab that said goodbye waits for another tab to come back: a reload is a goodbye and a hello. */
const TAB_GRACE_MS = 10_000;

/** How long a look at the ledger waits before it looks again: a page that reloads twice is one look's worth of work. */
const SWEEP_EVERY_MS = 60_000;

/** The file that names the sessions that this module made, under Pi Pocket's data folder. */
const MADE_FILE = "made.json";

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

/** A Rex session that this module watched, and the blocks that it opened in it. */
interface Watched {
    client: RexClient;
    hostKey: string;
    sessionId: string;
    blocks: string[];
}

/**
 * The sessions that this module made, by the machine that holds each one, and the blocks that it opened in each of
 * them.
 */
type Ledger = Map<string, Map<string, Set<string>>>;

export default function createRex(_host: Host | null, web: Web) {
    const terminals = new Map<string, Terminal>();

    /**
     * The tabs of the app that have this module loaded, by the name that each one made for itself.
     *
     * A shell lives in Rex, not in a tab, so the shells that this module opened outlive the page that opened them. The
     * last tab is the one thing that says that nobody is watching, and it is then that the blocks close and the
     * sessions that they leave empty go with them.
     */
    const tabs = new Set<string>();

    /** The goodbye that waits for a tab to come back, while one waits. */
    let leaving: ReturnType<typeof setTimeout> | null = null;

    /** When the ledger was last looked at, so that a run of hellos is one look. */
    let sweptAt = 0;

    /** Pi Pocket's data folder, which a person can move with `PI_POCKET_DIR`: where a module keeps what it remembers. */
    const dataFolder = (process.env.PI_POCKET_DIR ?? "").trim() || join(homedir(), ".pi-pocket");

    /** The file of the sessions and blocks that this module made. */
    const ledgerFile = join(dataFolder, "rex", MADE_FILE);

    /**
     * The sessions that this module made, by the endpoint of the machine that holds each one, and the blocks that it
     * opened in each of them.
     *
     * Rex keeps a session that has lost its last block, and a tab that dies says no goodbye, so nothing on the Rex side
     * would ever close the session that such a tab leaves. A file is what makes the next look work after the restart
     * that lost the goodbye, and Pi Pocket's data folder is where a module's own state belongs. The blocks are in it
     * for the same reason: a terminal that this module opened is only its own while it holds it.
     */
    const ledger = readLedger();

    /** The ledger as it is on disk: empty when it is not there, or when a half-written save left what is not a ledger. */
    function readLedger(): Ledger {
        const kept: Ledger = new Map();

        try {
            const held = JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, unknown>;

            for (const [host, made] of Object.entries(held)) {
                const sessions = new Map<string, Set<string>>();

                // The ledger of the version that kept sessions alone, whose blocks it never wrote down.
                if (Array.isArray(made)) {
                    for (const each of made) if (typeof each === "string") sessions.set(each, new Set());
                }

                if (made !== null && typeof made === "object" && !Array.isArray(made)) {
                    for (const [sessionId, blocks] of Object.entries(made as Record<string, unknown>)) {
                        if (!Array.isArray(blocks)) continue;

                        sessions.set(sessionId, new Set(blocks.filter((each) => typeof each === "string")));
                    }
                }

                if (sessions.size > 0) kept.set(host, sessions);
            }
        } catch {
            // A module that remembers nothing is a module that ends nothing that it did not make, which is the safe way
            // to be wrong.
        }

        return kept;
    }

    /** Writes the ledger down, so that the next run of this module can find what this one made. */
    function saveLedger(): void {
        const held: Record<string, Record<string, string[]>> = {};

        for (const [host, sessions] of ledger) {
            if (sessions.size === 0) continue;

            const made: Record<string, string[]> = {};

            for (const [sessionId, blocks] of sessions) made[sessionId] = [...blocks];

            held[host] = made;
        }

        try {
            mkdirSync(dirname(ledgerFile), { recursive: true });
            writeFileSync(ledgerFile, `${JSON.stringify(held, null, 4)}\n`);
        } catch {
            // A data folder that cannot be written is a folder whose sessions the next run cannot clean up. No terminal
            // fails for it.
        }
    }

    /** Says that this module made a session, so that a look after a restart can find it. */
    function remember(hostKey: string, sessionId: string): void {
        const sessions = ledger.get(hostKey) ?? new Map<string, Set<string>>();

        ledger.set(hostKey, sessions);

        if (sessions.has(sessionId)) return;

        sessions.set(sessionId, new Set());
        saveLedger();
    }

    /** Says that a session that this module made is gone. */
    function forget(hostKey: string, sessionId: string): void {
        const sessions = ledger.get(hostKey);

        if (sessions === undefined || !sessions.delete(sessionId)) return;

        saveLedger();
    }

    /** Says that this module opened a block, so that a look after a restart can find it again. */
    function rememberBlock(hostKey: string, sessionId: string, blockId: string): void {
        remember(hostKey, sessionId);

        const blocks = ledger.get(hostKey)?.get(sessionId);

        if (blocks === undefined || blocks.has(blockId)) return;

        blocks.add(blockId);
        saveLedger();
    }

    /** Says that a block is no longer this module's: it closed the block, or gave it back. */
    function forgetBlock(hostKey: string, blockId: string): void {
        const sessions = ledger.get(hostKey);

        if (sessions === undefined) return;

        for (const blocks of sessions.values()) {
            if (!blocks.delete(blockId)) continue;

            saveLedger();

            return;
        }
    }

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
        const made = await client.call<{
            session_id?: string;
            initial_windows?: Array<{ block_ids?: string[] | null }> | null;
        }>("session.create", {
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

        remember(host.key, made.session_id);

        for (const blockId of made.initial_windows?.[0]?.block_ids ?? []) rememberBlock(host.key, made.session_id, blockId);

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

    /**
     * Puts the view at the prompt, where what is typed will be. A person who types is looking for the prompt, and the
     * view may be scrolled back: by the page that types, by another page of the same terminal, or by a page that a
     * reload left behind. A frame says how long the scrollback is and not where the view is in it, so no page can know
     * that the view is back, and the module puts it there before the keys go.
     */
    function atPrompt(terminal: Terminal): void {
        write(terminal, { op: "scroll", to: "bottom" });
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

            if (blockId !== "") rememberBlock(host.key, sessionId, blockId);
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
     *
     * The shell is Rex's, so ending it here closes its block rather than giving the block back, and the session that the
     * closed blocks leave empty goes with them: an archived conversation is not a place to come back to.
     */
    async function close(conversation: number): Promise<void> {
        const watched = [...terminals.values()].filter((terminal) => terminal.conversation === conversation);
        const sessions = sessionsOf(watched);

        for (const terminal of watched) unwatch(terminal);

        for (const session of sessions) await letGoOf(session);
    }

    /**
     * Ends a terminal, and says that it ended, because a person asked for it: the page closes the panel and says
     * nothing about it. The block goes back to Rex rather than closing, since a session that a person picked on the
     * rail is theirs, and its shell keeps running for Rex.app to show.
     */
    function end(terminal: Terminal): void {
        unwatch(terminal);
        forgetBlock(terminal.hostKey, terminal.blockId);

        void terminal.client
            .call("session.disown_block", { session_id: terminal.sessionId, block_ids: [terminal.blockId] })
            .catch(() => {});
    }

    /**
     * Stops watching a terminal: the stream closes, the runner goes, and the page is told that it ended. The block in Rex
     * is another thing, and what becomes of it is the caller's to say.
     */
    function unwatch(terminal: Terminal): void {
        terminals.delete(terminal.id);

        terminal.stream?.close();
        terminal.stream = null;

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

    /**
     * Destroys a session that holds no block, and says whether it is gone: this call destroyed it, or Rex no longer had
     * it.
     *
     * A session that cannot be asked is left alone: an empty session in Rex is better than a session that a call which
     * failed cannot tell from one that another program is using. The connection steps out of a session that stays, so
     * that a look at one does not leave the module among the viewers that Rex shows.
     */
    async function destroyIfEmpty(client: RexClient, sessionId: string): Promise<boolean> {
        try {
            await client.call("session.attach", { session_id: sessionId });
        } catch (error) {
            // A session that Rex no longer has is as gone as one that this call destroys.
            return error instanceof RexCallError && error.code === "session_not_found";
        }

        const left = await client
            .call<{ blocks?: Array<{ block_id?: string | null }> | null }>("session.list_blocks", { session_id: sessionId })
            .catch(() => null);

        if (left !== null && (left.blocks ?? []).length === 0) {
            try {
                await client.call("session.destroy", { session_id: sessionId });

                return true;
            } catch (error) {
                return error instanceof RexCallError && error.code === "session_not_found";
            }
        }

        await client.call("session.detach", { session_id: sessionId }).catch(() => {});

        return false;
    }

    /**
     * Ends what no tab is watching: every block that this module opened is closed, and a session that is left with no
     * block goes with it.
     *
     * Rex closes a window by itself when its last block leaves, and it keeps the session: an empty session is the one
     * thing that a tab which has gone leaves behind in Rex. A session that still holds a block is not this module's to
     * end, since that block is a program that a person started in Rex.
     */
    async function letGo(): Promise<void> {
        // The sessions are taken before the watch ends: two terminals can share a session, and it is empty only once
        // both of them have gone.
        const sessions = sessionsOf([...terminals.values()]);

        for (const terminal of [...terminals.values()]) unwatch(terminal);

        for (const session of sessions) await letGoOf(session);
    }

    /**
     * The sessions that terminals are in, each with the blocks that this module opened in it, by a machine and a
     * session.
     *
     * A caller closes every block of a session before it asks whether the session is empty: two terminals can share
     * one, and a look that came between their blocks would find a session that is not empty yet.
     */
    function sessionsOf(watched: readonly Terminal[]): Watched[] {
        const sessions = new Map<string, Watched>();

        for (const terminal of watched) {
            const key = `${terminal.hostKey}\u0000${terminal.sessionId}`;
            const found = sessions.get(key);

            if (found === undefined) {
                sessions.set(key, {
                    client: terminal.client,
                    hostKey: terminal.hostKey,
                    sessionId: terminal.sessionId,
                    blocks: [terminal.blockId],
                });
            } else {
                found.blocks.push(terminal.blockId);
            }
        }

        return [...sessions.values()];
    }

    /** Closes the blocks that this module opened in a session, and destroys the session that they leave empty. */
    async function letGoOf(session: Watched): Promise<void> {
        for (const blockId of session.blocks) {
            await session.client.call("block.close", { session_id: session.sessionId, block_id: blockId }).catch(() => {});
            forgetBlock(session.hostKey, blockId);
        }

        if (await destroyIfEmpty(session.client, session.sessionId)) forget(session.hostKey, session.sessionId);
    }

    /**
     * Ends what a tab that died left in Rex: the sessions that this module made and that hold no block any more.
     *
     * A tab that goes says goodbye, and letGo ends what it was watching. A tab that dies says nothing, so the module
     * finds its own sessions again the next time that one says hello, and closes the ones that are empty by then. What
     * it leaves alone is a session that still holds a block, and a session that this module holds a terminal of: a
     * session is empty only once the block that the module opened has closed.
     */
    async function sweep(): Promise<void> {
        let changed = false;

        for (const host of await hostList()) {
            const sessions = ledger.get(host.key);

            if (sessions === undefined || sessions.size === 0) continue;

            try {
                const client = await online(host);

                for (const id of [...sessions.keys()]) {
                    if (held(host.key, id)) continue;

                    if (await destroyIfEmpty(client, id)) {
                        sessions.delete(id);
                        changed = true;
                    }
                }
            } catch {
                // A machine that cannot be asked keeps what it has: an empty session in Rex is better than a guess about
                // a session that a person may be using.
            }
        }

        if (changed) saveLedger();
    }

    /** Whether this module holds a terminal of the session, whether that terminal is still running or not. */
    function held(hostKey: string, sessionId: string): boolean {
        for (const terminal of terminals.values()) {
            if (terminal.hostKey === hostKey && terminal.sessionId === sessionId) return true;
        }

        return false;
    }

    /** Looks at the ledger, unless it looked a moment ago: a page that reloads is a hello, not a reason to ask again. */
    function look(): void {
        if (Date.now() - sweptAt < SWEEP_EVERY_MS) return;

        sweptAt = Date.now();
        void sweep().catch(() => {});
    }

    /** Waits a moment for a tab to come back before ending what the last one was watching. */
    function waitForTab(): void {
        if (leaving !== null) clearTimeout(leaving);

        leaving = setTimeout(() => {
            leaving = null;
            void letGo();
        }, TAB_GRACE_MS);

        leaving.unref?.();
    }

    /** Ends the terminals of the sessions that this person sees as archived, for an archive that this module did not hear. */
    function closeArchived(sessions: readonly WebSession[]): void {
        for (const session of sessions) {
            if (session.archived) void close(session.id);
        }
    }

    // Pi Pocket sends this after the archive is stored. An older server sends none, and the routes' own check covers it.
    const stop = _host?.on?.("session.archived", ({ conversationId, archived }) => {
        if (archived) void close(conversationId);
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

    /**
     * A tab of the app says that it is here, and says goodbye when it goes.
     *
     * The module ends what no tab is watching when the last one goes. A reload is a goodbye and a hello, a moment
     * apart, so a hello takes back the goodbye that waits.
     */
    web.route("POST", "tabs", (request) => {
        const tab = String(request.body.tab ?? "");

        if (tab !== "") {
            tabs.add(tab);

            if (leaving !== null) {
                clearTimeout(leaving);
                leaving = null;
            }

            // A tab that is here is the first news of a tab that died, whose sessions nothing has closed yet.
            look();
        }

        return { ok: true };
    });

    web.route("POST", "tabs/gone", (request) => {
        const tab = String(request.body.tab ?? "");

        if (tab !== "" && tabs.delete(tab) && tabs.size === 0) waitForTab();

        return { ok: true };
    });

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
        const made = await client.call<{
            session_id?: string;
            initial_windows?: Array<{ block_ids?: string[] | null }> | null;
        }>("session.create", {
            ...(label === "" ? {} : { label }),
            initial_windows: [{ layout: { block: { flavor: `${TERMINAL_CREATOR}.shell`, options: { cwd } } } }],
        });

        if (typeof made.session_id !== "string" || made.session_id === "") {
            throw web.error(502, "Rex made no session.");
        }

        remember(host.key, made.session_id);

        for (const blockId of made.initial_windows?.[0]?.block_ids ?? []) rememberBlock(host.key, made.session_id, blockId);

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

        atPrompt(terminal);

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

        atPrompt(terminal);

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
        if (leaving !== null) clearTimeout(leaving);

        leaving = null;

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
