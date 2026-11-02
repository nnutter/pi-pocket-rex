/**
 * The module against a real pty: it starts the runner, types into the shell, resizes the window, scrolls, and ends it.
 * These tests need Bun and `libghostty-vt` in this repository, which is where the runner runs from.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import createRex from "../extensions/rex.ts";
import { fakeWeb, textOf, type FakeWeb, type FrameEvent } from "./fake-web.ts";

const root = join(import.meta.dir, "..");
const made: FakeWeb[] = [];

function module(
    options: { settings?: Record<string, string>; sessions?: Array<{ id: number; cwd: string; title?: string }> } = {},
) {
    const fake = fakeWeb({
        settings: {
            runtime: join(root, "src"),
            command: "/bin/bash",
            ...options.settings,
        },
        sessions: (options.sessions ?? [{ id: 7, cwd: root }]).map((each) => ({
            ...each,
            title: each.title ?? "Here",
            archived: false,
            updatedAt: 0,
        })),
    });

    createRex(fake.host as never, fake.web);
    made.push(fake);

    return fake;
}

afterEach(async () => {
    for (const fake of made.splice(0)) await fake.dispose();
});

/** Waits for the frame whose text holds `wanted`, and gives that frame back. */
async function screenShows(fake: FakeWeb, wanted: string): Promise<FrameEvent["frame"]> {
    const event = await fake.waitFor<FrameEvent>(
        "frame",
        ({ frame }) => textOf(frame).includes(wanted),
        15_000,
    );

    return event.frame;
}

test("starts a shell in the session's folder and draws what it prints", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string; cwd: string; alive: boolean } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    expect(opened.terminal.cwd).toBe(root);
    expect(opened.terminal.alive).toBe(true);

    const frame = await screenShows(fake, "$");
    expect(frame.cols).toBe(60);
    expect(frame.rows).toBe(12);
});

test("sends keys, text, and a command line to the shell", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: opened.terminal.id },
        body: { text: "echo rex-was-here" },
    });
    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: opened.terminal.id },
        body: { keys: [{ key: "Enter" }] },
    });

    await screenShows(fake, "rex-was-here");

    const frame = await fake.waitFor<FrameEvent>(
        "frame",
        ({ frame }) => textOf(frame).includes("rex-was-here") && textOf(frame).split("\n").length > 1,
        10_000,
    );

    expect(textOf(frame.frame)).toContain("rex-was-here");
});

test("resizes the pty to the columns and rows that the page gives", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    await fake.call({
        method: "POST",
        path: "terminals/:id/resize",
        params: { id: opened.terminal.id },
        body: { cols: 100, rows: 30 },
    });

    const frame = await fake.waitFor<FrameEvent>("frame", ({ frame }) => frame.full && frame.cols === 100 && frame.rows === 30);
    expect(frame.frame.lines.length).toBe(30);

    const listing = await fake.call<{ terminals: Array<{ cols: number; rows: number }> }>({ method: "GET", path: "terminals" });
    expect(listing.terminals[0]).toMatchObject({ cols: 100, rows: 30 });
});

test("lists every shell with the session that it works in, and the most that it keeps", async () => {
    const fake = module({
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: "/", title: "Root" },
        ],
    });

    await fake.call({ method: "POST", path: "terminals", body: { conversation: 7, cols: 60, rows: 12 } });
    await fake.call({ method: "POST", path: "terminals", body: { conversation: 8, cols: 60, rows: 12 } });

    const listing = await fake.call<{
        terminals: Array<{ conversation: number; session: string | null; alive: boolean }>;
        max: number;
    }>({ method: "GET", path: "terminals" });

    // A page that lists them all says whose each one is: the session's title is what a person knows it by.
    expect(listing.terminals.map((each) => [each.conversation, each.session])).toEqual([
        [7, "Here"],
        [8, "Root"],
    ]);
    expect(listing.terminals.every((each) => each.alive)).toBe(true);
    expect(listing.max).toBe(8);
});

test("keeps one terminal for a session, and another for another session", async () => {
    const fake = module({
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: "/", title: "Root" },
        ],
    });

    const first = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });
    const again = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 80, rows: 20 },
    });
    const other = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 8, cols: 60, rows: 12 },
    });

    expect(again.terminal.id).toBe(first.terminal.id);
    expect(other.terminal.id).not.toBe(first.terminal.id);
});

test("keeps a terminal for each session, though their folders are the same", async () => {
    const fake = module({
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root, title: "Another" },
        ],
    });

    const first = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });
    const other = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 8, cols: 60, rows: 12 },
    });
    const again = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    // A shell works in one session: another session in the same folder is another shell, and its own goes with it.
    expect(other.terminal.id).not.toBe(first.terminal.id);
    expect(again.terminal.id).toBe(first.terminal.id);
});

test("ends the shells of a session that is archived, and only that session's", async () => {
    const fake = module({
        sessions: [
            { id: 7, cwd: root },
            { id: 8, cwd: root, title: "Another" },
        ],
    });

    const archived = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });
    const kept = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 8, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    fake.emit("session.archived", { conversationId: 7, archived: true });

    // The shell ends, and its page hears how: a person archived the session, and the shell goes with it.
    const ended = await fake.waitFor<{ id: string }>("exit", ({ id }) => id === archived.terminal.id, 10_000);

    expect(ended.id).toBe(archived.terminal.id);

    const listed = await fake.call<{ terminals: Array<{ id: string }> }>({ method: "GET", path: "terminals" });

    expect(listed.terminals.map((each) => each.id)).toEqual([kept.terminal.id]);
});

test("ends a shell of a session that was archived while the module was not listening", async () => {
    const fake = module();

    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    // The session was archived, and no event reached this module: the session list is what the routes read.
    fake.sessions[0]!.archived = true;

    const listed = await fake.call<{ terminals: Array<{ id: string }> }>({ method: "GET", path: "terminals" });

    expect(listed.terminals).toEqual([]);

    await fake.waitFor<{ id: string }>("exit", ({ id }) => id === opened.terminal.id, 10_000);
});

test("starts no shell for a session that is archived, unless the page asks for one", async () => {
    const fake = module({ sessions: [{ id: 7, cwd: root }] });

    fake.sessions[0]!.archived = true;

    const refused = fake.call({ method: "POST", path: "terminals", body: { conversation: 7, cols: 60, rows: 12 } });

    await expect(refused).rejects.toThrow(/archived/);

    // A person who wants a shell in an archived session says so with the panel's own button.
    const asked = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, new: true, cols: 60, rows: 12 },
    });

    expect(asked.terminal.id).toBeString();
});

test("shows the whole screen to a page that opens on a running terminal", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    const attached = await fake.call<{ frame: FrameEvent["frame"] }>({
        method: "GET",
        path: "terminals/:id",
        params: { id: opened.terminal.id },
    });

    expect(attached.frame.full).toBe(true);
    expect(attached.frame.lines.length).toBe(12);
});

test("ends the shell, and then has no terminal at that address", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");

    await fake.call({
        method: "DELETE",
        path: "terminals/:id",
        params: { id: opened.terminal.id },
    });

    const listing = await fake.call<{ terminals: unknown[] }>({ method: "GET", path: "terminals" });
    expect(listing.terminals).toHaveLength(0);

    await expect(
        fake.call({ method: "GET", path: "terminals/:id", params: { id: opened.terminal.id } }),
    ).rejects.toThrow("No such terminal");
});

test("says what to install when the runtime folder is not there", async () => {
    const fake = module({ settings: { runtime: "/nonexistent-rex-runtime" } });

    const listing = await fake.call<{ bun: boolean; runner: boolean }>({ method: "GET", path: "terminals" });
    expect(listing).toMatchObject({ bun: true, runner: false });

    await expect(
        fake.call({ method: "POST", path: "terminals", body: { conversation: 7, cols: 60, rows: 12 } }),
    ).rejects.toThrow("runtime folder");
});

test("says how a shell ended, with the code that the shell gave", async () => {
    const fake = module();
    const opened = await fake.call<{ terminal: { id: string } }>({
        method: "POST",
        path: "terminals",
        body: { conversation: 7, cols: 60, rows: 12 },
    });

    await screenShows(fake, "$");
    await fake.call({
        method: "POST",
        path: "terminals/:id/input",
        params: { id: opened.terminal.id },
        body: { text: "exit 0\n" },
    });

    const ended = await fake.waitFor<{ id: string; code: number | null }>("exit", ({ id }) => id === opened.terminal.id, 15_000);

    expect(ended.code).toBe(0);

    const after = await fake.call<{ terminal: { alive: boolean; exitCode: number | null } }>({
        method: "GET",
        path: "terminals/:id",
        params: { id: opened.terminal.id },
    });

    expect(after.terminal).toMatchObject({ alive: false, exitCode: 0 });
});

test("refuses a session that its person cannot see", async () => {
    const fake = module();

    await expect(
        fake.call({ method: "POST", path: "terminals", body: { conversation: 999, cols: 60, rows: 12 } }),
    ).rejects.toThrow("That session is not yours to see");
});
