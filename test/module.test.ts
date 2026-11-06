/**
 * The module against a Rex server that this test writes: the block it takes, the ownership and the size that it sets,
 * the stream that it draws, and the calls that a key, a paste, and a resize make on the control connection.
 *
 * The runner is the real one, with `libghostty-vt` in this repository, so a frame here is the frame a page draws.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import createRex, { rexKeyName, rexKeyOf } from "../extensions/rex.ts";
import { fakeRex, type FakeRex, type FakeWindow } from "./fake-rex.ts";
import { RexCallError } from "../extensions/_rex-client.ts";
import { fakeWeb, textOf, type FakeWeb, type FrameEvent } from "./fake-web.ts";

const root = join(import.meta.dir, "..");

/** The window that the conversation in these tests has in Pi Pocket's session: what a restart leaves in Rex. */
function here(): FakeWindow {
    return {
        window_id: "window:1",
        label: "Here",
        blocks: [{ block_id: "block:1", creator_name: "com.superlogical.terminal", label: "Here" }],
    };
}

/** A shell that a person started in Rex, in a window of a session of their own: one that this module only watches. */
function theirs(): FakeWindow {
    return {
        window_id: "window:2",
        label: "Their own",
        blocks: [{ block_id: "block:2", creator_name: "com.superlogical.terminal", label: "Their own" }],
    };
}

/** A window that a person opened in Pi Pocket's session, with a block that this module did not make. */
const editor: FakeWindow = {
    window_id: "window:9",
    label: "editor",
    blocks: [{ block_id: "block:9", creator_name: "com.superlogical.editor", label: "editor" }],
};

const made: Array<FakeWeb | FakeRex> = [];
/** The data folders that the modules in this test wrote to, each thrown away with the test that made it. */
const states: string[] = [];

afterEach(async () => {
    const all = made.splice(0);

    // The module goes first: a server that stops under a connection leaves one in a state that only it knows about.
    for (const each of all) if ("dispose" in each) await each.dispose();
    for (const each of all) if (!("dispose" in each)) each.stop();
    for (const folder of states.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function serve(options: Parameters<typeof fakeRex>[0] = {}): FakeRex {
    const server = fakeRex({
        // The session that Pi Pocket keeps on the machine, with the window of the conversation in these tests: the
        // conversation is number 7, and its title is what the window is called.
        sessions: [{ session_id: "session:1", label: "Pi Pocket" }],
        windows: { "session:1": [here()] },
        screen: "seeded\r\n",
        ...options,
    });

    made.push(server);

    return server;
}

function module(
    server: FakeRex,
    options: {
        sessions?: Array<{ id: number; cwd: string; title?: string; archived?: boolean }>;
        /**
         * What the module made before this run, as a data folder that a restart left it would hold it: the machine, and
         * then the sessions with the blocks in each, or the sessions alone that the first version of the ledger kept.
         */
        ledger?: Record<string, string[] | Record<string, string[]>>;
    } = {},
): FakeWeb & { state: string } {
    // A module remembers what it made in Pi Pocket's data folder, so each one here gets its own: no test reads
    // another's ledger, and none of them writes into the person's own folder.
    const state = mkdtempSync(join(tmpdir(), "rex-state-"));

    process.env.PI_POCKET_DIR = state;
    states.push(state);

    if (options.ledger !== undefined) {
        mkdirSync(join(state, "rex"), { recursive: true });
        writeFileSync(join(state, "rex", "made.json"), JSON.stringify(options.ledger));
    }

    const fake = fakeWeb({
        settings: { local: server.url, runtime: join(root, "src") },
        sessions: (options.sessions ?? [{ id: 7, cwd: root }]).map((each) => ({
            ...each,
            title: each.title ?? "Here",
            archived: each.archived ?? false,
            updatedAt: 0,
        })),
    });

    createRex(fake.host as never, fake.web);
    made.push(fake);

    return Object.assign(fake, { state });
}

/**
 * The ledger that a module in this test wrote: the blocks that it opened, by the machine that holds them and the session
 * that they are in. A ledger from the version that kept sessions alone reads as sessions with no blocks.
 */
function ledgerOf(state: string): Record<string, Record<string, string[]>> {
    const held = JSON.parse(readFileSync(join(state, "rex", "made.json"), "utf8")) as Record<string, unknown>;
    const kept: Record<string, Record<string, string[]>> = {};

    for (const [host, made] of Object.entries(held)) {
        const sessions: Record<string, string[]> = {};

        if (Array.isArray(made)) {
            for (const each of made) sessions[String(each)] = [];
        } else if (made !== null && typeof made === "object") {
            for (const [sessionId, blocks] of Object.entries(made as Record<string, unknown>)) {
                sessions[sessionId] = Array.isArray(blocks) ? blocks.map(String) : [];
            }
        }

        kept[host] = sessions;
    }

    return kept;
}

interface Summary {
    id: string;
    host: string;
    session: string;
    block: string;
    cols: number;
    rows: number;
    alive: boolean;
}

async function open(fake: FakeWeb, server: FakeRex, body: Record<string, unknown> = {}) {
    return fake.call<{ terminal: Summary; frame: FrameEvent["frame"] }>({
        method: "POST",
        path: "terminals",
        body: { host: server.url, conversation: 7, cols: 40, rows: 6, ...body },
    });
}

/** The methods that the module called, in order. */
function methods(server: FakeRex): string[] {
    return server.requests.map((each) => each.method);
}

/** Waits for a call that the module makes on its own, after the grace that it keeps. */
async function until(server: FakeRex, method: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!methods(server).includes(method)) {
        if (Date.now() > deadline) throw new Error(`The module never called ${method}`);

        await Bun.sleep(50);
    }
}

test("takes the session's terminal block, and draws its screen", async () => {
    const server = serve();
    const fake = module(server);

    const answer = await open(fake, server);

    expect(answer.terminal).toMatchObject({ host: server.url, session: "session:1", block: "block:1", cols: 40, rows: 6 });
    expect(methods(server)).toContain("session.attach");
    expect(methods(server)).toContain("session.own_block");
    expect(methods(server)).toContain("com.superlogical.terminal.resize");
    expect(methods(server)).toContain("com.superlogical.terminal.format");

    // The first frame is what the terminal already had on its screen.
    await fake.waitFor<FrameEvent>("frame", (event) => textOf(event.frame).includes("seeded"));
});

test("draws the stream after the snapshot that it starts with", async () => {
    const server = serve({ screen: "" });
    const fake = module(server);

    await open(fake, server);

    // A fresh stream: the whole screen in Ghostty's format, then Rex's own message, then the program's bytes.
    server.push(new TextEncoder().encode('GHOSTSNP\u0001\u0000binary junk\u001b_rex1;7;{"type":"resize"}\u001b\\'));
    server.push(new TextEncoder().encode("from the stream\r\n"));

    const frame = await fake.waitFor<FrameEvent>("frame", (event) => textOf(event.frame).includes("from the stream"));

    expect(textOf(frame.frame)).not.toContain("GHOSTSNP");
});

test("types text, and sends keys and pastes as the events that a block takes", async () => {
    const server = serve();
    const fake = module(server);

    const { terminal } = await open(fake, server);

    server.requests.length = 0;

    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: terminal.id },
        body: { text: "ls -la\r", keys: [{ key: "KeyC", mods: { ctrl: true }, utf8: "" }] },
    });

    expect(server.requests[0]).toMatchObject({
        method: "com.superlogical.terminal.write",
        payload: { session_id: "session:1", block_id: "block:1", args: { data: "ls -la\r" } },
    });
    expect(server.requests[1]).toMatchObject({
        method: "block.event",
        payload: {
            session_id: "session:1",
            block_id: "block:1",
            event: { type: "key", payload: { key: "key_c", mods: "ctrl", action: "press", text: "", unshifted_codepoint: 99 } },
        },
    });

    await fake.call({
        method: "POST",
        path: "terminals/:id/paste",
        params: { id: terminal.id },
        body: { text: "echo pasted\r" },
    });

    expect(server.requests.at(-1)).toMatchObject({
        method: "block.event",
        payload: { event: { type: "paste", payload: { text: "echo pasted\r" } } },
    });
});

test("puts the view at the prompt before it types, wherever a page left it", async () => {
    const server = serve();
    const fake = module(server);

    const { terminal } = await open(fake, server);

    // Rex's own message first, since the stream before it is the snapshot of a screen that no screen takes; then more
    // lines than the screen's rows, so that the first of them goes above the screen, into the scrollback.
    server.push(new TextEncoder().encode('\u001b_rex1;7;{"type":"resize"}\u001b\\'));
    server.push(new TextEncoder().encode(Array.from({ length: 20 }, (_, at) => `line ${at}\r\n`).join("")));

    const drawn = await fake.waitFor<FrameEvent>("frame", (event) => textOf(event.frame).includes("line 19"));

    await fake.call({
        method: "POST",
        path: "terminals/:id/scroll",
        params: { id: terminal.id },
        body: { to: "top" },
    });

    const top = await fake.waitFor<FrameEvent>(
        "frame",
        (event) => event.frame.seq > drawn.frame.seq && textOf(event.frame).includes("line 0"),
    );

    expect(textOf(top.frame)).toContain("line 0");

    // A key, from a page that may not be the one that scrolled: what it types goes to a line that is in sight.
    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: terminal.id },
        body: { text: "x" },
    });

    const back = await fake.waitFor<FrameEvent>(
        "frame",
        (event) => event.frame.seq > top.frame.seq && textOf(event.frame).includes("line 19"),
    );

    expect(textOf(back.frame)).toContain("line 19");
});

test("resizes both the screen and the terminal in Rex", async () => {
    const server = serve();
    const fake = module(server);

    const { terminal } = await open(fake, server);

    server.requests.length = 0;

    const answer = await fake.call<{ ok: boolean; cols: number; rows: number }>({
        method: "POST",
        path: "terminals/:id/resize",
        params: { id: terminal.id },
        body: { cols: 100, rows: 30 },
    });

    expect(answer).toEqual({ ok: true, cols: 100, rows: 30 });
    expect(server.requests.at(-1)).toMatchObject({
        method: "com.superlogical.terminal.resize",
        payload: { args: { columns: 100, rows: 30 } },
    });

    // The page's size is the one that the terminal has: a frame of the same size comes back.
    const frame = await fake.waitFor<FrameEvent>("frame", (event) => event.frame.cols === 100 && event.frame.rows === 30);

    expect(frame.frame.rows).toBe(30);
});

test("lists the terminals that it holds, with the machine that each is on", async () => {
    const server = serve();
    const fake = module(server);

    const { terminal } = await open(fake, server);

    const listing = await fake.call<{ terminals: Array<Summary & { hostLabel: string }>; max: number }>({
        method: "GET",
        path: "terminals",
    });

    expect(listing.max).toBe(8);
    expect(listing.terminals).toHaveLength(1);
    expect(listing.terminals[0]).toMatchObject({ id: terminal.id, host: server.url, alive: true });
});

test("gives the block back when a person ends the terminal, and leaves the Rex session running", async () => {
    const server = serve();
    const fake = module(server);

    const { terminal } = await open(fake, server);

    server.requests.length = 0;

    await fake.call({ method: "DELETE", path: "terminals/:id", params: { id: terminal.id } });

    // The block is given back without waiting for it, so that a person's tap is not held by a round trip.
    await Bun.sleep(50);

    expect(server.requests.map((each) => each.method)).toContain("session.disown_block");
    expect(server.requests.map((each) => each.method)).not.toContain("session.destroy");

    await expect(fake.call({ method: "GET", path: "terminals/:id", params: { id: terminal.id } })).rejects.toMatchObject({
        status: 404,
    });
});

test("ends the terminal of a conversation that is archived, and only that conversation's", async () => {
    const server = serve();
    const fake = module(server, {
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root, title: "Elsewhere" },
        ],
    });

    const first = await open(fake, server, { conversation: 7 });
    const second = await open(fake, server, { conversation: 8 });

    expect(first.terminal.id).not.toBe(second.terminal.id);
    // One session, and a window in it for each conversation.
    expect(second.terminal.session).toBe(first.terminal.session);

    fake.sessions[0]!.archived = true;
    fake.emit("session.archived", { conversationId: 7, archived: true });

    const listing = await fake.call<{ terminals: Summary[] }>({ method: "GET", path: "terminals" });

    // The archived one is gone, and the one on the conversation that is still open is there.
    expect(listing.terminals.map((each) => each.id)).toEqual([second.terminal.id]);
});

test("shows the shell of a window that Rex already holds, without taking it from Rex", async () => {
    const server = serve({ windows: { "session:1": [here(), theirs()] } });
    const fake = module(server);

    const { terminal } = await open(fake, server, { session: "session:1", block: "block:2" });

    expect(terminal).toMatchObject({ session: "session:1", block: "block:2" });
    expect(terminal).toMatchObject({ windowLabel: "Their own" });

    // The shell is the one that was there: no second one, and no owner taken from the app that shows it.
    expect(methods(server)).not.toContain("session.new_window");
    expect(methods(server)).not.toContain("session.own_block");

    // A terminal watches it: a key reaches the block that it was already writing to, and it is the same one after.
    server.requests.length = 0;

    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: terminal.id },
        body: { text: "echo\r" },
    });

    expect(server.requests[0]).toMatchObject({
        method: "com.superlogical.terminal.write",
        payload: { session_id: "session:1", block_id: "block:2" },
    });
});

test("does not take back a window that Rex held, when a person ends its terminal", async () => {
    const server = serve({ windows: { "session:1": [here(), theirs()] } });
    const fake = module(server);

    const { terminal } = await open(fake, server, { session: "session:1", block: "block:2" });

    server.requests.length = 0;

    await fake.call({ method: "DELETE", path: "terminals/:id", params: { id: terminal.id } });

    // The block was never this module's, so there is nothing to give back, and nothing to remember either.
    expect(methods(server)).not.toContain("session.disown_block");

    const remembered = existsSync(join(fake.state, "rex", "made.json")) ? ledgerOf(fake.state)[server.url] ?? {} : {};

    expect(JSON.stringify(remembered)).not.toContain("block:2");
});

test("leaves the shell of a window that Rex holds running when the conversation is archived", async () => {
    const server = serve({ windows: { "session:1": [here(), theirs()] } });
    const fake = module(server);

    await open(fake, server, { session: "session:1", block: "block:2" });

    server.requests.length = 0;

    fake.emit("session.archived", { conversationId: 7, archived: true });

    await Bun.sleep(300);

    // The window is another program's: an archived conversation stops watching it, and closes nothing.
    expect(methods(server)).not.toContain("block.close");
    expect(methods(server)).not.toContain("session.close_window");
});

test("keeps the connection in the session that a terminal of another conversation still uses", async () => {
    const server = serve();
    const fake = module(server, {
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root, title: "Elsewhere" },
        ],
    });

    await open(fake, server, { conversation: 7 });
    const other = await open(fake, server, { conversation: 8 });

    server.requests.length = 0;

    fake.emit("session.archived", { conversationId: 7, archived: true });

    await until(server, "block.close");
    await Bun.sleep(300);

    // The session stays, because the other conversation's shell is in it, and so does the connection that every call
    // for that shell goes over.
    expect(methods(server)).not.toContain("session.destroy");
    expect(methods(server)).not.toContain("session.detach");

    server.requests.length = 0;

    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: other.terminal.id },
        body: { text: "echo\r" },
    });

    expect(server.requests[0]).toMatchObject({ method: "com.superlogical.terminal.write" });
});

test("closes the shell of a session that is archived, and the session that it leaves empty", async () => {
    const server = serve();
    // The session is one that this module made, as a run that a crash ended would have written it down.
    const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

    await open(fake, server);

    server.requests.length = 0;

    fake.emit("session.archived", { conversationId: 7, archived: true });

    await until(server, "session.destroy");

    // The block closes first: a session is empty only after the block that was in it has gone.
    expect(server.requests.find((each) => each.method === "block.close")).toMatchObject({
        payload: { session_id: "session:1", block_id: "block:1" },
    });
    expect(methods(server).indexOf("block.close")).toBeLessThan(methods(server).indexOf("session.destroy"));

    // An archived conversation leaves no session behind, and nothing for a later look to ask about.
    expect(server.requests.find((each) => each.method === "session.destroy")).toMatchObject({
        payload: { session_id: "session:1" },
    });
    expect(ledgerOf(fake.state)).toEqual({});
});

test("keeps the session that another program is still in, when the conversation is archived", async () => {
    // A person put a window of their own in Pi Pocket's session, with a program that is not this module's.
    const server = serve({ windows: { "session:1": [here(), editor] } });
    const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

    await open(fake, server);

    server.requests.length = 0;

    fake.emit("session.archived", { conversationId: 7, archived: true });

    await until(server, "session.detach");

    // The shell that the conversation showed closes, and the program that a person started in Rex stays.
    expect(methods(server)).toContain("block.close");
    expect(methods(server)).not.toContain("session.destroy");
    expect(ledgerOf(fake.state)).toEqual({ [server.url]: { "session:1": [] } });
});

test("makes a window in the conversation's folder when the session has none for it", async () => {
    const server = serve({ windows: {} });
    const fake = module(server);

    server.requests.length = 0;

    const answer = await open(fake, server);

    const made = server.requests.find((each) => each.method === "session.new_window");

    expect(made).toBeDefined();
    // The window is named after the conversation, and its shell starts in the conversation's folder.
    expect(made!.payload).toMatchObject({
        session_id: "session:1",
        window_label: "Here",
        layout: { block: { flavor: "com.superlogical.terminal.shell", label: "Here", options: { cwd: root } } },
    });
    expect(answer.terminal).toMatchObject({ session: "session:1", block: "block:made-1", windowLabel: "Here" });
});

test("names a key the way that a Rex terminal does", () => {
    expect(rexKeyName("KeyA")).toBe("key_a");
    expect(rexKeyName("Digit0")).toBe("digit_0");
    expect(rexKeyName("ArrowUp")).toBe("arrow_up");
    expect(rexKeyName("PageDown")).toBe("page_down");
    expect(rexKeyName("F5")).toBe("f5");
    expect(rexKeyName("Escape")).toBe("escape");
    expect(rexKeyName("NumpadAdd")).toBe("numpad_add");
    expect(rexKeyName("LaunchApp1")).toBe("launch_app_1");
    expect(rexKeyName("SomethingNew")).toBe("unidentified");
});

test("sends a key with the modifiers in the order that Rex reads them", () => {
    expect(rexKeyOf({ key: "KeyN", mods: { ctrl: true, shift: true, alt: true, super: true }, utf8: "" })).toEqual({
        action: "press",
        key: "key_n",
        mods: "shift+ctrl+alt+super",
        consumed_mods: "",
        text: "",
        unshifted_codepoint: 110,
        composing: false,
    });

    expect(rexKeyOf({ key: "Enter" })).toMatchObject({ key: "enter", mods: "", unshifted_codepoint: 0 });
    expect(rexKeyOf({ key: "KeyA", utf8: "a" })).toMatchObject({ text: "a" });
});

test("makes the Pi Pocket session when the machine has none", async () => {
    const server = serve({ sessions: [], windows: {} });
    const fake = module(server);

    server.requests.length = 0;

    const answer = await fake.call<{ terminal: Summary }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 40, rows: 6 },
    });

    const created = server.requests.find((each) => each.method === "session.create");

    expect(created).toBeDefined();
    // The session is the one that a person sees as Pi Pocket, and the conversation gets a window in it.
    expect(created!.payload).toMatchObject({ label: "Pi Pocket" });
    expect(answer.terminal).toMatchObject({ host: server.url, session: "session:made-1", block: "block:made-1" });
});

test("comes back to the window that already carries the conversation's name", async () => {
    const server = serve();
    const fake = module(server);

    server.requests.length = 0;

    const answer = await open(fake, server);

    // The session keeps the shell that it already has, so the page comes back to the one it left.
    expect(methods(server)).not.toContain("session.create");
    expect(methods(server)).not.toContain("session.new_window");
    expect(answer.terminal).toMatchObject({ session: "session:1", block: "block:1", windowLabel: "Here" });
});

test("gives a conversation of another name a window of its own", async () => {
    const server = serve();
    const fake = module(server, {
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root, title: "Elsewhere" },
        ],
    });

    await open(fake, server, { conversation: 7 });
    server.requests.length = 0;

    const answer = await open(fake, server, { conversation: 8 });

    // A window of another name is another conversation's, so this one gets a window that is named after itself.
    expect(server.requests.find((each) => each.method === "session.new_window")!.payload).toMatchObject({
        session_id: "session:1",
        window_label: "Elsewhere",
    });
    expect(answer.terminal).toMatchObject({ session: "session:1", block: "block:made-1" });
});

test("starts a window for the picker's own row, and says where it is", async () => {
    const server = serve();
    const fake = module(server);

    server.requests.length = 0;

    const answer = await fake.call<{ host: string; session: string; window: string; block: string; label: string }>({
        method: "POST",
        path: "sessions",
        body: {},
    });

    // The picker's own row is a shell of its own in the session that Pi Pocket keeps, and the page opens on the window
    // that the row made rather than on the one that the conversation already had.
    expect(answer).toMatchObject({ host: server.url, session: "session:1", label: "Pi Pocket" });
    expect(typeof answer.block).toBe("string");
    expect(answer.block.startsWith("block:")).toBe(true);

    expect(server.requests.find((each) => each.method === "session.new_window")!.payload).toMatchObject({
        session_id: "session:1",
        window_label: "Pi Pocket",
        layout: {
            block: {
                flavor: "com.superlogical.terminal.shell",
                // A shell that a person starts by hand begins in their home, as Rex's own picker does.
                options: { cwd: homedir() },
            },
        },
    });
});

test("remembers the session that it made, with the shells that it opened in it", async () => {
    // A machine that ran Rex before this module: the session is the module's to make.
    const server = serve({ sessions: [], windows: {} });
    const fake = module(server);

    // The conversation's own shell, and the picker's own row: one session holds both of them.
    const own = await fake.call<{ terminal: Summary }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 40, rows: 6 },
    });
    const picked = await fake.call<{ session: string }>({ method: "POST", path: "sessions", body: {} });

    const held = ledgerOf(fake.state)[server.url] ?? {};

    expect(Object.keys(held)).toEqual([own.terminal.session]);
    expect(picked.session).toBe(own.terminal.session);
    // The session holds both shells, so a look after a restart knows both of them.
    expect(held[own.terminal.session]).toHaveLength(2);
    expect(held[own.terminal.session]).toContain(own.terminal.block);
});

test("adds a machine to the list that Rex keeps, so that Rex.app shows it too", async () => {
    const server = serve();
    const fake = module(server);

    server.requests.length = 0;

    const answer = await fake.call<{ ok: boolean; label: string; endpoint: string }>({
        method: "POST",
        path: "machines",
        body: { label: " build ", endpoint: " build.example.ts.net " },
    });

    expect(answer).toMatchObject({ ok: true, label: "build", endpoint: "build.example.ts.net" });
    expect(server.requests[0]).toMatchObject({
        method: "hosts.put",
        payload: { host: { label: "build", endpoints: ["build.example.ts.net"], added_from: "Pi Pocket" } },
    });
});

test("asks for a machine's name and its address", async () => {
    const server = serve();
    const fake = module(server);

    await expect(fake.call({ method: "POST", path: "machines", body: { label: "build" } })).rejects.toMatchObject({
        status: 400,
    });
});

test("starts another window in the same folder when the bar asks for a new shell", async () => {
    const server = serve();
    const fake = module(server);

    const first = await open(fake, server);

    server.requests.length = 0;

    const second = await open(fake, server, { new: true });

    // The new shell is a window of its own, and its name leaves the name that a reload comes back to alone.
    expect(server.requests.find((each) => each.method === "session.new_window")!.payload).toMatchObject({
        session_id: "session:1",
        window_label: "Here 2",
    });
    expect(second.terminal.session).toBe(first.terminal.session);
    expect(second.terminal.block).not.toBe(first.terminal.block);
});

/**
 * The last tab of the app: the shells that it watched are the ones that no tab is watching any more.
 *
 * Rex keeps a session that has lost its last block, so a shell that outlives the page that opened it keeps a session in
 * Rex that nothing will ever close. A tab says that it is here, and says goodbye when it goes, and the module ends what
 * the last one left after a moment that a reload's hello can still take back.
 */
describe("the tabs of the app", () => {
    /** The module's grace for a tab that comes back, which these tests wait out: it is the promise that they hold. */
    const GRACE = 10_000;

    const said = (fake: FakeWeb, path: string, body: Record<string, unknown> = {}) =>
        fake.call({ method: "POST", path, body });

    test(
        "ends the blocks of the last tab that goes, and the sessions that they leave empty",
        async () => {
            // Two machines: one session holds only the block that this module opened, and one holds a block that a
            // person started in Rex beside it.
            const alone = serve();
            const shared = serve({ windows: { "session:1": [here(), editor] } });
            // Each remembers the session that it watched, as a run that a crash ended would.
            const mine = module(alone, { ledger: { [alone.url]: ["session:1"] } });
            const theirs = module(shared, { ledger: { [shared.url]: ["session:1"] } });

            await open(mine, alone);
            await open(theirs, shared);

            alone.requests.length = 0;
            shared.requests.length = 0;

            await said(mine, "tabs", { tab: "laptop" });
            await said(mine, "tabs/gone", { tab: "laptop" });

            // The page reloads: its hello comes a moment after its goodbye, and the shells are not the price of a
            // reload.
            await said(mine, "tabs", { tab: "laptop" });
            await Bun.sleep(GRACE + 300);

            expect(methods(alone)).not.toContain("block.close");

            await said(mine, "tabs/gone", { tab: "laptop" });
            await said(theirs, "tabs", { tab: "phone" });
            await said(theirs, "tabs/gone", { tab: "phone" });

            await until(alone, "session.destroy");
            await until(shared, "block.close");

            // The block closes first: the session is only empty after that, and destroying it earlier would close the
            // blocks of another program too.
            expect(methods(alone)).toContain("block.close");
            expect(methods(alone).indexOf("block.close")).toBeLessThan(methods(alone).indexOf("session.destroy"));
            expect(alone.requests.find((each) => each.method === "session.destroy")).toMatchObject({
                payload: { session_id: "session:1" },
            });

            // The session that another block still lives in stays, and the block that this module opened closes.
            await Bun.sleep(300);

            expect(methods(shared)).toContain("block.close");
            expect(methods(shared)).not.toContain("session.destroy");

            // The ledger is done with the session that it closed, and it keeps the one that stayed.
            expect(ledgerOf(mine.state)).toEqual({});
            expect(ledgerOf(theirs.state)).toEqual({ [shared.url]: { "session:1": [] } });
        },
        GRACE + 30_000,
    );

    test("keeps the shells while a tab is here, whatever the others do", async () => {
        const server = serve();
        const fake = module(server);

        await open(fake, server);
        server.requests.length = 0;

        await said(fake, "tabs", { tab: "laptop" });
        await said(fake, "tabs", { tab: "phone" });
        await said(fake, "tabs/gone", { tab: "phone" });

        // The tab that is left is enough: nothing waits to end what it is watching.
        await Bun.sleep(300);

        expect(methods(server)).not.toContain("block.close");
    }, 30_000);

    /**
     * A tab that dies says no goodbye, so the session that it left with no block in it stays in Rex until something
     * looks for it. The next tab that says hello is that look, and it ends only what this module made.
     */
    test("ends the session that a tab which died left empty, when the next tab says hello", async () => {
        const server = serve({ windows: {} });
        const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

        server.requests.length = 0;

        await said(fake, "tabs", { tab: "phone" });
        await until(server, "session.destroy");

        expect(server.requests.find((each) => each.method === "session.destroy")).toMatchObject({
            payload: { session_id: "session:1" },
        });
        expect(ledgerOf(fake.state)).toEqual({});
    }, 30_000);

    test("closes the block that a tab which died left, and keeps the session that holds another block", async () => {
        const server = serve({ windows: { "session:1": [here(), editor] } });
        // The shell of a tab that died: the ledger knows the block, and no terminal holds it any more.
        const fake = module(server, { ledger: { [server.url]: { "session:1": ["block:1"] } } });

        await said(fake, "tabs", { tab: "phone" });
        await until(server, "block.close");

        expect(server.requests.find((each) => each.method === "block.close")).toMatchObject({
            payload: { session_id: "session:1", block_id: "block:1" },
        });

        // The editor that a person started is not this module's to close, and it keeps the session.
        await Bun.sleep(300);

        expect(methods(server)).not.toContain("session.destroy");
        expect(ledgerOf(fake.state)).toEqual({ [server.url]: { "session:1": [] } });
    }, 30_000);

    test("keeps the block that a terminal of this module holds", async () => {
        const server = serve();
        const fake = module(server, { ledger: { [server.url]: { "session:1": [] } } });

        await open(fake, server);
        server.requests.length = 0;

        await said(fake, "tabs", { tab: "phone" });
        await Bun.sleep(300);

        // The tab that is here is watching that block, so the look after the ledger leaves it alone.
        expect(methods(server)).not.toContain("block.close");
    }, 30_000);

    test("keeps a block that Rex would not close, so that a later look can try again", async () => {
        const server = serve({
            blocks: [{ block_id: "block:1", creator_name: "com.superlogical.terminal" }],
            answer: (method) => {
                if (method === "block.close") throw new RexCallError("conflict", "The block is busy", 409);

                return undefined;
            },
        });
        const fake = module(server, { ledger: { [server.url]: { "session:1": ["block:1"] } } });

        await said(fake, "tabs", { tab: "phone" });
        await until(server, "block.close");
        await Bun.sleep(300);

        // A block that stays open stays in the ledger: the next look after the restart knows where to start.
        expect(ledgerOf(fake.state)).toEqual({ [server.url]: { "session:1": ["block:1"] } });
    }, 30_000);

    test("leaves a session that still holds a block", async () => {
        const server = serve();
        const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

        await said(fake, "tabs", { tab: "phone" });
        await until(server, "session.detach");

        expect(methods(server)).not.toContain("session.destroy");
        expect(ledgerOf(fake.state)).toEqual({ [server.url]: { "session:1": [] } });
    }, 30_000);

    test("leaves an empty session that it did not make", async () => {
        const server = serve({ blocks: [] });
        const fake = module(server);

        await said(fake, "tabs", { tab: "phone" });
        await Bun.sleep(300);

        // Nothing in the ledger is nothing to look at, so not even the session that a person made is asked about.
        expect(methods(server)).not.toContain("session.attach");
        expect(methods(server)).not.toContain("session.destroy");
    }, 30_000);

    test("forgets a session that Rex no longer has", async () => {
        const server = serve({ sessions: [] });
        const fake = module(server, { ledger: { [server.url]: ["session:gone"] } });

        await said(fake, "tabs", { tab: "phone" });
        await Bun.sleep(300);

        expect(methods(server)).not.toContain("session.destroy");
        expect(ledgerOf(fake.state)).toEqual({});
    }, 30_000);

    test("leaves the session that a terminal of its own is in", async () => {
        const server = serve();
        const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

        await open(fake, server);
        server.requests.length = 0;

        await said(fake, "tabs", { tab: "phone" });
        await Bun.sleep(300);

        // The terminal is in it, so the session is this module's to keep, whatever the ledger says.
        expect(methods(server)).not.toContain("session.attach");
        expect(methods(server)).not.toContain("session.detach");
    }, 30_000);

    test("looks at the ledger once, however many tabs say hello", async () => {
        const server = serve();
        const fake = module(server, { ledger: { [server.url]: ["session:1"] } });

        await said(fake, "tabs", { tab: "phone" });
        await until(server, "session.detach");

        server.requests.length = 0;
        await said(fake, "tabs", { tab: "laptop" });
        await Bun.sleep(300);

        expect(methods(server)).not.toContain("session.attach");
    }, 30_000);
});
