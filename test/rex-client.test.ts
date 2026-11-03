/**
 * The Rex client against a server that this test writes: the hello that it sends, the requests that it pairs with their
 * answers, the events that it hands to the module, and the failure that it turns a server's error into.
 *
 * The server is a `Bun.serve` WebSocket, not a Rex server, so the test needs no Rex and no network beyond the loopback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { endpointCandidates, RexCallError, RexClient, type RexEvent } from "../extensions/_rex-client.ts";
import { fakeRex } from "./fake-rex.ts";

const open: Array<{ stop: () => void }> = [];
const clients: RexClient[] = [];

function client(url: string, options: { app?: { name: string; version: string } } = {}): RexClient {
    const made = new RexClient({ endpoint: url, timeoutMs: 3000, ...options });

    clients.push(made);

    return made;
}

afterEach(() => {
    for (const made of clients.splice(0)) made.close();
    for (const server of open.splice(0)) server.stop();
});

function serve(options: Parameters<typeof fakeRex>[0] = {}) {
    const server = fakeRex(options);

    open.push(server);

    return server;
}

describe("the endpoint that a person writes", () => {
    test("takes a Unix socket as a path, or as unix://", () => {
        expect(endpointCandidates("/run/user/1000/rex/server.sock")).toEqual([
            { base: "ws://localhost", socketPath: "/run/user/1000/rex/server.sock" },
        ]);
        expect(endpointCandidates("unix:///tmp/rex.sock")).toEqual([{ base: "ws://localhost", socketPath: "/tmp/rex.sock" }]);
    });

    test("keeps a URL that a person wrote, and the port with it", () => {
        expect(endpointCandidates("wss://studio.ts.net")).toEqual([{ base: "wss://studio.ts.net" }]);
        expect(endpointCandidates("https://studio.ts.net:7297")).toEqual([{ base: "wss://studio.ts.net:7297" }]);
        expect(endpointCandidates("http://studio.ts.net")).toEqual([
            { base: "wss://studio.ts.net" },
            { base: "wss://studio.ts.net:7297" },
            { base: "ws://studio.ts.net:7297" },
        ]);
    });

    test("tries a bare host the way that the CLI does", () => {
        // HTTPS on 443, then HTTPS on the tailnet port, then HTTP on it: what `rex -S` tries.
        expect(endpointCandidates("studio.ts.net")).toEqual([
            { base: "wss://studio.ts.net" },
            { base: "wss://studio.ts.net:7297" },
            { base: "ws://studio.ts.net:7297" },
        ]);
        expect(endpointCandidates(" studio.ts.net/ ")).toEqual(endpointCandidates("studio.ts.net"));
        expect(endpointCandidates("")).toEqual([]);
    });
});

describe("the control connection", () => {
    test("sends the hello that the protocol asks for, and takes the welcome", async () => {
        const server = serve();
        const rex = client(server.url, { app: { name: "Pi Pocket", version: "1.2.3" } });

        const welcome = await rex.connect();

        expect(welcome.protocol).toBe("rex.control.v1");
        expect(welcome.api_revision).toBe(7);
        expect(rex.connected).toBe(true);

        // The welcome comes when the socket opens, so the hello that follows it is a separate turn.
        await Bun.sleep(50);

        expect(server.hellos).toHaveLength(1);
        expect(server.hellos[0]).toMatchObject({
            type: "hello",
            api_revision: 7,
            client: { kind: "app", name: "Pi Pocket", version: "1.2.3" },
        });
    });

    test("pairs each answer with the request that asked for it, in any order", async () => {
        const server = serve({
            answer: (method) => {
                if (method === "slow") return { order: "second" };

                return { order: "first" };
            },
        });
        const rex = client(server.url);

        await rex.connect();

        const [first, second] = await Promise.all([rex.call("fast"), rex.call("slow")]);

        expect(first).toEqual({ order: "first" });
        expect(second).toEqual({ order: "second" });
        expect(server.requests.map((each) => each.method)).toEqual(["fast", "slow"]);
    });

    test("sends a method's arguments as its payload, and leaves the payload out when there are none", async () => {
        const server = serve();
        const rex = client(server.url);

        await rex.connect();
        await rex.call("session.attach", { session_id: "session:1" });
        await rex.call("session.list");

        expect(server.requests[0]).toEqual({ method: "session.attach", payload: { session_id: "session:1" } });
        expect(server.requests[1]).toEqual({ method: "session.list", payload: {} });
    });

    test("turns a server's error into a code and a message that a caller can branch on", async () => {
        const server = serve({
            answer: () => {
                throw new RexCallError("conflict", "stream is not attached", 409);
            },
        });
        const rex = client(server.url);

        await rex.connect();

        const failed = rex.call("data.connect");

        await expect(failed).rejects.toBeInstanceOf(RexCallError);
        await expect(failed).rejects.toMatchObject({ code: "conflict", status: 409, message: "stream is not attached" });
    });

    test("hands the module each event as it arrives, without its wrapper", async () => {
        const server = serve();
        const rex = client(server.url);
        const seen: RexEvent[] = [];

        rex.on({ event: (event) => seen.push(event) });

        await rex.connect();

        const socket = [...server.sockets][0] as { send: (data: string) => void };

        socket.send(
            JSON.stringify({
                type: "event",
                seq: 1,
                payload: { type: "session_event", payload: { session_id: "session:1", event: { type: "block_created" } } },
            }),
        );

        await Bun.sleep(50);

        expect(seen).toEqual([
            { type: "session_event", payload: { session_id: "session:1", event: { type: "block_created" } } },
        ]);
    });

    test("reads the sessions and the hosts that the server lists", async () => {
        const server = serve({
            answer: (method) => {
                if (method === "session.list") return { sessions: [{ session_id: "session:1", label: "work" }] };
                if (method === "hosts.list") return { hosts: [{ id: "host:1", label: "studio", endpoints: ["studio"] }] };

                return {};
            },
        });
        const rex = client(server.url);

        await rex.connect();

        expect(await rex.sessions()).toEqual([{ session_id: "session:1", label: "work" }]);
        expect(await rex.hosts()).toEqual([{ id: "host:1", label: "studio", endpoints: ["studio"] }]);
    });

    test("says that the connection ended, once, and fails what was waiting", async () => {
        const server = serve();
        const rex = client(server.url);
        const reasons: string[] = [];

        rex.on({ close: (reason) => reasons.push(reason) });

        await rex.connect();

        const waiting = rex.call("session.list");

        rex.close();

        await expect(waiting).rejects.toMatchObject({ code: "unavailable" });
        expect(reasons).toHaveLength(1);
        expect(rex.connected).toBe(false);

        // A second close says nothing more: the module hears one end for each connection.
        rex.close();
        expect(reasons).toHaveLength(1);
    });

    test("refuses to call before it is connected", async () => {
        const rex = new RexClient({ endpoint: "ws://127.0.0.1:1" });

        await expect(rex.call("session.list")).rejects.toMatchObject({ code: "conflict" });
    });
});

test(`a server that never says hello is a timeout`, async () => {
    const server = serve({ welcome: false });
    const rex = new RexClient({ endpoint: server.url, timeoutMs: 150 });

    await expect(rex.connect()).rejects.toMatchObject({ code: "timeout" });
});
