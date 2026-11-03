/**
 * The module against a Rex server that this test writes: the block it takes, the ownership and the size that it sets,
 * the stream that it draws, and the calls that a key, a paste, and a resize make on the control connection.
 *
 * The runner is the real one, with `libghostty-vt` in this repository, so a frame here is the frame a page draws.
 */
import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import createRex, { rexKeyName, rexKeyOf } from "../extensions/rex.ts";
import { fakeRex, type FakeRex } from "./fake-rex.ts";
import { fakeWeb, textOf, type FakeWeb, type FrameEvent } from "./fake-web.ts";

const root = join(import.meta.dir, "..");
const made: Array<FakeWeb | FakeRex> = [];

afterEach(async () => {
    const all = made.splice(0);

    // The module goes first: a server that stops under a connection leaves one in a state that only it knows about.
    for (const each of all) if ("dispose" in each) await each.dispose();
    for (const each of all) if (!("dispose" in each)) each.stop();
});

function serve(options: Parameters<typeof fakeRex>[0] = {}): FakeRex {
    const server = fakeRex({
        sessions: [{ session_id: "session:1", label: "cosmic-brook" }],
        blocks: [{ block_id: "block:1", creator_name: "com.superlogical.terminal", label: "shell" }],
        screen: "seeded\r\n",
        ...options,
    });

    made.push(server);

    return server;
}

function module(server: FakeRex, options: { sessions?: Array<{ id: number; cwd: string; archived?: boolean }> } = {}): FakeWeb {
    const fake = fakeWeb({
        settings: { local: server.url, runtime: join(root, "src") },
        sessions: (options.sessions ?? [{ id: 7, cwd: root }]).map((each) => ({
            ...each,
            title: "Here",
            archived: each.archived ?? false,
            updatedAt: 0,
        })),
    });

    createRex(fake.host as never, fake.web);
    made.push(fake);

    return fake;
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
        body: { host: server.url, session: "session:1", conversation: 7, cols: 40, rows: 6, ...body },
    });
}

/** The methods that the module called, in order. */
function methods(server: FakeRex): string[] {
    return server.requests.map((each) => each.method);
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

test("ends the terminal of a session that is archived, and only that session's", async () => {
    const server = serve({
        sessions: [
            { session_id: "session:1", label: "one" },
            { session_id: "session:2", label: "two" },
        ],
    });
    const fake = module(server, {
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root },
        ],
    });

    const first = await open(fake, server, { session: "session:1", conversation: 7 });
    const second = await open(fake, server, { session: "session:2", conversation: 8 });

    expect(first.terminal.id).not.toBe(second.terminal.id);

    fake.sessions[0]!.archived = true;
    fake.emit("session.archived", { conversationId: 7, archived: true });

    const listing = await fake.call<{ terminals: Summary[] }>({ method: "GET", path: "terminals" });

    // The archived one is gone, and the one on the session that is still open is there.
    expect(listing.terminals.map((each) => each.id)).toEqual([second.terminal.id]);
});

test("makes a terminal in the session's folder when the session has none", async () => {
    const server = serve({ blocks: [] });
    const fake = module(server);

    server.requests.length = 0;

    await open(fake, server);

    const made = server.requests.find((each) => each.method === "session.new_window");

    expect(made).toBeDefined();
    expect(made!.payload).toMatchObject({
        session_id: "session:1",
        layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: root } } },
    });
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

test("makes the conversation's own session when the page names none", async () => {
    const server = serve();
    const fake = module(server);

    server.requests.length = 0;

    const answer = await fake.call<{ terminal: Summary }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 40, rows: 6 },
    });

    const created = server.requests.find((each) => each.method === "session.create");

    expect(created).toBeDefined();
    // The session carries the conversation's name and folder, and its shell starts in that folder.
    expect(created!.payload).toMatchObject({ label: "Here" });
    expect(answer.terminal).toMatchObject({ host: server.url, session: server.made[0]!.session_id, block: "block:made" });
});

test("comes back to the session that already has the conversation's name", async () => {
    const server = serve({ sessions: [{ session_id: "session:1", label: "Here" }] });
    const fake = module(server);

    server.requests.length = 0;

    const answer = await fake.call<{ terminal: Summary }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 40, rows: 6 },
    });

    expect(server.requests.map((each) => each.method)).not.toContain("session.create");
    expect(answer.terminal.session).toBe("session:1");
});

test("starts a session for the picker's own row, and says where it is", async () => {
    const server = serve();
    const fake = module(server);

    const answer = await fake.call<{ host: string; session: string; label: string }>({
        method: "POST",
        path: "sessions",
        body: {},
    });

    expect(answer).toMatchObject({ host: server.url, session: "session:made-1", label: "made" });

    const created = server.requests.find((each) => each.method === "session.create");

    expect(created!.payload).toMatchObject({
        initial_windows: [
            {
                layout: {
                    block: {
                        flavor: "com.superlogical.terminal.shell",
                        // A session that a person starts by hand begins in their home, as Rex's own picker does.
                        options: { cwd: homedir() },
                    },
                },
            },
        ],
    });
});
