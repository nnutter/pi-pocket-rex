/**
 * The sessions page's own rules: which rows a filter keeps, and which icon a machine gets. The rest of the page is
 * markup, which the browser test in `browser.test.ts` runs.
 */
import { describe, expect, test } from "bun:test";
import { filtered, iconPathOf } from "../extensions/rex/picker.js";

interface Host {
    key: string;
    label: string;
    icon: string;
    endpoint: string;
    local: boolean;
    online: boolean;
    error?: string;
    sessions: Array<{ id: string; label: string }>;
}

const work: Host = {
    key: "ws://work",
    label: "work",
    icon: "macbook",
    endpoint: "ws://work",
    local: false,
    online: true,
    sessions: [
        { id: "session:1", label: "calm-pine" },
        { id: "session:2", label: "quiet-meadow" },
    ],
};

const here: Host = {
    key: "/run/rex.sock",
    label: "frame",
    icon: "desktopcomputer",
    endpoint: "/run/rex.sock",
    local: true,
    online: true,
    sessions: [{ id: "session:3", label: "cosmic-brook" }],
};

const gone: Host = {
    key: "ws://gone",
    label: "hermes",
    icon: "server.rack",
    endpoint: "ws://gone",
    local: false,
    online: false,
    error: "it did not answer",
    sessions: [],
};

const hosts: Host[] = [here, work, gone];

describe("the filter", () => {
    test("keeps everything when it is empty", () => {
        expect(filtered(hosts, "")).toHaveLength(3);
        expect(filtered(hosts, "   ")).toHaveLength(3);
    });

    test("keeps the sessions that hold the text, and the machine that holds them", () => {
        const kept = filtered(hosts, "pine");

        expect(kept).toHaveLength(1);
        expect(kept[0]!.label).toBe("work");
        expect(kept[0]!.sessions.map((session: { label: string }) => session.label)).toEqual(["calm-pine"]);
    });

    test("keeps every session of a machine whose own name holds the text", () => {
        const kept = filtered(hosts, "WORK");

        expect(kept).toHaveLength(1);
        expect(kept[0]!.sessions).toHaveLength(2);
    });

    test("keeps a machine that holds the text even when none of its sessions do", () => {
        const kept = filtered(hosts, "hermes");

        expect(kept).toHaveLength(1);
        expect(kept[0]!.online).toBe(false);
    });

    test("keeps nothing when nothing holds the text", () => {
        expect(filtered(hosts, "zzz")).toEqual([]);
    });
});

describe("the icon", () => {
    test("draws the machine that Rex names", () => {
        expect(iconPathOf("macbook")).not.toBe(iconPathOf("server.rack"));
        expect(iconPathOf("server.rack")).toContain("M1.75 1h12.5");
    });

    test("draws a monitor for a name that it does not know", () => {
        expect(iconPathOf("something-new")).toBe(iconPathOf("desktopcomputer"));
        expect(iconPathOf(undefined)).toBe(iconPathOf("desktopcomputer"));
    });
});
