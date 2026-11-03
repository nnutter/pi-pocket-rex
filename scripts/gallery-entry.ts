/**
 * Writes `docs/gallery-entry.json` from this repository's own files: the published drop-in, each file with its size and
 * SHA-256 at the commit the entry pins. Pi Pocket installs nothing when one of them is not what the entry says.
 *
 *     bun run scripts/gallery-entry.ts          # for HEAD, which is the commit that goes out
 *     bun run scripts/gallery-entry.ts <commit> # for the commit that holds these files
 *
 * Run it on the commit that you deploy, then commit the entry. A commit id given here is for an entry that is committed
 * after the files: the entry cannot name the commit that holds it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** The drop-in's files, as the module file and the folder that its `web.client` names. */
export const FILES = [
    "rex.ts",
    "rex/index.js",
    "rex/terminal.js",
    "rex/terminals.js",
    "rex/picker.js",
    "rex/terminal.css",
];

export const commit = (): string =>
    Bun.spawnSync(["git", "rev-parse", process.argv[2] ?? "HEAD"], { cwd: root }).stdout.toString().trim();

/** What the module installs, as Menu → Extensions shows it. Its routes are the ones it registers. */
const module = readFileSync(join(root, "extensions", FILES[0]!), "utf8");
const routes = [...module.matchAll(/web\.route\("([A-Z]+)", "([^"]+)"/g)].map(([, method, path]) => `${method} ${path}`);

const entry = {
    name: "rex",
    title: "Rex",
    description:
        "Rex: a real terminal in Pi Pocket, beside a session or as a page of its own. Ghostty's own engine (libghostty-vt) draws the screen, so an editor's cursor shapes, its icons, and its clipboard work. It needs Bun, and a runtime folder of its own, ~/.pi-pocket/rex.",
    tags: ["terminal", "shell", "pty", "rex", "ghostty", "neovim", "editor"],
    author: { name: "Nathan Nutter", github: "nnutter" },
    version: "0.1.0",
    source: { repo: "nnutter/pi-pocket-rex", commit: commit(), path: "extensions" },
    files: FILES.map((name) => {
        const body = readFileSync(join(root, "extensions", name));

        return { name, sha256: createHash("sha256").update(body).digest("hex"), size: body.byteLength };
    }),
    pocketApi: 2,
    minPocket: "0.22.0",
    declares: {
        extensions: ["rex"],
        tools: [],
        readOnlyTools: [],
        hooks: [],
        sections: [],
        wraps: [],
        routes,
        client: "owner",
        access: "owner",
    },
    revoked: [],
};

writeFileSync(join(root, "docs", "gallery-entry.json"), `${JSON.stringify(entry, null, 4)}\n`);
console.log(`wrote docs/gallery-entry.json for ${entry.source.commit.slice(0, 12)} (${entry.files.length} files, ${routes.length} routes)`);
