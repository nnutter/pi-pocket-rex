/**
 * A preview of the terminal's screen without Pi Pocket: the module's own routes behind a small HTTP server, and a page
 * that gives `TerminalView` (from `extensions/rex/terminal.js`) a fake `pocket`. Use it to see and type into a real shell in a
 * browser, with the app's look kept by the page's own tokens.
 *
 *     bun run preview        # http://127.0.0.1:4711
 *
 * It is a development tool, not part of the extension: what it serves is the module and the browser module themselves.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import createRex from "../extensions/rex.ts";
import { fakeWeb, type FakeWeb } from "../test/fake-web.ts";

const root = join(import.meta.dir, "..");

/** Where Pi Pocket keeps its own fonts, found through the link that the drop-in folder has to its packages. */
const appFonts = join(
    dirname(realpathSync(join(homedir(), ".pi-pocket", "extensions", "node_modules"))),
    "web",
    "fonts",
);
const port = Number(process.env.PORT ?? 4711);

const fake: FakeWeb = fakeWeb({
    settings: {
        runtime: join(root, "src"),
        command: process.env.SHELL ?? "/bin/bash",
        // The preview runs under Bun, which cannot open a Unix socket the way the module does under Node, so a person
        // who wants the sessions page to show real sessions points it at a host: REX_PREVIEW_LOCAL=wss://host:7297.
        ...(process.env.REX_PREVIEW_LOCAL === undefined ? {} : { local: process.env.REX_PREVIEW_LOCAL }),
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

console.log(`Rex preview: http://127.0.0.1:${port}`);
