/**
 * The arithmetic of the page against a keyboard that covers the window rather than changing it.
 *
 * The page puts this number on the screen in a browser, and `browser.test.ts` holds it there against a real shell. This
 * one keeps the arithmetic honest where a browser does not go: a box that begins above the part that a keyboard leaves,
 * and a keyboard that covers all of it.
 */
import { describe, expect, test } from "bun:test";
import { visibleHeight } from "../extensions/rex/terminal.js";

describe("the part of a box that is in sight", () => {
    test("is the whole box when the window is not covered", () => {
        expect(visibleHeight({ top: 0, bottom: 800 }, { top: 0, height: 800 })).toBe(800);
    });

    test("ends where the keyboard begins", () => {
        expect(visibleHeight({ top: 0, bottom: 800 }, { top: 0, height: 500 })).toBe(500);
    });

    test("begins where the part that is left begins, when a box starts above it", () => {
        expect(visibleHeight({ top: 0, bottom: 800 }, { top: 200, height: 300 })).toBe(300);
    });

    test("is nothing when the keyboard covers the whole box", () => {
        expect(visibleHeight({ top: 0, bottom: 800 }, { top: 0, height: 0 })).toBe(0);
        expect(visibleHeight({ top: 900, bottom: 1000 }, { top: 0, height: 800 })).toBe(0);
    });

    test("keeps a box that fits inside the part that is left, and no more", () => {
        expect(visibleHeight({ top: 100, bottom: 300 }, { top: 0, height: 800 })).toBe(200);
    });
});
