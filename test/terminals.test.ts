/**
 * What the page of every shell says about one: its name, the order of the rows, and how long ago it started. These are
 * the parts of the page that a test can read without a browser, and the ones that decide whether a person can tell the
 * shell beside their work from the one that a closed tab left behind.
 */
import { expect, test } from "bun:test";
import { nameOf, orderOf, since } from "../extensions/rex/terminals.js";

/** A shell, as the module's list gives it: only the fields that these parts read. */
const shell = (over: Record<string, unknown> = {}) => ({
    id: "one",
    conversation: 7,
    cwd: "/work",
    argv: ["/bin/bash", "-l"],
    cols: 80,
    rows: 24,
    title: "",
    alive: true,
    exitCode: null,
    signal: null,
    createdAt: 0,
    ...over,
});

test("names a shell by its own title, or by the program that it runs", () => {
    expect(nameOf(shell({ title: "vim README.md" }))).toBe("vim README.md");
    expect(nameOf(shell())).toBe("bash");
    expect(nameOf(shell({ argv: [] }))).toBe("shell");
});

test("lists the shells that are running first, and the oldest of them first", () => {
    const rows = orderOf([
        shell({ id: "ended", alive: false, createdAt: 5 }),
        shell({ id: "new", createdAt: 30 }),
        shell({ id: "old", createdAt: 10 }),
    ]);

    // An old shell that is still here is the likeliest one that nobody is looking at.
    expect(rows.map((each) => each.id)).toEqual(["old", "new", "ended"]);
});

test("says how long ago a shell started, in a word or two", () => {
    const minute = 60_000;

    expect(since(0, 10_000)).toBe("just now");
    expect(since(0, 5 * minute)).toBe("5 min ago");
    expect(since(0, 3 * 60 * minute)).toBe("3 h ago");
    expect(since(0, 24 * 60 * minute)).toBe("1 day ago");
    expect(since(0, 3 * 24 * 60 * minute)).toBe("3 days ago");
    // A clock that went back, or a shell that says it started a moment from now, reads as one that just started.
    expect(since(10_000, 0)).toBe("just now");
});
