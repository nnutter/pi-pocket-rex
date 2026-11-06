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
import {
    RexCallError,
    RexClient,
    RexStream,
    RexMessageFilter,
    type RexBlock,
    type RexView,
    type RexWindow,
} from "./_rex-client.ts";
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

/**
 * The name of the one Rex session that this module opens its shells in, on each machine.
 *
 * A session's name is how the module finds it again after a restart, and a person sees the same name in Rex: one Pi
 * Pocket session, with a window for each conversation.
 */
const POCKET_SESSION = "Pi Pocket";

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
    /** The Rex session, the window in it, and the block in that window. */
    sessionId: string;
    windowId: string;
    /** The name of the window that holds the block, which is what the bar under the terminal shows. */
    windowLabel: string;
    blockId: string;
    /** Whether this module opened the block. One that it watches was Rex's before, and stays Rex's to close. */
    owned: boolean;
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

/** The shell in a window, which is what a terminal watches. */
interface Shell {
    windowId: string;
    blockId: string;
    /** The window's label, which is the conversation's name. */
    windowLabel: string;
    /** Whether this module opened the shell. A window that Rex already had keeps the shell that is in it. */
    owned: boolean;
}

/** A Rex session that this module watched, and the blocks that it opened in it. */
interface Watched {
    client: RexClient;
    hostKey: string;
    sessionId: string;
    blocks: string[];
}

/**
 * The window and the shell that a conversation got, which the ledger keeps so that the module finds the shell of that
 * conversation and not the shell of another one.
 */
interface Conversation {
    /** The Rex session that holds the window. */
    session: string;
    /** The window that the conversation got. */
    window: string;
    /** The shell in that window. */
    block: string;
    /** The name of the conversation, and the folder that its shell runs in. */
    title: string;
    folder: string;
}

/**
 * What this module made on a machine: the sessions that it opened, the blocks in them, and the window that each
 * conversation got.
 */
interface Made {
    /** The blocks that this module opened, by the Rex session that holds them. */
    blocks: Map<string, Set<string>>;
    /** The window and the shell that a conversation got, by the conversation's id. */
    conversations: Map<string, Conversation>;
}

/** What this module made, by the endpoint of the machine that holds each one. */
type Ledger = Map<string, Made>;

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
                const machine: Made = { blocks: new Map(), conversations: new Map() };

                // The ledger of the version that kept sessions alone, whose blocks it never wrote down.
                if (Array.isArray(made)) {
                    for (const each of made) if (typeof each === "string") machine.blocks.set(each, new Set());
                }

                if (made !== null && typeof made === "object" && !Array.isArray(made)) {
                    const told = made as Record<string, unknown>;

                    if (told.blocks !== undefined || told.conversations !== undefined) {
                        // The ledger of this version: the blocks of each session, and the window of each conversation.
                        if (told.blocks !== null && typeof told.blocks === "object") {
                            for (const [sessionId, blocks] of Object.entries(told.blocks as Record<string, unknown>)) {
                                if (!Array.isArray(blocks)) continue;

                                machine.blocks.set(sessionId, new Set(blocks.filter((each) => typeof each === "string")));
                            }
                        }

                        if (told.conversations !== null && typeof told.conversations === "object") {
                            for (const [conversation, found] of Object.entries(told.conversations as Record<string, unknown>)) {
                                if (found === null || typeof found !== "object") continue;

                                const said = found as Partial<Conversation>;

                                if (typeof said.session !== "string" || typeof said.window !== "string") continue;
                                if (typeof said.block !== "string") continue;
                                if (typeof said.title !== "string" || typeof said.folder !== "string") continue;

                                machine.conversations.set(conversation, {
                                    session: said.session,
                                    window: said.window,
                                    block: said.block,
                                    title: said.title,
                                    folder: said.folder,
                                });
                            }
                        }
                    } else {
                        // The ledger of the version that kept the blocks of each session.
                        for (const [sessionId, blocks] of Object.entries(told)) {
                            if (!Array.isArray(blocks)) continue;

                            machine.blocks.set(sessionId, new Set(blocks.filter((each) => typeof each === "string")));
                        }
                    }
                }

                if (machine.blocks.size > 0 || machine.conversations.size > 0) kept.set(host, machine);
            }
        } catch {
            // A module that remembers nothing is a module that ends nothing that it did not make, which is the safe way
            // to be wrong.
        }

        return kept;
    }

    /** Writes the ledger down, so that the next run of this module can find what this one made. */
    function saveLedger(): void {
        const held: Record<string, { blocks: Record<string, string[]>; conversations: Record<string, Conversation> }> = {};

        for (const [host, machine] of ledger) {
            const blocks: Record<string, string[]> = {};

            for (const [sessionId, list] of machine.blocks) blocks[sessionId] = [...list];

            const conversations: Record<string, Conversation> = {};

            for (const [conversation, found] of machine.conversations) conversations[conversation] = found;

            if (Object.keys(blocks).length === 0 && Object.keys(conversations).length === 0) continue;

            held[host] = { blocks, conversations };
        }

        try {
            mkdirSync(dirname(ledgerFile), { recursive: true });
            writeFileSync(ledgerFile, `${JSON.stringify(held, null, 4)}\n`);
        } catch {
            // A data folder that cannot be written is a folder whose sessions the next run cannot clean up. No terminal
            // fails for it.
        }
    }

    /** What this module made on a machine, which is made when the module needs it for the first time. */
    function machineOf(hostKey: string): Made {
        const found = ledger.get(hostKey);

        if (found !== undefined) return found;

        const fresh: Made = { blocks: new Map(), conversations: new Map() };

        ledger.set(hostKey, fresh);

        return fresh;
    }

    /** Says that this module made a session, so that a look after a restart can find it. */
    function remember(hostKey: string, sessionId: string): void {
        const blocks = machineOf(hostKey).blocks;

        if (blocks.has(sessionId)) return;

        blocks.set(sessionId, new Set());
        saveLedger();
    }

    /** Says that a session that this module made is gone. */
    function forget(hostKey: string, sessionId: string): void {
        const found = ledger.get(hostKey);

        if (found === undefined || !found.blocks.delete(sessionId)) return;

        // The windows of a session that is gone are gone with it.
        for (const [conversation, said] of found.conversations) {
            if (said.session === sessionId) found.conversations.delete(conversation);
        }

        saveLedger();
    }

    /** Says that this module opened a block, so that a look after a restart can find it again. */
    function rememberBlock(hostKey: string, sessionId: string, blockId: string): void {
        remember(hostKey, sessionId);

        const blocks = machineOf(hostKey).blocks.get(sessionId);

        if (blocks === undefined || blocks.has(blockId)) return;

        blocks.add(blockId);
        saveLedger();
    }

    /** Says that a block is no longer this module's: it closed the block, or gave it back. */
    function forgetBlock(hostKey: string, blockId: string): void {
        const found = ledger.get(hostKey);

        if (found === undefined) return;

        for (const blocks of found.blocks.values()) {
            if (!blocks.delete(blockId)) continue;

            saveLedger();

            return;
        }
    }

    /**
     * Says which window a conversation got, so that a later look finds that window and not another one.
     *
     * The name of a window is the name of its conversation, and two conversations can share a name: two worktrees of
     * one branch, or two conversations that a person gave the same title. The ledger says which window is whose.
     */
    function rememberWindow(hostKey: string, conversation: number, found: Conversation): void {
        const held = machineOf(hostKey);
        const key = String(conversation);
        const known = held.conversations.get(key);

        // The first window of a conversation is the one that a later ask comes back to. A second shell in the same
        // conversation is another window, and the first one stays the one that the conversation owns.
        if (known !== undefined && known.window !== found.window) return;

        if (known?.title === found.title && known?.folder === found.folder) return;

        held.conversations.set(key, found);
        saveLedger();
    }

    /** Says that a conversation has no window, because the shell in it closed. */
    function forgetWindow(hostKey: string, blockId: string): void {
        const found = ledger.get(hostKey);

        if (found === undefined) return;

        for (const [conversation, said] of found.conversations) {
            if (said.block !== blockId) continue;

            found.conversations.delete(conversation);
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

    /**
     * A session's windows and the blocks in each of them.
     *
     * The connection is asked directly rather than through a method of its own, because Pi Pocket loads a drop-in
     * once and gives only that file a new address when it changes: an import beside it keeps whatever the first load
     * returned, so a method that this module's client gained after the server started would not be there to call.
     */
    async function view(client: RexClient, sessionId: string): Promise<RexView> {
        return await client.call<RexView>("session.view", { session_id: sessionId });
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
     * The one session that holds this module's terminals on a machine: the one that the person sees as Pi Pocket, made
     * the first time that a terminal is asked for.
     *
     * A session is found by its label rather than remembered in memory, so that a person who restarts Pi Pocket, or
     * opens a terminal from another tab, comes back to the session that they left instead of a second one. The session
     * that the windows of this machine's conversations are in comes first: a machine can hold more than one session
     * that carries the name, and the windows of this module are in one of them.
     */
    async function pocketSession(host: RexHost): Promise<string> {
        const client = await online(host);
        const sessions = await client.sessions();

        const held = [...(ledger.get(host.key)?.conversations.values() ?? [])]
            .map((each) => each.session)
            .find((each) => sessions.some((session) => session.session_id === each));

        if (held !== undefined) return held;

        const found = sessions.find((each) => (each.label ?? "").trim() === POCKET_SESSION);

        if (found !== undefined) return found.session_id;

        const made = await client.call<{ session_id?: string }>("session.create", { label: POCKET_SESSION });

        if (typeof made.session_id !== "string" || made.session_id === "") {
            throw web.error(502, "Rex made no session for this machine.");
        }

        remember(host.key, made.session_id);

        return made.session_id;
    }

    /**
     * A shell for one conversation, in the Pi Pocket session: the shell of the conversation's own window, or a new
     * window for it.
     *
     * The window of a conversation is the one that the ledger holds for it, so that a person who reloads the page, or
     * opens the terminal from another tab, comes back to the shell that they left. The folder of the conversation is
     * the check: a shell that runs in another folder is not the shell of this conversation, whatever the ledger says.
     */
    async function shellFor(
        request: WebRequest,
        host: RexHost,
        sessionId: string,
        conversation: number,
        fresh: boolean,
    ): Promise<Shell> {
        const client = await online(host);
        const windows = (await view(client, sessionId)).windows ?? [];
        const name = windowName(request.sessions(), conversation);
        const folder = folderOf(request.sessions(), conversation);
        const own = windowOf(host.key, conversation, folder, windows);

        // The name of a window is the name of its conversation, and a person reads both. A conversation that a person
        // renamed gives its window the new name, so that Rex shows the name that the person knows.
        if (own !== undefined) await renameWindow(client, host.key, conversation, sessionId, own, name);

        // The bar's New shell asks for another shell in the same folder, so it never comes back to the one that is
        // already there.
        if (!fresh && own !== undefined) {
            const shell = shellIn(own)?.block_id;

            if (typeof shell === "string" && shell !== "") {
                return { windowId: own.window_id, blockId: shell, windowLabel: name, owned: true };
            }
        }

        return await newShell(client, host.key, sessionId, name, folder, takenOf(windows), conversation);
    }

    /**
     * The shell that a session already holds in a window, which a person picked on the rail: the module watches it
     * rather than opening one, so the shell is Rex's, and so is the program in it.
     */
    async function shellAt(client: RexClient, hostKey: string, sessionId: string, blockId: string): Promise<Shell> {
        const windows = (await view(client, sessionId)).windows ?? [];

        for (const window of windows) {
            const block = blocksOf(window).find((each) => each.block_id === blockId);

            if (block === undefined) continue;

            if (block.creator_name !== TERMINAL_CREATOR) throw web.error(400, "That window holds no terminal.");

            // A shell that this module made is still its own, so that ending the terminal gives it back as it always has.
            return {
                windowId: window.window_id,
                blockId,
                windowLabel: (window.label ?? "").trim(),
                owned: mine(hostKey, sessionId, blockId),
            };
        }

        throw web.error(404, "Rex has no such window.");
    }

    /**
     * A new window in the Pi Pocket session, with one shell in it, named after the conversation that asked for it.
     *
     * The window carries the conversation's name, so that a person looking at Rex sees which conversation each window
     * is for. The block carries the same name: Rex shows both, and a person reads them as one thing. The ledger says
     * which window is the conversation's, because two conversations can carry the same name.
     */
    async function newShell(
        client: RexClient,
        hostKey: string,
        sessionId: string,
        name: string,
        cwd: string,
        taken: ReadonlySet<string>,
        conversation = 0,
    ): Promise<Shell> {
        const label = freeName(taken, name);
        const made = await client.call<{ window_id?: string | null; block_ids?: string[] | null }>("session.new_window", {
            session_id: sessionId,
            window_label: label,
            layout: { block: { flavor: `${TERMINAL_CREATOR}.shell`, label, options: { cwd } } },
        });

        const blockId = made.block_ids?.[0] ?? "";

        if (typeof made.window_id !== "string" || made.window_id === "" || blockId === "") {
            throw web.error(502, "Rex made no terminal for that conversation.");
        }

        rememberBlock(hostKey, sessionId, blockId);

        // The window of a conversation is the first one that it got. A second shell in the same conversation is
        // another window, and the first one stays the one that the conversation comes back to.
        if (conversation !== 0) {
            rememberWindow(hostKey, conversation, {
                session: sessionId,
                window: made.window_id,
                block: blockId,
                title: name,
                folder: cwd,
            });
        }

        return { windowId: made.window_id, blockId, windowLabel: label, owned: true };
    }

    /**
     * The window that a conversation got, in the windows that the session holds now.
     *
     * The folder of the conversation is the check. A conversation that a person moved to another folder gets a shell in
     * that folder, and a window that Rex no longer holds is gone, so the conversation gets a new one.
     */
    function windowOf(
        hostKey: string,
        conversation: number,
        folder: string,
        windows: readonly RexWindow[],
    ): RexWindow | undefined {
        const found = ledger.get(hostKey)?.conversations.get(String(conversation));

        if (found === undefined) return undefined;

        if (found.folder !== folder) {
            forgetWindow(hostKey, found.block);

            return undefined;
        }

        const window = windows.find((each) => each.window_id === found.window);

        if (window === undefined) forgetWindow(hostKey, found.block);

        return window;
    }

    /**
     * Names the window of a conversation after the conversation again, when the conversation was renamed.
     *
     * A window that a person renamed in Rex keeps that name: the module does not know why it changed, and the
     * conversation did not.
     */
    async function renameWindow(
        client: RexClient,
        hostKey: string,
        conversation: number,
        sessionId: string,
        window: RexWindow,
        title: string,
    ): Promise<void> {
        const found = ledger.get(hostKey)?.conversations.get(String(conversation));

        if (found === undefined || found.title === title) return;

        await client
            .call("session.set_window_label", { session_id: sessionId, window_id: window.window_id, label: title })
            .catch(() => {});

        // The name of the window in the view is the name that the conversation has now.
        window.label = title;

        rememberWindow(hostKey, conversation, { ...found, title });
    }

    /** The blocks of a window, which Rex keeps in the layers that the window splits into. */
    function blocksOf(window: RexWindow): RexBlock[] {
        return (window.layers ?? []).flatMap((layer) => layer.blocks ?? []);
    }

    /**
     * The terminal of a window: the one that has the focus, when that one is a terminal, and otherwise the first one.
     * A window can hold an editor beside a shell, and the shell is what a page can draw.
     */
    function shellIn(window: RexWindow): RexBlock | undefined {
        const shells = blocksOf(window).filter((each) => each.creator_name === TERMINAL_CREATOR);

        return shells.find((each) => each.block_id === window.focused_block_id) ?? shells[0];
    }

    /** Whether this module made a block: the ledger still says that it holds it, and has not given it back. */
    function mine(hostKey: string, sessionId: string, blockId: string): boolean {
        return ledger.get(hostKey)?.blocks.get(sessionId)?.has(blockId) === true;
    }

    /** The names that the windows of a session already carry, which a new window's name must not repeat. */
    function takenOf(windows: readonly RexWindow[]): Set<string> {
        return new Set(windows.map((each) => (each.label ?? "").trim()));
    }

    /** The name of a conversation's window in Rex: the conversation's title, which is what a person calls it there. */
    function windowName(sessions: readonly WebSession[], conversation: number): string {
        return (sessions.find((each) => each.id === conversation)?.title ?? "").trim() || POCKET_SESSION;
    }

    /** The folder of a conversation, which is where its shell runs. */
    function folderOf(sessions: readonly WebSession[], conversation: number): string {
        return sessions.find((each) => each.id === conversation)?.cwd ?? homedir();
    }

    /**
     * A name that no window of the session carries yet: the name itself, or the number after it that is free.
     *
     * A person can ask for a second shell in one conversation, and two windows of one name would make the window that
     * a reload comes back to a guess.
     */
    function freeName(taken: ReadonlySet<string>, name: string): string {
        if (!taken.has(name)) return name;

        for (let count = 2; ; count += 1) {
            const candidate = `${name} ${count}`;

            if (!taken.has(candidate)) return candidate;
        }
    }

    /** One host, and the sessions that it holds, or why it could not be asked. */
    async function describe(host: RexHost) {
        const base = { key: host.key, label: host.label, icon: host.icon, endpoint: host.endpoint, local: host.local };

        try {
            const client = await online(host);
            const sessions = await client.sessions();
            const windows = await Promise.all(sessions.map((session) => windowsOf(client, host.key, session.session_id)));

            return {
                ...base,
                online: true,
                address: client.address,
                sessions: sessions.map((session, at) => ({
                    id: session.session_id,
                    label: session.label ?? session.session_id,
                    windows: windows[at],
                })),
            };
        } catch (error) {
            offline(host);

            return { ...base, online: false, address: "", error: error instanceof Error ? error.message : String(error), sessions: [] };
        }
    }

    /**
     * The windows of a session, each with the shell that a page can show there: what the picker lists under the session.
     *
     * Rex shows a session's windows to a connection that is attached to it, so a look attaches, reads, and steps out
     * again, unless a terminal of this module is in that session and needs the connection where it is. A session that
     * Rex will not show is a session with no window: the list is worth more than the one row that failed.
     */
    async function windowsOf(
        client: RexClient,
        hostKey: string,
        sessionId: string,
    ): Promise<Array<{ id: string; label: string; block: string }>> {
        try {
            await client.call("session.attach", { session_id: sessionId });

            const windows = (await view(client, sessionId)).windows ?? [];

            const listed = windows.map((window) => ({
                id: window.window_id,
                label: (window.label ?? "").trim(),
                block: shellIn(window)?.block_id ?? "",
            }));

            if (!held(hostKey, sessionId)) await stepOut(client, sessionId);

            return listed;
        } catch {
            return [];
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
            windowLabel: terminal.windowLabel,
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
     * Opens a terminal: own the shell in its window, so that the size is this page's, and start the stream and the
     * screen together.
     */
    async function start(
        request: WebRequest,
        host: RexHost,
        sessionId: string,
        shell: Shell,
        conversation: number,
        cols: number,
        rows: number,
    ): Promise<Terminal> {
        const client = await online(host);
        const blockId = shell.blockId;

        // The owner's size is the terminal's size, and its colors are the terminal's colors. A shell that Rex already
        // had keeps the owner that it has, so that a page which looks at one does not take it from Rex.app.
        if (shell.owned) {
            await client.call("session.own_block", { session_id: sessionId, block_ids: [blockId], mode: "request" });
        }

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
            windowId: shell.windowId,
            windowLabel: shell.windowLabel,
            blockId,
            owned: shell.owned,
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
     * nothing about it. The block goes back to Rex rather than closing, since its shell keeps running for Rex.app to
     * show.
     *
     * A block that this module did not open is another program's: it is given back to nobody, because it was never
     * this module's.
     */
    function end(terminal: Terminal): void {
        unwatch(terminal);

        if (!terminal.owned) return;

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
     * failed cannot tell from one that another program is using. A session that stays is one that the caller steps the
     * connection out of, so that a look at one does not leave the module among the viewers that Rex shows.
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

        return false;
    }

    /** Steps the connection out of a session that stays, so that a look at one leaves no viewer behind in Rex. */
    async function stepOut(client: RexClient, sessionId: string): Promise<void> {
        await client.call("session.detach", { session_id: sessionId }).catch(() => {});
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
            // A block that this module only watched is Rex's, and closing it would end a program that a person put there.
            if (!terminal.owned) continue;

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

    /**
     * Closes the blocks that this module opened in a session, and destroys the session that they leave empty.
     *
     * One session can hold the terminals of several conversations, so the session may stay while a terminal of
     * another one is still in it. That terminal goes on calling over this connection, and a connection that stepped
     * out of the session would have every one of those calls refused.
     */
    async function letGoOf(session: Watched): Promise<void> {
        for (const blockId of session.blocks) {
            await session.client.call("block.close", { session_id: session.sessionId, block_id: blockId }).catch(() => {});
            forgetBlock(session.hostKey, blockId);

            // The window of a conversation goes when its shell closes, so that the conversation gets a new one.
            forgetWindow(session.hostKey, blockId);
        }

        if (await destroyIfEmpty(session.client, session.sessionId)) {
            forget(session.hostKey, session.sessionId);

            return;
        }

        if (!held(session.hostKey, session.sessionId)) await stepOut(session.client, session.sessionId);
    }

    /**
     * Ends what a tab that died left in Rex: the blocks that this module opened and that no terminal holds any more,
     * and then the sessions that those blocks leave empty.
     *
     * A tab that goes says goodbye, and letGo ends what it was watching. A tab that dies says nothing, so the module
     * finds its own blocks again the next time that one says hello, and closes the ones that no terminal holds. What it
     * leaves alone is a block that another program opened, and a session that still holds a block: a session is empty
     * only once every block in it has closed.
     */
    async function sweep(): Promise<void> {
        let changed = false;

        for (const host of await hostList()) {
            const sessions = ledger.get(host.key)?.blocks;

            if (sessions === undefined || sessions.size === 0) continue;

            try {
                const client = await online(host);

                for (const [sessionId, blocks] of [...sessions]) {
                    // A session that a terminal of this module is in is not one to clean up: the blocks in it are
                    // being watched.
                    if (held(host.key, sessionId)) continue;

                    // Rex only lets a connection that is attached to a session close a block in it, and answers a
                    // conflict otherwise. The look attaches first, so that the blocks that a dead tab left can close.
                    await client.call("session.attach", { session_id: sessionId }).catch(() => {});

                    for (const blockId of [...blocks]) {
                        if (holds(host.key, blockId)) continue;

                        if (!(await closeForGood(client, sessionId, blockId))) continue;

                        blocks.delete(blockId);

                        // The window of a conversation goes when its shell closes, so that the conversation gets a new
                        // one the next time that it asks for a shell.
                        forgetWindow(host.key, blockId);

                        changed = true;
                    }

                    if (blocks.size === 0 && (await destroyIfEmpty(client, sessionId))) {
                        sessions.delete(sessionId);
                        changed = true;

                        continue;
                    }

                    // A session that this module does not hold is not one that it watches, so the look steps out of it.
                    await stepOut(client, sessionId);
                }
            } catch {
                // A machine that cannot be asked keeps what it has: an empty session in Rex is better than a guess about
                // a session that a person may be using.
            }
        }

        if (changed) saveLedger();
    }

    /**
     * Closes a block that this module opened, and says whether there is nothing left to try: it closed, or Rex no
     * longer has it. A block that would not close stays in the ledger, for a later look to try again.
     */
    async function closeForGood(client: RexClient, sessionId: string, blockId: string): Promise<boolean> {
        try {
            await client.call("block.close", { session_id: sessionId, block_id: blockId });

            return true;
        } catch (error) {
            return (
                error instanceof RexCallError &&
                (error.code === "not_found" || error.code === "block_not_found" || error.code === "session_not_found")
            );
        }
    }

    /** Whether this module holds a terminal of the block, whether that terminal is still running or not. */
    function holds(hostKey: string, blockId: string): boolean {
        for (const terminal of terminals.values()) {
            if (terminal.hostKey === hostKey && terminal.blockId === blockId) return true;
        }

        return false;
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

    // A shell in the one session, on the machine that the page named: the row that Rex's own picker has at the bottom.
    web.route("POST", "sessions", async (request) => {
        const named = String(request.body.host ?? "");
        const host = named === "" ? await ownHost() : await hostOf(named);
        const label = String(request.body.label ?? "").trim();
        const cwd = String(request.body.cwd ?? "") || homedir();

        const client = await online(host);
        const sessionId = await pocketSession(host);

        // A session that this page is not a viewer of will not own a block for it.
        await client.call("session.attach", { session_id: sessionId });

        const windows = (await view(client, sessionId)).windows ?? [];
        const shell = await newShell(client, host.key, sessionId, label === "" ? POCKET_SESSION : label, cwd, takenOf(windows));

        return { host: host.key, session: sessionId, window: shell.windowId, block: shell.blockId, label: shell.windowLabel };
    });

    web.route("POST", "terminals", async (request) => {
        closeArchived(request.sessions());

        const cols = size(request.body.cols, 20, 400, 80);
        const rows = size(request.body.rows, 5, 200, 24);
        const conversation = Number(request.body.conversation) || 0;

        // A page that names a machine shows a shell on that one, which is what a person picked. A page that names none
        // is this conversation's own terminal, which runs where Pi Pocket runs.
        const named = String(request.body.host ?? "");
        // The bar's New shell: another shell where this one is, rather than the one that is already there.
        const fresh = request.body.new === true;
        // A shell that a person picked on the rail: its session, and the block of the window that they tapped. The
        // shell in it is one that Rex already had.
        const pickedSession = String(request.body.session ?? "").trim();
        const pickedBlock = String(request.body.block ?? "").trim();
        const picked = pickedSession !== "" && pickedBlock !== "";
        const host = named === "" ? await ownHost() : await hostOf(named);
        const client = await online(host);
        let sessionId = picked ? pickedSession : await pocketSession(host);
        let shell: Shell | undefined;

        // A session that this page is not a viewer of will not own a block for it, and a window is no use to a page
        // that cannot see it.
        if (picked) {
            try {
                await client.call("session.attach", { session_id: sessionId });

                shell = await shellAt(client, host.key, sessionId, pickedBlock);
            } catch {
                // The shell that the person picked is gone: the window closed, or the session went with it. The
                // terminal opens the shell of the conversation instead, and the page forgets the choice.
                shell = undefined;
            }
        }

        if (shell === undefined) {
            sessionId = await pocketSession(host);

            await client.call("session.attach", { session_id: sessionId });

            shell = await shellFor(request, host, sessionId, conversation, fresh);
        }

        // One terminal for each shell: a page that reloads finds the one that it left rather than a second stream.
        const existing = [...terminals.values()].find((each) => each.alive && each.hostKey === host.key && each.blockId === shell.blockId);

        if (existing !== undefined) {
            // A window that a conversation renamed carries the new name now, and the bar under the terminal shows it.
            existing.windowLabel = shell.windowLabel;

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

        const terminal = await start(request, host, sessionId, shell, conversation, cols, rows);

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
