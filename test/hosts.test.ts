/**
 * The host list that the picker draws: this machine's server, the hosts that it knows, and the ones that the settings
 * name, each with the sessions under it, and a word for the one that will not answer.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import createRex from "../extensions/rex.ts";
import { fakeRex, type FakeRex } from "./fake-rex.ts";
import { fakeWeb, type FakeWeb } from "./fake-web.ts";

const made: Array<FakeWeb | FakeRex> = [];

afterEach(async () => {
    for (const each of made.splice(0)) {
        if ("dispose" in each) await each.dispose();
        else each.stop();
    }
});

function serve(options: Parameters<typeof fakeRex>[0] = {}): FakeRex {
    const server = fakeRex(options);

    made.push(server);

    return server;
}

function module(settings: Record<string, string> = {}): FakeWeb {
    const fake = fakeWeb({ settings });

    made.push(fake);
    createRex(fake.host as never, fake.web);

    return fake;
}

interface HostRow {
    key: string;
    label: string;
    icon: string;
    endpoint: string;
    local: boolean;
    online: boolean;
    error?: string;
    address: string;
    sessions: Array<{ id: string; label: string; windows: Array<{ id: string; label: string; block: string }> }>;
}

async function hosts(fake: FakeWeb): Promise<HostRow[]> {
    const body = await fake.call<{ hosts: HostRow[] }>({ method: "GET", path: "hosts" });

    return body.hosts;
}

test("lists the server on this machine, and the sessions that it holds", async () => {
    const local = serve({ sessions: [{ session_id: "session:1", label: "cosmic-brook" }] });
    const fake = module({ local: local.url });

    const rows = await hosts(fake);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ local: true, online: true, endpoint: local.url });
    expect(rows[0]!.sessions).toEqual([{ id: "session:1", label: "cosmic-brook", windows: [] }]);
});

test("lists the windows of a session, with the shell that each one holds", async () => {
    const local = serve({
        sessions: [{ session_id: "session:1", label: "Pi Pocket" }],
        windows: {
            "session:1": [
                {
                    window_id: "window:1",
                    label: "Here",
                    blocks: [{ block_id: "block:1", creator_name: "com.superlogical.terminal", label: "Here" }],
                },
                {
                    // A window that a person split for an editor: no terminal, so nothing that a page can draw.
                    window_id: "window:2",
                    label: "notes",
                    blocks: [{ block_id: "block:2", creator_name: "com.superlogical.editor", label: "notes" }],
                },
            ],
        },
    });
    const fake = module({ local: local.url });

    const rows = await hosts(fake);

    expect(rows[0]!.sessions).toEqual([
        {
            id: "session:1",
            label: "Pi Pocket",
            windows: [
                { id: "window:1", label: "Here", block: "block:1" },
                { id: "window:2", label: "notes", block: "" },
            ],
        },
    ]);
});

test("adds the hosts that this machine's server knows, with their own labels and icons", async () => {
    const work = serve({ sessions: [{ session_id: "session:2", label: "calm-pine" }] });
    const local = serve({
        sessions: [{ session_id: "session:1", label: "cosmic-brook" }],
        hosts: [{ id: "host:1", label: "work", icon: "macbook", endpoints: [work.url] }],
    });
    const fake = module({ local: local.url });

    const rows = await hosts(fake);

    expect(rows.map((row) => row.label)).toEqual([expect.any(String), "work"]);
    expect(rows[1]).toMatchObject({ icon: "macbook", online: true });
    expect(rows[1]!.sessions).toEqual([{ id: "session:2", label: "calm-pine", windows: [] }]);
});

test("adds the hosts that the settings name, with the label before the equals sign", async () => {
    const work = serve({ sessions: [{ session_id: "session:2", label: "calm-pine" }] });
    const local = serve();
    const fake = module({ local: local.url, hosts: "build = " + work.url + "\n# a comment\n \n" + local.url });

    const rows = await hosts(fake);

    expect(rows.map((row) => [row.label, row.endpoint])).toEqual([
        [expect.any(String), local.url],
        ["build", work.url],
    ]);
    expect(rows[1]!.sessions).toEqual([{ id: "session:2", label: "calm-pine", windows: [] }]);
});

test("says which host will not answer, and still lists the others", async () => {
    const work = serve({ sessions: [{ session_id: "session:2", label: "calm-pine" }] });
    const fake = module({ hosts: "gone = " + work.url + "\nbuild = ws://127.0.0.1:1" });

    const rows = await hosts(fake);
    const gone = rows.find((row) => row.label === "gone");
    const build = rows.find((row) => row.label === "build");

    expect(gone).toMatchObject({ online: true });
    expect(build).toMatchObject({ online: false, sessions: [] });
    expect(build!.error).toContain("127.0.0.1:1");
});

test("lists one row for an endpoint that both this machine's server and the settings name", async () => {
    const local = serve();
    const fake = module({ local: local.url, hosts: local.url });

    expect(await hosts(fake)).toHaveLength(1);
});

test("lists no host at all when this machine has no server and the settings name none", async () => {
    const fake = module({ local: join("/nonexistent", "rex", "server.sock") });

    expect(await hosts(fake)).toEqual([]);
});
