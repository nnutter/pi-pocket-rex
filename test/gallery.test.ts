/**
 * The gallery entry and the sidecar that Pi Pocket reads beside an installed drop-in: an entry names each file with the
 * SHA-256 and the size that it has, because Pi Pocket installs nothing when one of them is not what the entry says, and a
 * sidecar that cannot be read that way makes Menu → Extensions refuse the extension.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = JSON.parse(readFileSync(join(root, "docs", "gallery-entry.json"), "utf8")) as {
    name: string;
    title: string;
    version: string;
    source: { repo: string; commit: string; path: string };
    files: Array<{ name: string; sha256: string; size: number }>;
    declares: { extensions: string[]; routes: string[]; client: string | null; access: string };
};

test("titles the extension Rex, though its module is named rex", () => {
    expect(entry.name).toBe("rex");
    expect(entry.title).toBe("Rex");
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("names every file of the drop-in, with the hash and size that it has now", () => {
    for (const file of entry.files) {
        const body = readFileSync(join(root, "extensions", file.name));

        expect({
            name: file.name,
            sha256: createHash("sha256").update(body).digest("hex"),
            size: body.byteLength,
        }).toEqual(file);
    }

    // The module itself, and the browser module beside it: what a drop-in is made of.
    expect(entry.files.map((each) => each.name)).toContain("rex.ts");
    expect(entry.files.some((each) => each.name.startsWith("rex/"))).toBe(true);
    expect(entry.source.path).toBe("extensions");
    expect(entry.source.commit).toMatch(/^[0-9a-f]{40}$/);
});

test("declares the routes that the module registers, and the browser module's access", () => {
    const module = readFileSync(join(root, "extensions", "rex.ts"), "utf8");
    const routes = [...module.matchAll(/web\.route\("([A-Z]+)", "([^"]+)"/g)].map(([, method, path]) => `${method} ${path}`);

    expect(entry.declares.routes).toEqual(routes);
    expect(entry.declares.extensions).toEqual(["rex"]);
    expect(module).toContain(`web.client("rex")`);
    expect(entry.declares.client).toBe("owner");
    expect(entry.declares.access).toBe("owner");
});

test("writes a sidecar that says the entry, and where it came from", () => {
    const data = mkdtempSync(join(tmpdir(), "ghostty-sidecar-"));

    try {
        const wrote = Bun.spawnSync(["bun", "run", join(root, "scripts", "sidecar.ts")], {
            env: { ...process.env, PI_POCKET_DATA: data },
        });

        expect(wrote.exitCode).toBe(0);

        const sidecar = JSON.parse(readFileSync(join(data, "extensions", "rex.gallery.json"), "utf8"));

        expect(sidecar.format).toBe(1);
        expect(sidecar.index).toBe(entry.source.repo);
        expect(Math.abs(Date.now() - sidecar.installedAt)).toBeLessThan(60_000);
        // The entry travels in the sidecar as it is: Pi Pocket reads it with the same rules as the index's.
        expect(sidecar.entry).toEqual(entry);
    } finally {
        rmSync(data, { recursive: true, force: true });
    }
});

test("keeps the sidecar out of the repository", () => {
    // It describes one installation, on one machine, and its hashes are of the files that are on it.
    expect(existsSync(join(root, "docs", "rex.gallery.json"))).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toContain(".gallery.json");
});
