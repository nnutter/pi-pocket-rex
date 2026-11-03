/**
 * A preview of the terminal's screen without Pi Pocket: the module's own routes behind a small HTTP server, and a page
 * that gives `TerminalView` (from `extensions/rex/terminal.js`) a fake `pocket`. Use it to see and type into a real shell in a
 * browser, with the app's look kept by the page's own tokens.
 *
 *     bun run preview        # http://127.0.0.1:4711
 *
 * It is a development tool, not part of the extension: what it serves is the module and the browser module themselves.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import createRex from "../extensions/rex.ts";
import { RexClient } from "../extensions/_rex-client.ts";
import { fakeWeb, type FakeWeb } from "../test/fake-web.ts";

const root = join(import.meta.dir, "..");

/** Where Pi Pocket keeps its own fonts, found through the link that the drop-in folder has to its packages. */
const appFonts = join(
    dirname(realpathSync(join(homedir(), ".pi-pocket", "extensions", "node_modules"))),
    "web",
    "fonts",
);
const port = Number(process.env.PORT ?? 4711);

/**
 * A Rex server of the preview's own, on a port that only this machine can reach.
 *
 * The preview runs under Bun, and the module under Node, so the Unix socket that a Rex server listens on by default is
 * one that the preview cannot open. A plain TCP listener is the same server with an address that both can reach, and a
 * state folder under the temporary folder keeps the preview's sessions out of the person's own Rex.
 *
 * **It must not be the person's own server.** `test/browser.test.ts` types `exit` into a shell to see what the page does
 * with a shell that ended, and a Rex server started with `--exit-empty` destroys a session that has nothing left in it.
 * An earlier version of this file used the default socket, and a test run took a real session with it. A server of the
 * preview's own, in a folder that is thrown away, is what makes a test safe to run.
 */
async function previewRex(): Promise<{ endpoint: string; stop: () => void }> {
    const named = process.env.REX_PREVIEW_LOCAL;

    if (named !== undefined) return { endpoint: named, stop: () => {} };

    const state = mkdtempSync(join(tmpdir(), "rex-preview-"));
    const rexPort = await freePort();
    const server = Bun.spawn(
        ["rex", "server", "run", "--listen", `http://127.0.0.1:${rexPort}`, "--allow-anonymous", "--state-dir", state],
        { stdout: "ignore", stderr: "ignore" },
    );

    const endpoint = `ws://127.0.0.1:${rexPort}`;
    const deadline = Date.now() + 20_000;

    for (;;) {
        try {
            const client = new RexClient({ endpoint, timeoutMs: 2_000 });

            await client.connect();

            // One call: a session, and the window with the shell that the preview shows.
            await client.call("session.create", {
                label: "Preview",
                initial_windows: [{ layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: root } } } }],
            });

            client.close();

            break;
        } catch (error) {
            if (Date.now() > deadline) throw error;

            await Bun.sleep(200);
        }
    }

    return { endpoint, stop: () => server.kill() };
}

/** A port that nothing is listening on, so that the preview's server is the preview's. */
async function freePort(): Promise<number> {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const taken = probe.port ?? 0;

    probe.stop(true);

    return taken;
}

const rex = await previewRex();

const fake: FakeWeb = fakeWeb({
    settings: {
        runtime: join(root, "src"),
        command: process.env.SHELL ?? "/bin/bash",
        // The preview runs under Bun, which cannot open a Unix socket the way the module does under Node, so a person
        // who wants the sessions page to show real sessions points it at a host: REX_PREVIEW_LOCAL=wss://host:7297.
        local: rex.endpoint,
    },
    sessions: [{ id: 1, title: "Preview", cwd: root, archived: false, updatedAt: Date.now() }],
});

createRex(null, fake.web);

const tabs = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

// Everything that the module sends to a browser goes to the preview page instead.
const send = fake.web.send.bind(fake.web);

(fake.web as unknown as { send: (event: string, data: unknown) => void }).send = (event, data) => {
    send(event, data);

    for (const controller of tabs) {
        try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
        } catch {
            tabs.delete(controller);
        }
    }
};

/** The routes that the module registered, as a matcher for an address. */
const routes = [...fake.routes].map((each) => {
    const [method, path] = each.split(" ") as [string, string];
    const pattern = new RegExp(`^${path.replace(/:([A-Za-z0-9_]+)/g, "(?<$1>[^/]+)")}$`);

    return { method, path, pattern };
});

async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, "");

    if (url.pathname === "/events") {
        // The tab's own controller, so that a stream that ends takes only itself out of the set.
        let mine: ReadableStreamDefaultController<Uint8Array> | undefined;

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                mine = controller;
                tabs.add(controller);
                controller.enqueue(encoder.encode(": ready\n\n"));
            },
            cancel() {
                if (mine !== undefined) tabs.delete(mine);
            },
        });

        return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        });
    }

    // Pi Pocket's own fonts, so that the preview draws what the app draws: JetBrains Mono and the Nerd Fonts icons.
    if (url.pathname.startsWith("/fonts/")) {
        const file = Bun.file(join(appFonts, url.pathname.slice("/fonts/".length)));

        if (!(await file.exists())) return new Response("not found", { status: 404 });

        return new Response(file, { headers: { "content-type": "font/woff2" } });
    }

    if (url.pathname.startsWith("/vendor/")) {
        const files: Record<string, string> = {
            "/vendor/preact.mjs": "preact/dist/preact.mjs",
            "/vendor/hooks.mjs": "preact/hooks/dist/hooks.mjs",
            "/vendor/htm.mjs": "htm/dist/htm.module.js",
        };
        const file = files[url.pathname];

        if (file === undefined) return new Response("not found", { status: 404 });

        return new Response(Bun.file(join(root, "node_modules", file)), {
            headers: { "content-type": "text/javascript" },
        });
    }

    if (url.pathname.startsWith("/x/")) {
        const file = Bun.file(join(root, "extensions", "rex", url.pathname.slice("/x/".length)));

        if (!(await file.exists())) return new Response("not found", { status: 404 });

        return new Response(file, {
            headers: { "content-type": url.pathname.endsWith(".css") ? "text/css" : "text/javascript" },
        });
    }

    if (url.pathname === "/" || url.pathname === "/preview.html") {
        return new Response(Bun.file(join(import.meta.dir, "preview.html")), { headers: { "content-type": "text/html" } });
    }

    for (const route of routes) {
        const match = route.pattern.exec(path);

        if (match === null || route.method !== request.method) continue;

        const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);

        try {
            const value = await fake.call({
                method: route.method,
                path: route.path,
                params: match.groups ?? {},
                body,
            });

            return Response.json(value ?? {});
        } catch (error) {
            const status = (error as { status?: number }).status ?? 500;

            return Response.json({ message: (error as Error).message }, { status });
        }
    }

    return new Response("not found", { status: 404 });
}

Bun.serve({ port, fetch: answer });

console.log(`Rex preview: http://127.0.0.1:${port} (Rex at ${rex.endpoint})`);
