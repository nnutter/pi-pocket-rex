/**
 * The two ways that opening a terminal fails without a block: a machine that the list does not have, and a runtime
 * folder that is not there.
 *
 * They are in a file of their own because a run of the test runner that has already opened terminals leaves a WebSocket
 * that it will not open again, and these tests are about what the module says rather than about the runner.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createRex from "../extensions/rex.ts";
import { fakeRex, type FakeRex } from "./fake-rex.ts";
import { fakeWeb, type FakeWeb } from "./fake-web.ts";

const root = join(import.meta.dir, "..");
const made: Array<FakeWeb | FakeRex> = [];
/** The data folders that the modules in this test wrote to, each thrown away with the test that made it. */
const states: string[] = [];

afterEach(async () => {
    const all = made.splice(0);

    for (const each of all) if ("dispose" in each) await each.dispose();
    for (const each of all) if (!("dispose" in each)) each.stop();

    for (const folder of states.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function serve(): FakeRex {
    const server = fakeRex({
        sessions: [{ session_id: "session:1", label: "cosmic-brook" }],
        blocks: [{ block_id: "block:1", creator_name: "com.superlogical.terminal" }],
    });

    made.push(server);

    return server;
}

function module(server: FakeRex, settings: Record<string, string> = {}): FakeWeb {
    // A module remembers what it made in Pi Pocket's data folder, so a test gets a folder of its own: the tests of
    // this repository never write into the folder of the person who runs them.
    const state = mkdtempSync(join(tmpdir(), "rex-state-"));

    process.env.PI_POCKET_DIR = state;
    states.push(state);

    const fake = fakeWeb({
        settings: { local: server.url, runtime: join(root, "src"), ...settings },
        sessions: [{ id: 7, cwd: root, title: "Here", archived: false, updatedAt: 0 }],
    });

    made.push(fake);
    createRex(fake.host as never, fake.web);

    return fake;
}

test("says what to install when the runtime folder is not there", async () => {
    const server = serve();
    const fake = module(server, { runtime: "/nonexistent-rex-runtime" });

    await expect(
        fake.call({
            method: "POST",
            path: "terminals",
            body: { host: server.url, session: "session:1", conversation: 7, cols: 40, rows: 6 },
        }),
    ).rejects.toMatchObject({ status: 503 });
});

test("refuses a machine that the list does not have", async () => {
    const fake = module(serve());

    await expect(
        fake.call({
            method: "POST",
            path: "terminals",
            body: { host: "ws://127.0.0.1:1", session: "session:1", conversation: 7, cols: 40, rows: 6 },
        }),
    ).rejects.toMatchObject({ status: 404 });
});

test("refuses a machine that the list does not have", async () => {
    const fake = module(serve());

    await expect(
        fake.call({
            method: "POST",
            path: "terminals",
            body: { host: "ws://127.0.0.1:1", session: "session:1", conversation: 7, cols: 40, rows: 6 },
        }),
    ).rejects.toMatchObject({ status: 404 });
});

test("says where to add a machine when this machine has no server of its own", async () => {
    const fake = module(serve(), { local: "/nonexistent/rex/server.sock" });

    await expect(
        fake.call({ method: "POST", path: "machines", body: { label: "build", endpoint: "build.example.ts.net" } }),
    ).rejects.toMatchObject({ status: 503 });
});
