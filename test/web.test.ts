/**
 * The browser module is plain JavaScript that a browser runs as it is, and nothing in the build checks it: TypeScript
 * skips `.js` here, and the module only fails when a tab loads it. So each file is parsed as the browser's JavaScript.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const folder = join(import.meta.dir, "..", "extensions", "rex");
const files = readdirSync(folder).filter((file) => file.endsWith(".js"));

describe("the browser module", () => {
    test("has files to check", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        test(`${file} parses as plain JavaScript`, () => {
            const parsed = Bun.spawnSync(["node", "--check", join(folder, file)]);

            expect(parsed.stderr.toString()).toBe("");
            expect(parsed.exitCode).toBe(0);
        });

        test(`${file} has nothing that only TypeScript reads`, () => {
            const source = readFileSync(join(folder, file), "utf8");

            // A return type on a method, a parameter property, a type import: all of them are syntax errors in a browser.
            expect(source).not.toMatch(/\)\s*:\s*(void|string|number|boolean|Promise)\b/);
            expect(source).not.toMatch(/\breadonly\s+#/);
            expect(source).not.toMatch(/^\s*(interface|type|enum)\s+\w+/m);
            expect(source).not.toMatch(/\bimport\s+type\b/);
        });
    }
});
