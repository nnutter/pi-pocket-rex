/**
 * Writes the provenance sidecar that Pi Pocket reads beside an installed drop-in: `<name>.gallery.json` in the drop-in
 * folder, which is what makes Menu → Extensions show the extension's title and the place it came from.
 *
 *     bun run scripts/sidecar.ts            # after install.ts, with the files that it deployed
 *
 * The sidecar holds the gallery entry that `scripts/gallery-entry.ts` writes, and the index it came from. It is not part
 * of this repository: it says where one installation came from, and its hashes describe the files on this machine.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const data = process.env.PI_POCKET_DATA ?? join(homedir(), ".pi-pocket");
const name = "rex";
const index = "nnutter/pi-pocket-rex";
const target = join(data, "extensions", `${name}.gallery.json`);
const entry = JSON.parse(readFileSync(join(root, "docs", "gallery-entry.json"), "utf8")) as { name: string };

if (entry.name !== name) throw new Error(`the entry is ${entry.name}, not ${name}`);

const sidecar = { format: 1, index, installedAt: Date.now(), entry };

mkdirSync(join(data, "extensions"), { recursive: true });
writeFileSync(target, `${JSON.stringify(sidecar, null, 4)}\n`);
console.log(`wrote ${target} (${entry.name}: ${(entry as { title?: string }).title ?? ""})`);
