/**
 * Puts the extension where Pi Pocket reads it: the module and its browser module in the drop-in folder, and the runner
 * with Ghostty's binding in a folder of its own in the data folder.
 *
 *     bun run install-extension            # into ~/.pi-pocket
 *     bun run install-extension --dry-run  # say what it would write
 *
 * Pi Pocket watches the drop-in folder, so a version that is on loads again a moment later.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "..");
const data = process.env.PI_POCKET_DATA ?? join(homedir(), ".pi-pocket");
const dropins = join(data, "extensions");
const web = join(dropins, "rex");
const runtime = join(data, "rex");
const dryRun = process.argv.includes("--dry-run");

/** The files that the browser module serves, in the order that they load. */
const browserModule = ["index.js", "terminal.js", "picker.js", "terminal.css"];

/** The runner and the files that it imports: the runtime folder's own, beside `libghostty-vt`. */
const runtimeFiles = ["rex-host.ts", "screen.ts", "escapes.ts"];

function say(what: string, where: string): void {
    console.log(`${dryRun ? "would write" : "wrote"} ${what} → ${where}`);
}

function copy(from: string, to: string): void {
    if (dryRun) {
        say(from.slice(root.length + 1), to);
        return;
    }

    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
}

for (const file of browserModule) {
    copy(join(root, "extensions", "rex", file), join(web, file));
}

copy(join(root, "extensions", "rex.ts"), join(dropins, "rex.ts"));

for (const file of runtimeFiles) {
    copy(join(root, "src", file), join(runtime, file));
}

const manifest = {
    name: "rex-runtime",
    private: true,
    type: "module",
    dependencies: { "libghostty-vt": "^0.6.3" },
};

if (!dryRun) {
    writeFileSync(join(runtime, "package.json"), `${JSON.stringify(manifest, null, 4)}\n`);

    if (!existsSync(join(runtime, "node_modules", "libghostty-vt"))) {
        const install = Bun.spawnSync(["bun", "install"], { cwd: runtime, stdout: "inherit", stderr: "inherit" });

        if (install.exitCode !== 0) {
            console.error("bun install failed in the runtime folder");
            process.exit(1);
        }
    }
}

const strays = existsSync(web) ? readdirSync(web).filter((file) => !browserModule.includes(file)) : [];

if (strays.length > 0) {
    console.log(`\nNot removed, and not served unless it is one of ${browserModule.join(", ")}: ${strays.join(", ")}`);
}

console.log(`\nTurn it on in Menu → Extensions → Rex terminal.`);
