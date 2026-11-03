/**
 * The Rex client against a server that this test writes: the hello that it sends, the requests that it pairs with their
 * answers, the events that it hands to the module, and the failure that it turns a server's error into.
 *
 * The server is a `Bun.serve` WebSocket, not a Rex server, so the test needs no Rex and no network beyond the loopback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
    endpointCandidates,
    RexCallError,
    RexClient,
    RexStream,
    RexMessageFilter,
    type RexEvent,
} from "../extensions/_rex-client.ts";
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

describe("the stream that a screen can take", () => {
    const at = (nonce: bigint, json = '{"type":"resize"}') => `\u001b_rex1;${nonce};${json}\u001b\\`;
    const bytes = (text: string) => new TextEncoder().encode(text);
    const kept = (value: Uint8Array | null) => (value === null ? "" : new TextDecoder().decode(value));

    test("drops the snapshot and the Rex message that follows it, and keeps what a program printed", () => {
        const filter = new RexMessageFilter(7n);
        const stream = `GHOSTSNP\u0001\u0000binary junk${at(7n)}hello\r\n`;

        expect(kept(filter.push(bytes(stream)))).toBe("hello\r\n");
    });

    test("drops a Rex message that comes in the middle of what a program printed", () => {
        const filter = new RexMessageFilter(7n);

        filter.push(bytes(`snapshot${at(7n)}`));

        const after = filter.push(bytes(`one${at(7n, '{"type":"theme"}')}two`));

        expect(kept(after)).toBe("onetwo");

        // The last few bytes wait, because a marker can split across two arrivals.
        expect(kept(filter.push(bytes("three")))).toBe("three");
    });

    test("finds a message that splits across two arrivals", () => {
        const filter = new RexMessageFilter(7n);
        const message = at(7n);

        expect(kept(filter.push(bytes(`GHOSTSNP and more${message.slice(0, 6)}`)))).toBe("");

        const after = filter.push(bytes(`${message.slice(6)}after`));

        expect(kept(after)).toBe("after");
    });

    test("keeps a look-alike that a program printed, because its nonce is not this stream's", () => {
        const filter = new RexMessageFilter(7n);

        filter.push(bytes(`snapshot${at(7n)}`));

        // A program can print the same bytes. Only a message with this stream's nonce is Rex's, and this one is not.
        const lookAlike = at(8n);
        const after = filter.push(bytes(`printed${lookAlike}${at(7n)}real`));

        expect(kept(after)).toBe(`printed${lookAlike}`);
    });

    test("waits for the end of a message that has not finished arriving", () => {
        const filter = new RexMessageFilter(7n);
        const message = at(7n);

        filter.push(bytes(`snapshot${message.slice(0, message.length - 2)}`));

        expect(kept(filter.push(bytes(`${message.slice(-2)}done`)))).toBe("done");
    });

    test("passes everything through for a stream that is already past its snapshot", () => {
        const filter = new RexMessageFilter(7n, true);

        expect(kept(filter.push(bytes("first")))).toBe("first");
        expect(kept(filter.push(bytes("second")))).toBe("second");
    });
});

describe("the data connection", () => {
    test("sends the hello with the ticket, and hands the stream to the module", async () => {
        const server = serve({ data: { nonce: 7n } });
        const rex = client(server.url);
        const chunks: Uint8Array[] = [];

        await rex.connect();
        await rex.call("session.attach", { session_id: "session:1" });

        const stream = await RexStream.open({
            client: rex,
            sessionId: "session:1",
            blockId: "block:1",
            onData: (data) => chunks.push(data),
            onEnd: () => {},
        });

        await Bun.sleep(50);

        // The hello is the tag, then the 16 bytes of the ticket that the control connection gave out.
        expect(server.dataMessages).toHaveLength(1);
        expect(server.dataMessages[0]![0]).toBe(0x01);
        expect(server.dataMessages[0]!.length).toBe(17);
        expect(stream.welcome?.nonce).toBe(7n);
        expect(stream.welcome?.keepMs).toBe(60_000);

        server.push(bytes("hello"));
        await Bun.sleep(50);

        expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["hello"]);
        expect(stream.received).toBe(5);

        stream.close();
    });

    test("refuses a stream that the server will not open", async () => {
        const server = serve({ data: { reject: 7 } });
        const rex = client(server.url);

        await rex.connect();
        await rex.call("session.attach", { session_id: "session:1" });

        await expect(
            RexStream.open({
                client: rex,
                sessionId: "session:1",
                blockId: "block:1",
                onData: () => {},
                onEnd: () => {},
            }),
        ).rejects.toMatchObject({ code: "refused" });
    });

    test("resumes a stream that dropped, from the byte that the module has", async () => {
        const server = serve({ data: { nonce: 7n } });
        const rex = client(server.url);
        const chunks: Uint8Array[] = [];
        const ends: string[] = [];

        await rex.connect();
        await rex.call("session.attach", { session_id: "session:1" });

        const stream = await RexStream.open({
            client: rex,
            sessionId: "session:1",
            blockId: "block:1",
            onData: (data) => chunks.push(data),
            onEnd: (reason) => ends.push(reason),
        });

        server.push(bytes("abc"));
        await Bun.sleep(50);

        server.drop();
        await Bun.sleep(600);

        // A resume is the second message: the tag, the token, and how many bytes arrived.
        expect(server.dataMessages).toHaveLength(2);
        expect(server.dataMessages[1]![0]).toBe(0x02);

        const counted = Buffer.from(server.dataMessages[1]!).readBigUInt64LE(17);

        expect(counted).toBe(3n);
        expect(ends).toEqual([]);

        stream.close();
    });

    test("ends when the block closes, rather than resuming", async () => {
        const server = serve({ data: { nonce: 7n } });
        const rex = client(server.url);
        const ends: string[] = [];

        await rex.connect();
        await rex.call("session.attach", { session_id: "session:1" });

        const stream = await RexStream.open({
            client: rex,
            sessionId: "session:1",
            blockId: "block:1",
            onData: () => {},
            onEnd: (reason) => ends.push(reason),
        });

        await Bun.sleep(30);
        stream.close();
        await Bun.sleep(100);

        expect(ends).toEqual([]);
    });
});

function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}
