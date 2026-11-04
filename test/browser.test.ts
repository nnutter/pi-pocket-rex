/**
 * A browser, a real shell, and the page that a person uses: the tests here drive the module's own page in Chromium,
 * with touch where a phone has it, and hold it to the behaviour that the last few changes broke.
 *
 * The page comes from `scripts/preview.ts`, which serves the browser module and the module's routes. Nothing here is a
 * mock: a tap is a tap, a keyboard is a viewport that lost a keyboard's worth of height, and a shell is a pty.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const PORT = Number(process.env.REX_TEST_PORT ?? 4719);
const URL_BASE = `http://127.0.0.1:${PORT}`;

let server: Bun.Subprocess<"ignore", "ignore", "inherit">;
let browser: Browser;

/** The Chromium on this machine: the one that Pi Pocket uses for its browser, or one of the usual names. */
function chromePath(): string {
    const named = process.env.CHROME_PATH;

    if (named !== undefined) return named;

    for (const candidate of [
        "/opt/chromium/1731015/chrome-linux/chrome",
        "/opt/chromium/1731004/chrome-linux/chrome",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
    ]) {
        if (Bun.file(candidate).size > 0) return candidate;
    }

    throw new Error("No Chromium found: set CHROME_PATH to one.");
}

beforeAll(async () => {
    server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "scripts", "preview.ts")], {
        env: { ...process.env, PORT: String(PORT) },
        stdout: "ignore",
        stderr: "inherit",
    });

    const deadline = Date.now() + 20_000;

    for (;;) {
        try {
            const answer = await fetch(`${URL_BASE}/api/x/rex/terminals`);

            if (answer.ok) break;
        } catch {
            // Not up yet.
        }

        if (Date.now() > deadline) throw new Error("The preview server did not start.");
        await Bun.sleep(100);
    }

    browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
}, 40_000);

afterAll(async () => {
    await browser?.close();
    server?.kill();
});

/** A phone: a narrow window, a touch screen, and a page that has not lost any height yet. */
async function openPhone(): Promise<Page> {
    const page = await browser.newPage();

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

/** A panel in a window wide enough for every button of the bar. */
async function openWide(): Promise<Page> {
    const page = await browser.newPage();

    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

/** The terminal as the app opens it first: a panel beside the conversation, in a window wide enough for every button. */
async function openPanel(): Promise<Page> {
    const page = await browser.newPage();

    await page.setViewport({ width: 900, height: 700, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/?panel=terminal`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

/** Which surface the terminal asked the app for: the preview says it, as the app draws it. */
const surfaceOf = (page: Page) => page.$eval("#page", (root) => (root as HTMLElement).dataset.surface ?? "(none)");

/** Waits for the page to finish what a tap or a keystroke set going. */
function settle(page: Page, ms = 250): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The keys arrive, and the keyboard with them: a phone takes a keyboard's worth of the window. */
async function keyboardUp(page: Page): Promise<void> {
    await tap(page, ".gt-screen");
    await page.setViewport({ width: 390, height: 520, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await settle(page, 400);
}

async function keyboardDown(page: Page): Promise<void> {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await settle(page, 400);
}

/**
 * A phone whose keyboard covers the window instead of giving it room, which is how iOS does it: the page is still laid
 * out as tall as the window, and only the visual viewport gets shorter. Chromium changes the window itself for a
 * keyboard, as Android does, so this phone is given a visual viewport that a test can shorten on its own.
 */
async function openIPhone(): Promise<Page> {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
        const view = new EventTarget() as EventTarget & Record<string, unknown>;

        view.height = window.innerHeight;
        view.width = window.innerWidth;
        view.offsetTop = 0;
        view.offsetLeft = 0;
        view.pageTop = 0;
        view.pageLeft = 0;
        view.scale = 1;

        Object.defineProperty(window, "visualViewport", { value: view, configurable: true });
    });

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

/** The keyboard of that phone: it covers the window down to this height, and says so as the visual viewport does. */
async function keyboardCovers(page: Page, height: number): Promise<void> {
    await page.evaluate((height) => {
        const view = window.visualViewport as unknown as EventTarget & { height: number };

        view.height = height;
        view.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
    }, height);
    await settle(page, 600);
}

/**
 * Leaves the shell at a fresh prompt.
 *
 * Every page of the preview shows the same conversation's terminal, so a test that pressed a key of the row -- an arrow,
 * a Tab, an Escape -- can leave the next one with a cursor in the middle of a line or a half-typed command. Ctrl-C is
 * the line that a person would clear it with.
 */
async function freshPrompt(page: Page): Promise<void> {
    await page.evaluate(() => {
        const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

        input.focus();
        input.value = "\u0003";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await settle(page, 350);
}

/** A finger on an element: a touch, as a phone sends one. */
async function tap(page: Page, selector: string): Promise<void> {
    const element = await page.$(selector);

    if (element === null) throw new Error(`Nothing on the page is ${selector}`);

    const box = await element.boundingBox();

    if (box === null) throw new Error(`${selector} has no box`);

    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
}

/**
 * The key of the row whose label is this one, tapped by the element that has that label.
 *
 * The row's keys are not siblings: the round Control and the way out stand beside the band that scrolls, so a selector
 * that counted keys by their place among their siblings found the one after the label that was asked for.
 */
async function tapKey(page: Page, label: string): Promise<void> {
    const labels = await page.$$eval(".gt-key", (keys) => keys.map((key) => key.textContent?.trim() ?? ""));
    const at = labels.indexOf(label);

    if (at < 0) throw new Error(`No key ${label} in the row: ${labels.join(" ")}`);

    const keys = await page.$$(".gt-key");

    await keys[at]!.tap();
    await settle(page);
}

/**
 * A page that records what it says about its own tab: the hello that it sends when it loads, and the goodbye that it
 * sends when it goes. The module runs in the preview's server, so what the page sends is what a test can see.
 */
async function openWithTabLog(): Promise<Page> {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
        const said: Array<{ url: string; body: string }> = [];

        (window as unknown as { said: typeof said }).said = said;

        const original = window.fetch.bind(window);

        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url.includes("/tabs")) said.push({ url, body: String(init?.body ?? "") });

            return original(input, init);
        }) as typeof fetch;
    });

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

/** What the page has said about its tab so far. */
const tabSaid = (page: Page) =>
    page.evaluate(() => (window as unknown as { said: Array<{ url: string; body: string }> }).said ?? []);

const rowShown = (page: Page) => page.$(".gt-keys").then((found) => found !== null);
const focusedThing = (page: Page) => page.evaluate(() => document.activeElement?.className ?? "(none)");
const armed = (page: Page) =>
    page.$eval(".gt-key.gt-round", (key) => key.className.includes("gt-key-on")).catch(() => false);

/**
 * An app's own key, as Pi Pocket has them: ⌘B on an Apple keyboard and Ctrl+B on another fold the sidebar, and a key
 * that the app takes is not the shell's. This is the app's listener, registered before the module loads, which is what
 * a page can see of the app.
 */
function appKeys() {
    const apple = /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);

    addEventListener("keydown", (event: KeyboardEvent) => {
        const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

        if (!mod || event.altKey || event.shiftKey || event.code !== "KeyB") return;

        event.preventDefault();
        document.documentElement.dataset.folded = "yes";
    });
}

/** A page with the app's own keys on it: `where` is what the preview shows, and `mac` says the keyboard has Command. */
async function openWithAppKeys(where: string, { mac = false } = {}): Promise<Page> {
    const page = await browser.newPage();

    if (mac) {
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        );
    }

    await page.evaluateOnNewDocument(appKeys);
    await page.setViewport({ width: 900, height: 700, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/${where}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-panes .gt-row");
    await settle(page, 400);

    return page;
}

describe("the tab of the app", () => {
    /**
     * A shell lives in Rex, not in the page, so the page says which tab it is: a hello when it loads, and a goodbye when
     * it goes. The module ends what no tab is watching when the last one has gone, and it cannot know that any other
     * way -- every tab of Pi Pocket shares one Rex client.
     */
    test("says that it is here, and says goodbye when it goes", async () => {
        const page = await openWithTabLog();

        try {
            const hello = await tabSaid(page);

            expect(hello).toHaveLength(1);
            expect(hello[0]!.url).toEndWith("/tabs");
            expect(typeof (JSON.parse(hello[0]!.body) as { tab?: unknown }).tab).toBe("string");

            await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
            await settle(page, 300);

            const goodbye = (await tabSaid(page)).at(-1)!;

            expect(goodbye.url).toEndWith("/tabs/gone");
            // The same tab as the hello: the module takes back the goodbye of the tab that comes back.
            expect(JSON.parse(goodbye.body)).toMatchObject(JSON.parse(hello[0]!.body) as Record<string, unknown>);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the row above a soft keyboard", () => {
    test("comes up with the keyboard, and stays while the keyboard has the room", async () => {
        const page = await openPhone();

        try {
            expect(await rowShown(page)).toBe(false);

            await keyboardUp(page);

            expect(await rowShown(page)).toBe(true);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("stays when the keys leave the terminal for a moment, and the window resizes", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            expect(await rowShown(page)).toBe(true);

            // The keys leave for a button, and the window tells the page that it changed size, as an iPad's does.
            await page.evaluate(() => {
                (document.activeElement as HTMLElement | null)?.blur();
                window.dispatchEvent(new Event("resize"));
            });
            await settle(page, 300);

            expect(await rowShown(page)).toBe(true);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("goes when the keyboard's room comes back", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            expect(await rowShown(page)).toBe(true);

            await keyboardDown(page);

            expect(await rowShown(page)).toBe(false);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("a keyboard that covers the window", () => {
    /**
     * iOS gives the keyboard no room: the page is still as tall as the window, and the keyboard covers its lower part.
     * A screen that is as tall as the window keeps the line being typed behind the keyboard, where it cannot be read.
     * The page takes the height of the part that is left, so the screen ends above the keyboard, and the pty gets the
     * rows that the smaller screen holds.
     */
    test("the screen ends above the keyboard, with the rows that are left", async () => {
        const page = await openIPhone();

        try {
            const before = await page.$$eval(".gt-row", (rows) => rows.length);

            await tap(page, ".gt-screen");
            await keyboardCovers(page, 420);

            const shown = await page.evaluate(() => {
                const screen = document.querySelector(".gt-screen") as HTMLElement;
                const keys = document.querySelector(".gt-keys") as HTMLElement | null;
                const cursor = document.querySelector(".gt-cursor") as HTMLElement;

                return {
                    screen: Math.round(screen.getBoundingClientRect().bottom),
                    keys: keys === null ? -1 : Math.round(keys.getBoundingClientRect().bottom),
                    cursor: Math.round(cursor.getBoundingClientRect().bottom),
                    rows: document.querySelectorAll(".gt-row").length,
                };
            });

            // The row of keys is up, and the screen is above it: the last line of the screen is above the keyboard.
            expect(shown.keys).toBeGreaterThan(0);
            expect(shown.screen).toBeLessThan(shown.keys);
            expect(shown.keys).toBeLessThanOrEqual(420);

            // The line being typed is one that fits: the cursor is above the keyboard, and the shell has those rows.
            expect(shown.cursor).toBeLessThanOrEqual(420);
            expect(shown.rows).toBeLessThan(before);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("the screen is whole again when the keyboard goes", async () => {
        const page = await openIPhone();

        try {
            const before = await page.$$eval(".gt-row", (rows) => rows.length);
            const bottom = () =>
                page.evaluate(() =>
                    Math.round((document.querySelector(".gt-screen") as HTMLElement).getBoundingClientRect().bottom),
                );

            await tap(page, ".gt-screen");
            await keyboardCovers(page, 420);

            expect(await bottom()).toBeLessThanOrEqual(420);

            await keyboardCovers(page, 844);

            expect(await bottom()).toBeGreaterThan(420);
            expect(await page.$$eval(".gt-row", (rows) => rows.length)).toBe(before);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("Control and the keys of the row", () => {
    test("tapping Control arms it once, keeps the row, and keeps the keys", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await tapKey(page, "⌃");

            expect(await rowShown(page)).toBe(true);
            expect(await armed(page)).toBe(true);
            expect(await focusedThing(page)).toBe("gt-input");

            await freshPrompt(page);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("Control and then a typed key sends that key with Control", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await tapKey(page, "⌃");

            const sent = await page.evaluate(async () => {
                const seen: unknown[] = [];
                const original = window.fetch.bind(window);

                window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
                    if (String(input).includes("/input")) seen.push(JSON.parse(String(init?.body)));

                    return original(input, init);
                }) as typeof fetch;

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
                await new Promise((resolve) => setTimeout(resolve, 300));
                window.fetch = original;

                return seen;
            });

            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ keys: [{ key: "KeyA", mods: { ctrl: true } }] });
            expect(await armed(page)).toBe(false);

            await freshPrompt(page);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a key of the row keeps the keys, so the keyboard stays up", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);

            for (const label of ["Esc", "Tab", "←", "/"]) {
                await tapKey(page, label);

                expect(await focusedThing(page)).toBe("gt-input");
            }

            // The keys went to the shell as well as to the row: a line of the shell's own is left half typed by them.
            await freshPrompt(page);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("the key that puts the keyboard away puts it away, and it stays away", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);

            const away = await page.$$(".gt-key.gt-round");

            await away.at(-1)!.tap();
            await settle(page, 600);

            expect(await rowShown(page)).toBe(false);
            expect(await focusedThing(page)).not.toBe("gt-input");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the app's own keys", () => {
    test("Command reaches the app, even with the keys in the terminal", async () => {
        const page = await openWithAppKeys("?panel=terminal", { mac: true });

        try {
            const sent: string[] = [];

            page.on("request", (request) => {
                if (request.url().includes("/input")) sent.push(request.postData() ?? "");
            });

            await page.keyboard.down("Meta");
            await page.keyboard.press("KeyB");
            await page.keyboard.up("Meta");
            await settle(page, 400);

            expect(await page.$eval("html", (html) => (html as HTMLElement).dataset.folded)).toBe("yes");
            // The shell has no byte for Command, so the key of it is not the shell's.
            expect(sent.join("\n")).not.toContain("KeyB");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a key that the app takes is the app's when the terminal has no focus", async () => {
        const page = await openWithAppKeys("?panel=terminal");

        try {
            // The keys are on a button of the bar, as they are after a person clicks the sidebar.
            await page.evaluate(() => (document.querySelector(".gt-surface") as HTMLElement).focus());

            const sent: string[] = [];

            page.on("request", (request) => {
                if (request.url().includes("/input")) sent.push(request.postData() ?? "");
            });

            await page.keyboard.down("Control");
            await page.keyboard.press("KeyB");
            await page.keyboard.up("Control");
            await settle(page, 400);

            expect(await page.$eval("html", (html) => (html as HTMLElement).dataset.folded)).toBe("yes");
            // The app took the key, so the shell heard nothing of the one that it was part of.
            expect(sent.join("\n")).not.toContain("KeyB");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("where the cursor sits", () => {
    /**
     * The cursor is drawn at the terminal's column, and the text is drawn by a font. If a glyph takes more room than the
     * cell that the terminal counted for it, the text runs past the cursor and a person sees a cursor that is not where
     * the next letter goes. The cursor may be a little ahead of the ink -- a line's last blanks are trimmed -- but the
     * ink must never pass it.
     */
    const where = (page: Page) =>
        page.evaluate(() => {
            const screenEl = document.querySelector(".gt-screen") as HTMLElement;
            const screen = screenEl.getBoundingClientRect();
            const cursor = (document.querySelector(".gt-cursor") as HTMLElement).getBoundingClientRect();
            const cellW = Number.parseFloat(getComputedStyle(screenEl).getPropertyValue("--gt-cell-w"));
            const rows = [...document.querySelectorAll(".gt-row")] as HTMLElement[];
            const top = cursor.top - screen.top;
            const row = rows.find((each) => Math.abs(each.getBoundingClientRect().top - screen.top - top) < 2);

            if (row === undefined) return null;

            const spans = [...row.children] as HTMLElement[];
            const ink = spans.length === 0 ? row.getBoundingClientRect().left : spans[spans.length - 1]!.getBoundingClientRect().right;

            return { cells: (cursor.left - ink) / cellW, text: row.textContent ?? "" };
        });

    /** How far the ink may be behind the cursor: the trailing blanks of a line, and no more. */
    const holdsTheLine = (found: { cells: number } | null) => {
        expect(found).not.toBeNull();
        expect(found!.cells).toBeGreaterThan(-0.2);
        expect(found!.cells).toBeLessThan(6);
    };

    test("after a prompt of the shape a shell draws", async () => {
        const page = await openPhone();

        try {
            // The shell's own prompt, drawn where there is nothing else on the line: a name, a branch in italics, an
            // editor's glyph and the prompt's arrow, which is what a person's line looks like.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value =
                    "clear; printf 'tom on \\033[3mcall-graphs:master\\033[0m \\uea71 \\u276f '; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a typed line", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "abcdefghijklmnopqrst";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 700);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a line of an editor's glyphs", async () => {
        const page = await openPhone();

        try {
            // A tree as a shell draws one with an icon font: the glyphs that a cell grid has to count like any other.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf '\\ue0b0\\uf121\\uf07b\\ue0b0\\uf121\\uf07b'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a line of wide glyphs", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf '你好世界你好世界'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    /**
     * The case that a person sees as "the letters go in the right place and the cursor is somewhere else": a font whose
     * glyphs are not one cell wide, which is what a proportional build of a Nerd font is. The page draws each run in the
     * cells that the terminal gave it, so the text cannot walk away from the cursor.
     */
    test("after a line drawn in a font that is not a grid", async () => {
        const page = await openPhone();

        try {
            await page.$eval(".gt-screen", (screen) => {
                (screen as HTMLElement).style.fontFamily = "Georgia, serif";
            });
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                // The widest letter there is, in a font that gives each glyph its own width.
                input.value = "printf 'WWWWWWWWWW'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });
});

describe("the font the screen draws with", () => {
    /**
     * Pi Pocket serves JetBrains Mono as "Pocket Mono" and the Nerd patch's icons as "Pocket Nerd Symbols", and both
     * are in every tab: a terminal that draws with them looks the same on a laptop, a phone and a machine with nothing
     * installed. The text font comes first in the stack, and the icons font beside it for the private use areas.
     */
    test("is Pocket Mono, with the icons of the symbols font beside it", async () => {
        const page = await openPhone();

        try {
            const declared = await page.$eval(".gt-screen", (screen) => getComputedStyle(screen).fontFamily);

            expect(declared.replaceAll("'", '"')).toStartWith('"Pocket Mono"');
            expect(declared).toContain("Pocket Nerd Symbols");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws an editor's icon, which is not in the text font at all", async () => {
        const page = await openPhone();

        try {
            const ink = await page.evaluate(async () => {
                const screen = document.querySelector(".gt-screen") as HTMLElement;
                const canvas = document.createElement("canvas");

                canvas.width = 32;
                canvas.height = 32;

                const context = canvas.getContext("2d") as CanvasRenderingContext2D;

                await document.fonts.ready;
                context.font = `24px ${getComputedStyle(screen).fontFamily}`;
                context.fillStyle = "#fff";
                context.fillText("\uf121", 2, 24);

                return [...context.getImageData(0, 0, 32, 32).data].reduce((sum, value, at) => (at % 4 === 3 ? sum + value : sum), 0);
            });

            expect(ink).toBeGreaterThan(0);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the width of a cell", () => {
    /**
     * The cell is measured from the font, and a font is not there when the page first draws: a browser paints with the
     * fallback and swaps the real font in when it has it. A cell measured against the fallback is a cell that is not the
     * font's, so every run is a little too wide or too narrow and the line overlaps itself -- which is what a person
     * sees as a garbled prompt.
     */
    test("is measured again when the font arrives after the first paint", async () => {
        const page = await browser.newPage();

        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.setRequestInterception(true);

        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));

        page.on("request", async (request) => {
            const url = request.url();

            // The app's font is held back, and the page is given another font to measure while it waits -- which is what
            // a browser does with its fallback, only with a font that is not a monospace at all.
            if (url.includes("JetBrainsMono.woff2")) {
                await held;
                await request.continue().catch(() => {});

                return;
            }

            if (request.resourceType() === "document") {
                const answer = await fetch(url);
                const body = (await answer.text()).replace("</head>", "<style>.gt-screen { font-family: Georgia, serif !important }</style></head>");

                await request.respond({ status: 200, contentType: "text/html", body }).catch(() => {});

                return;
            }

            await request.continue().catch(() => {});
        });

        try {
            await page.goto(`${URL_BASE}/`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector(".gt-panes .gt-row");
            await settle(page, 600);

            const before = await cellWidth(page);

            // The stand-in goes, and the font arrives: from here the page draws with another font than the one it
            // measured its cells with.
            await page.evaluate(() => {
                for (const style of document.querySelectorAll("style")) {
                    if ((style.textContent ?? "").includes("Georgia")) style.remove();
                }
            });
            release();
            await page.evaluate(() => document.fonts.ready);
            await settle(page, 800);

            const after = await cellWidth(page);
            const truth = await measuredCell(page);

            // The first measurement was the stand-in font's, and the one that counts is the font's the page ends with.
            expect(Math.abs(after - truth)).toBeLessThan(0.05);
        } finally {
            await page.close();
        }
    }, 30_000);

    /** The cell that the screen draws with. */
    const cellWidth = (page: Page) =>
        page.$eval(".gt-screen", (screen) =>
            Number.parseFloat(getComputedStyle(screen).getPropertyValue("--gt-cell-w")),
        );

    /** The width of the font's own cell, measured in the screen's font as it is now. */
    const measuredCell = (page: Page) =>
        page.$eval(".gt-screen", (screen) => {
            const probe = document.createElement("span");

            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
            probe.textContent = "0123456789";
            screen.append(probe);

            const width = probe.getBoundingClientRect().width / 10;

            probe.remove();

            return width;
        });
});

describe("rendering in a scaled container", () => {
    test("keeps adjacent prompt segments from overlapping", async () => {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
            if (request.isNavigationRequest()) {
                const response = await fetch(request.url());
                const html = (await response.text()).replace(
                    "</head>",
                    "<style id=opening-animation>body { transform: scale(0.9); transform-origin: top left }</style></head>",
                );
                await request.respond({ status: 200, contentType: "text/html", body: html });
            } else {
                await request.continue();
            }
        });

        try {
            await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-input");
            // End the opening animation after the terminal has measured itself.
            await page.evaluate(() => document.querySelector("#opening-animation")!.remove());
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;
                input.value = "printf '\\033[1mpi-pocket-rex\\033[0m on \\033[3mpi-pocket-rex\\033[0m END\\n'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some(
                (row) => row.textContent?.includes("pi-pocket-rex on pi-pocket-rex END"),
            ));
            const overlap = await page.evaluate(() => {
                const row = [...document.querySelectorAll(".gt-row")].find(
                    (element) => element.textContent?.includes("pi-pocket-rex on pi-pocket-rex END"),
                )!;
                const spans = [...row.children];
                const first = spans.find((element) => element.textContent === "pi-pocket-rex")!;
                const next = first.nextElementSibling!;
                const range = document.createRange();
                range.selectNodeContents(first);
                return range.getBoundingClientRect().right - next.getBoundingClientRect().left;
            });
            expect(overlap).toBeLessThan(0.5);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the width of a run", () => {
    /**
     * Each run of a row is drawn in exactly the cells that the terminal gave it, so its glyphs have to fit inside that
     * box: text that spills out of it is text that overlaps the run after it, which a person sees as a line whose words
     * are on top of each other. A bold or an italic that a font does not have is the usual reason -- a browser makes one
     * up by thickening the letters, and a made-up bold is wider than the cell.
     */
    const overflow = (page: Page) =>
        page.evaluate(() => {
            const rows = [...document.querySelectorAll(".gt-row")] as HTMLElement[];
            const worst: Array<{ text: string; over: number }> = [];

            for (const row of rows) {
                for (const span of [...row.children] as HTMLElement[]) {
                    const box = span.getBoundingClientRect().width;
                    const range = document.createRange();

                    range.selectNodeContents(span);

                    const ink = range.getBoundingClientRect().width;
                    const over = ink - box;

                    if (over > 1) worst.push({ text: (span.textContent ?? "").slice(0, 16), over: Math.round(over) });
                }
            }

            return worst;
        });

    const drawWith = async (page: Page, body: string) => {
        await page.evaluate((text: string) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = `clear; printf '${text}'; sleep 2\n`;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, body);
        await settle(page, 900);
    };

    test("holds a bold line and an italic line inside their cells", async () => {
        const page = await openPhone();

        try {
            await drawWith(page, "\\033[1mtom on call-graphs:master\\033[0m");
            expect(await overflow(page)).toEqual([]);

            await drawWith(page, "\\033[1;3mtom on call-graphs:master\\033[0m");
            expect(await overflow(page)).toEqual([]);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("never makes up a weight, which is a bold that is wider than a cell", async () => {
        const page = await openPhone();

        try {
            const synthesis = await page.$eval(".gt-screen", (screen) => {
                const style = getComputedStyle(screen);

                return { weight: style.fontSynthesisWeight, style: style.fontSynthesisStyle };
            });

            expect(synthesis.weight).toBe("none");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("typing into the terminal", () => {
    /**
     * A phone's keyboard gives one character at a time, and so does a person at a fast one. Each character was a request
     * of its own, and requests that are all on their way at once are answered in whatever order the server reaches them:
     * a line typed quickly came out as `pritfn`, and characters of it were never seen by the shell at all.
     */
    test("keeps a line that is typed quickly, whole and in order", async () => {
        const page = await openPanel();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();

                // One character a time, as a keyboard sends them, with no pause between: the burst that lost them.
                for (const char of "echo keptcharacters") {
                    input.value = char;
                    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
                }
            });
            // The line is whole before the test lets the page go: a page that closes with characters still on their way
            // pours them into whichever page a test opens next, since every page shows the same terminal.
            await page.waitForFunction(
                () =>
                    [...document.querySelectorAll(".gt-row")].some((row) =>
                        (row.textContent ?? "").includes("echo keptcharacters"),
                    ),
                { timeout: 15_000 },
            );

            const echoed = await page.evaluate(
                () =>
                    [...document.querySelectorAll(".gt-row")]
                        .map((row) => row.textContent ?? "")
                        .find((text) => text.includes("echo")) ?? "",
            );

            expect(echoed).toContain("echo keptcharacters");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the keyboard of a phone", () => {
    /**
     * A soft keyboard's backspace deletes a character of the field that the keys go through, and a field that is empty
     * after every keystroke has nothing to delete: the delete was no event at all, and holding the key repeated nothing.
     * The field keeps one invisible character for it to take, and each take is a backspace.
     */
    test("repeats a backspace that a soft keyboard holds", async () => {
        const page = await openPhone();

        try {
            /** Whether the line on the screen holds the letters that were typed for this test, and nothing else took them. */
            const shown = (letters: string) =>
                page.evaluate(
                    (wanted) =>
                        [...document.querySelectorAll(".gt-row")].some((row) => (row.textContent ?? "").includes(wanted)),
                    letters,
                );

            const softKey = (value: string) =>
                page.evaluate((typed) => {
                    const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                    input.focus();
                    input.value = typed;
                    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
                }, value);

            await softKey("kjqx");
            await page.waitForFunction(
                () => [...document.querySelectorAll(".gt-row")].some((row) => (row.textContent ?? "").includes("kjqx")),
                { timeout: 15_000 },
            );

            // Three deletes, as a held key sends them: each one takes the character that the field keeps.
            for (let each = 0; each < 4; each += 1) {
                await softKey("");
                await settle(page, 350);
            }

            expect(await shown("kjqx")).toBe(false);
        } finally {
            await page.close();
        }
    }, 30_000);

    /**
     * A phone has no wheel, and the scrollback is the only way back to what a program printed before: a finger moves the
     * view. Typing is looking for the prompt, so the view comes back to it -- a view that stays scrolled back types on a
     * line that a person cannot see.
     */
    test("moves through the scrollback under a finger, and comes back to the prompt on a key", async () => {
        const page = await openPhone();

        try {
            const first = () =>
                page.evaluate(
                    () =>
                        [...document.querySelectorAll(".gt-row")]
                            .map((row) => row.textContent?.trim() ?? "")
                            .filter((text) => text !== "")[0] ?? "",
                );

            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "clear; seq 1 80\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(
                () =>
                    Number(
                        [...document.querySelectorAll(".gt-row")]
                            .map((row) => row.textContent?.trim() ?? "")
                            .filter((text) => text !== "")[0],
                    ) > 1,
                { timeout: 15_000 },
            );

            const atBottom = await first();

            // A finger that travels down the screen brings the lines that are above the prompt into sight.
            await page.touchscreen.touchStart(200, 260);
            for (let y = 280; y <= 520; y += 20) await page.touchscreen.touchMove(200, y);
            await page.touchscreen.touchEnd();
            await settle(page, 1200);

            const scrolled = await first();

            expect(Number(scrolled)).toBeLessThan(Number(atBottom));

            // The keys come back to the prompt, and the line that they are typed on is on the screen.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "x";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 1200);

            expect(Number(await first())).toBeGreaterThan(Number(scrolled));
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the row's modifiers", () => {
    /** A command in the shell, as a person types it: the soft keyboard's own way, which is text and not a key. */
    const softType = (page: Page, typed: string) =>
        page.evaluate((text) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = text;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, typed);

    /**
     * The row's Control, Shift, and Alt arm the next key, and the key that a phone has for a letter is the soft keyboard
     * below the row: it gives the letter as text, never as a key event, so the armed modifier was dropped and ⌃ then `c`
     * sent a plain `c` -- the interrupt that a phone has no other way to send.
     */
    test("go with the letters that the soft keyboard types", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await freshPrompt(page);

            // The bytes that reach the shell, in hex: each armed modifier and then a letter.
            await softType(page, "od -An -tx1\n");
            await settle(page, 900);

            for (const [modifier, letter] of [["⌃", "g"], ["⇧", "a"], ["⌥", "b"]] as const) {
                await tapKey(page, modifier);
                await softType(page, letter);
                await settle(page, 350);
            }

            // The first ^D flushes what od has, and the next one, on a line of its own, is the end of its input.
            await softType(page, "\u0004\u0004");
            await settle(page, 1500);

            const bytes = await page.evaluate(() =>
                [...document.querySelectorAll(".gt-row")]
                    .map((row) => row.textContent ?? "")
                    .join(" ")
                    .replace(/\s+/g, " "),
            );

            // ^G is Control and g, 41 is the shifted letter, and 1b 62 is Alt and b, which a terminal reads as a meta key.
            expect(bytes).toContain("07 41 1b 62");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the bar's buttons", () => {
    /** How many of the buttons that a selector names the browser draws. */
    const drawn = (page: Page, selector: string) =>
        page.$$eval(selector, (buttons) => buttons.filter((button) => getComputedStyle(button).display !== "none").length);

    /**
     * A phone's panel has no room for six buttons: the shell's own, the way out, and the end keep theirs, and the text's
     * size waits until the panel is wide enough for it. The rule that folds them away named the button alone, and the
     * bar's own rule for a button is a class stronger, so a phone drew all six and squeezed the session's name to a
     * hundred pixels.
     */
    test("folds the text's size away in a narrow panel, and keeps it in a wide one", async () => {
        const phone = await openPhone();
        const wide = await openPanel();

        try {
            expect(await drawn(phone, ".gt-font")).toBe(0);
            expect(await drawn(phone, ".gt-restart")).toBe(1);
            expect(await drawn(phone, ".gt-end")).toBe(1);

            expect(await drawn(wide, ".gt-font")).toBe(2);
        } finally {
            await phone.close();
            await wide.close();
        }
    }, 30_000);
});

describe("the surface it shows on", () => {
    test("says which surface a tap gives, and moves the shell there", async () => {
        const page = await openPanel();

        try {
            expect(await surfaceOf(page)).toBe("panel");
            expect(await page.$eval(".gt-surface", (button) => button.getAttribute("title"))).toBe("As a page");

            // A word that only the shell's own output has: the command line holds it once, and the answer twice.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf '%s\\n' on-the-page\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(
                (word) => ((document.querySelector(".gt-screen")?.textContent ?? "").split(word).length - 1) >= 2,
                { timeout: 15_000 },
                "on-the-page",
            );

            await tap(page, ".gt-surface");
            await settle(page, 600);

            // The page draws the same shell: the word is on the screen that it got from the server.
            expect(await surfaceOf(page)).toBe("page");
            expect(await page.$eval(".gt-screen", (screen) => screen.textContent ?? "")).toContain("on-the-page");
            expect(await page.$eval(".gt-surface", (button) => button.getAttribute("title"))).toBe("As a panel");

            await tap(page, ".gt-surface");
            await settle(page, 600);

            expect(await surfaceOf(page)).toBe("panel");
            expect(await page.$eval(".gt-screen", (screen) => screen.textContent ?? "")).toContain("on-the-page");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("how a shell's end is read", () => {
    /** What a shell writes to leave: Ctrl-D at its prompt, as the pty reads it. */
    const leave = (page: Page) =>
        page.evaluate(() => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.value = "\u0004";
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });

    /** A command in the shell, as a person types it. */
    const type = (page: Page, command: string) =>
        page.evaluate((typed) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = typed;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, command);

    const closed = (page: Page) =>
        page.waitForFunction(() => document.querySelector(".gt-panes") === null, { timeout: 15_000 });

    test("a shell that a person leaves takes the panel with it, whatever its last command said", async () => {
        const page = await openPanel();

        try {
            // A command that fails, so that the shell's status is 1: that is what a Ctrl-D at its prompt leaves it with.
            await type(page, "false\n");
            await settle(page, 900);
            await leave(page);
            await closed(page);

            // The panel went with the shell, and said nothing about the command that was before it.
            expect(await page.$(".gt-note")).toBeNull();
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a shell that the app ends takes the panel with it, and says nothing", async () => {
        const page = await openPanel();

        try {
            await tap(page, ".gt-end");
            await closed(page);

            expect(await page.$(".gt-note")).toBeNull();
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a shell that a signal stops keeps the panel, and says what stopped it", async () => {
        const page = await openPanel();

        try {
            // A signal that no shell can catch: the shell is gone, and Rex reports that it left no code of its own.
            await type(page, "kill -9 $$\n");

            await page.waitForSelector(".gt-note-said", { timeout: 15_000 });

            expect(await page.$eval(".gt-note-said", (note) => note.textContent)).toBe("The shell was stopped.");

            // A shell that a person leaves takes its panel with it a moment later. This one stays, and the wait is longer
            // than that moment: the note is there to read, and a check a moment after it appeared saw a panel that the
            // timer had not yet taken.
            await settle(page, 900);

            expect(await page.$(".gt-panes")).not.toBeNull();
            expect(await page.$eval(".gt-note-said", (note) => note.textContent)).toBe("The shell was stopped.");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the bar above the screen", () => {
    /** The bar's buttons, by the class that says what they do. */
    const bar = (page: Page) =>
        page.$eval(".gt-bar", (element) => {
            const buttons = [...element.querySelectorAll(".button")] as HTMLElement[];
            return {
                words: (element.textContent ?? "").replaceAll("\n", "").trim(),
                icons: buttons.map((each) => ({
                    label: each.getAttribute("title") ?? "",
                    svg: each.querySelector("svg") !== null,
                })),
            };
        });

    test("says which Rex session it is, and nothing about the shell's title or folder", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf $'\\033]0;pi-pocket-rex\\007'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 700);

            const shown = await page.evaluate(() => ({
                name: document.querySelector(".gt-bar .gt-name") !== null,
                folder: document.querySelector(".gt-bar .gt-cwd") !== null,
                title: document.querySelector(".gt-bar .gt-title") !== null,
                words: (document.querySelector(".gt-bar")?.textContent ?? "").trim(),
            }));

            // The title that a shell sets and its folder are the shell's own, and the bar is not the place for them.
            expect(shown.name).toBe(false);
            expect(shown.title).toBe(false);
            expect(shown.folder).toBe(false);
            expect(shown.words).not.toContain("pi-pocket-rex");
            expect(shown.words).not.toContain("/");

            // What it does say is the Rex session that the terminal is on: the Pi Pocket session around it is a
            // different thing, and the bar is the only place that says which one this is.
            expect(await page.$eval(".gt-where", (where) => where.textContent?.trim() ?? "")).toContain("Preview");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws every button in the bar at one size", async () => {
        // A panel wide enough for the whole bar, which is where every button is on the page at once.
        const page = await openWide();

        try {
            // A drawing of a box and a letter are the same button: one height, one size of its letters or its icon.
            const sizes = await page.$eval(".gt-bar", (actions) => {
                // The text size's buttons fold away in a narrow panel, and a button that is not there has no size.
                const buttons = ([...actions.querySelectorAll(".button")] as HTMLElement[]).filter(
                    (each) => each.getClientRects().length > 0,
                );

                return buttons.map((each) => {
                    const icon = each.querySelector("svg");

                    const rect = each.getBoundingClientRect();

                    return {
                        label: each.getAttribute("title") ?? "",
                        box: Math.round(rect.height * 10) / 10,
                        width: Math.round(rect.width * 10) / 10,
                        letters: Number.parseFloat(getComputedStyle(each).fontSize),
                        icon: icon === null ? null : Math.round(icon.getBoundingClientRect().height * 10) / 10,
                    };
                });
            });

            const boxes = new Set(sizes.map((each) => each.box));
            const widths = new Set(sizes.map((each) => each.width));
            const letters = new Set(sizes.map((each) => each.letters));

            // The buttons of the bar, and the two that say what they do with a drawing.
            expect(sizes.length).toBeGreaterThanOrEqual(4);
            expect([...boxes]).toHaveLength(1);
            expect([...widths]).toHaveLength(1);
            expect([...letters]).toHaveLength(1);

            // An icon is drawn at the size of the letters beside it, which is what makes its button that size too.
            for (const each of sizes) {
                if (each.icon !== null) expect(Math.abs(each.icon - each.letters)).toBeLessThan(0.6);
            }
        } finally {
            await page.close();
        }
    }, 30_000);

    test("keeps the shell's own buttons on the left and the text size on the right", async () => {
        const page = await openWide();

        try {
            const row = await page.$eval(".gt-bar", (bar) => {
                const buttons = [...bar.querySelectorAll(".button")].filter((each) => each.getClientRects().length > 0);
                const at = (label: string) => {
                    const button = buttons.find((each) => each.getAttribute("title") === label);

                    return button === undefined ? null : button.getBoundingClientRect();
                };
                const gap = (left: string, right: string) => {
                    const one = at(left);
                    const other = at(right);

                    return one === null || other === null ? null : Math.round((other.left - one.right) * 10) / 10;
                };

                return {
                    order: buttons.map((each) => each.getAttribute("title")),
                    button: Math.round(buttons[0]!.getBoundingClientRect().width),
                    beforeEnd: gap("Larger text", "End"),
                    endsRight: Math.round(window.innerWidth - at("End")!.right),
                };
            });

            // The buttons about which terminal this is on the left -- a new shell, and another session -- and on the
            // other side, the text size and the end.
            expect(row.order.slice(0, 2)).toEqual(["New shell", "Another session"]);
            expect(row.order.at(-1)).toBe("End");
            expect(row.beforeEnd).toBeCloseTo(row.button, 0);
            // The two groups sit at the two ends of the bar, not gathered at one.
            expect(row.endsRight).toBeLessThan(20);
            expect(row.order.indexOf("Smaller text")).toBeGreaterThan(row.order.indexOf("New shell"));
        } finally {
            await page.close();
        }
    }, 30_000);

    test("says what every button does with an icon", async () => {
        // A panel wide enough for the whole bar: a narrow one folds the text size's buttons away.
        const page = await openWide();

        try {
            const marked = await page.$$eval(".gt-actions .button", (buttons) =>
                buttons
                    .filter((each) => each.getClientRects().length > 0)
                    .map((each) => ({ label: each.getAttribute("title") ?? "", svg: each.querySelector("svg") !== null })),
            );

            // A drawing says it in one language, where a word has to be translated or shortened to fit.
            for (const button of marked) expect(button).toEqual({ label: button.label, svg: true });
            expect(marked.map((each) => each.label)).toContain("Smaller text");
            expect(marked.map((each) => each.label)).toContain("Larger text");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the room inside the frame", () => {
    /**
     * A frame with a rounded corner and text that begins at the corner's own edge looks like a page that was cut to fit.
     * The screen keeps a margin of its own inside its border, and the columns and rows that it asks the pty for are the
     * ones that fit in that margin: a count that took the padding for room for a column would run under the frame.
     */
    test("keeps the screen's text off its frame, and counts only the room that is left", async () => {
        const page = await openWide();

        try {
            // A line longer than the terminal is wide: it wraps at the last column, so the row's own end is the edge.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "clear; printf 'x%.0s' $(seq 1 300)\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            const room = await page.evaluate(() => {
                const screen = document.querySelector(".gt-screen") as HTMLElement;
                const style = getComputedStyle(screen);
                const frame = screen.getBoundingClientRect();
                const content = frame.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
                const width =
                    screen.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
                const right = Math.max(
                    ...[...document.querySelectorAll(".gt-row > span")].map((span) => span.getBoundingClientRect().right),
                );
                const row = document.querySelector(".gt-row") as HTMLElement;
                const cursor = document.querySelector(".gt-cursor") as HTMLElement;

                return {
                    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
                        (each) => Math.round(Number.parseFloat(each) * 10) / 10,
                    ),
                    radius: Math.round(Number.parseFloat(style.borderTopLeftRadius)),
                    width: Math.round(width),
                    cell: Number.parseFloat(style.getPropertyValue("--gt-cell-w")),
                    // Where the text begins, and how far the row of it reaches, both from the frame's inner edge.
                    startsAt: Math.round(row.getBoundingClientRect().left - content),
                    reaches: Math.round(right - content),
                    cursorAt: Math.round(cursor.getBoundingClientRect().top - frame.top),
                    top: Math.round(row.getBoundingClientRect().top - frame.top),
                };
            });

            // A margin inside the frame, a pixel less than the corner that it runs beside, and the same on every side.
            expect(new Set(room.padding).size).toBe(1);
            expect(room.padding[0]!).toBeGreaterThan(4);
            expect(room.padding[0]!).toBeLessThanOrEqual(room.radius);

            // The text begins at that margin, and the row of it ends inside the margin on its own side.
            expect(Math.abs(room.startsAt)).toBeLessThanOrEqual(1);
            expect(room.reaches).toBeLessThanOrEqual(room.width + 1);
            expect(room.reaches).toBeGreaterThan(room.width - room.cell * 2);
            expect(room.top).toBeGreaterThanOrEqual(room.padding[0]! - 1);
            expect(room.cursorAt).toBeGreaterThanOrEqual(room.padding[0]! - 1);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("a selection on the screen", () => {
    /**
     * A person who drags over a line means to have it. The terminal writes the selection to the clipboard as the drag
     * ends -- the gesture that a browser wants for the clipboard -- and says nothing, since selecting is not a command
     * that asks to be answered. The page's own clipboard is stubbed here: what a browser lets a page write is its
     * business, and what this proves is that the selection is offered to it.
     */
    test("goes to the clipboard as the drag ends, without a word", async () => {
        const page = await openWide();

        try {
            await page.evaluate(() => {
                const clipboard = { wrote: [] as string[] };

                Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: { writeText: (text: string) => (clipboard.wrote.push(text), Promise.resolve()) },
                });
                (window as unknown as { clipboard: typeof clipboard }).clipboard = clipboard;

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf 'take this line\\n'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some((row) => row.textContent?.includes("take this line")), {
                timeout: 15_000,
            });

            const wrote = await page.evaluate(async () => {
                const row = [...document.querySelectorAll(".gt-row")].find((each) => each.textContent?.includes("take this line"))!;
                const screen = document.querySelector(".gt-screen")!;
                const range = document.createRange();

                range.selectNodeContents(row);
                getSelection()!.removeAllRanges();
                getSelection()!.addRange(range);

                // The end of a drag, as the screen hears it.
                screen.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 100));

                return (window as unknown as { clipboard: { wrote: string[] } }).clipboard.wrote;
            });

            expect(wrote).toHaveLength(1);
            expect(wrote[0]).toContain("take this line");

            // And a selection that is empty, or outside the screen, writes nothing.
            const quiet = await page.evaluate(async () => {
                const screen = document.querySelector(".gt-screen")!;
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                getSelection()!.removeAllRanges();
                input.focus();
                screen.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 100));

                return (window as unknown as { clipboard: { wrote: string[] } }).clipboard.wrote.length;
            });

            expect(quiet).toBe(1);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("a paste while text is selected", () => {
    /**
     * ⌘V and Ctrl+V paste through the browser, which pastes into the field that has the focus. A selection takes the
     * focus off that field, so the terminal reads the clipboard itself, inside the gesture that the key makes, and
     * pastes it as a program's paste. The selection stays: it is what the person copied.
     */
    test("pastes what the clipboard holds, and leaves the selection alone", async () => {
        const page = await openWide();

        try {
            await page.evaluate(() => {
                Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: {
                        writeText: () => Promise.resolve(),
                        readText: () => Promise.resolve("echo from-the-clipboard"),
                    },
                });

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf 'keep me selected\\n'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some((row) => row.textContent?.includes("keep me selected")), {
                timeout: 15_000,
            });

            const selected = await page.evaluate(() => {
                const row = [...document.querySelectorAll(".gt-row")].find((each) => each.textContent?.includes("keep me selected"))!;
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;
                const range = document.createRange();

                range.selectNodeContents(row);
                getSelection()!.removeAllRanges();
                getSelection()!.addRange(range);
                input.blur();

                return getSelection()!.toString().length;
            });

            expect(selected).toBeGreaterThan(0);

            await page.keyboard.down("Control");
            await page.keyboard.press("v");
            await page.keyboard.up("Control");
            await settle(page, 900);
            await page.keyboard.press("Enter");

            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some((row) => row.textContent?.trim() === "from-the-clipboard"), {
                timeout: 15_000,
            });

            expect(await page.evaluate(() => getSelection()!.toString())).toContain("keep me selected");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the clipboard's fallback", () => {
    /**
     * A browser that refuses the clipboard outright leaves the copy to a hidden field and `execCommand`, which selects
     * that field: a person's selection is gone unless it is put back, and the copy takes away the thing it copied.
     */
    test("gives the person's selection back after it copies", async () => {
        const page = await openWide();

        try {
            const kept = await page.evaluate(async () => {
                Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: { writeText: () => Promise.reject(new Error("no")) },
                });

                const calls: string[] = [];

                (window as unknown as { copies: string[] }).copies = calls;
                document.execCommand = (name: string) => (calls.push(name), true);

                const screen = document.querySelector(".gt-screen")!;
                const range = document.createRange();

                range.selectNodeContents(document.querySelector(".gt-row")!);
                getSelection()!.removeAllRanges();
                getSelection()!.addRange(range);

                screen.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 200));

                return {
                    copied: (window as unknown as { copies: string[] }).copies,
                    word: document.querySelector(".gt-row")!.textContent ?? "",
                    selected: getSelection()!.toString().length > 0,
                    ranges: getSelection()!.rangeCount,
                };
            });

            // The copy happened, by the fallback, and the selection that it copied is still the person's.
            expect(kept.copied).toEqual(["copy"]);
            expect(kept.word.length).toBeGreaterThan(0);
            expect(kept.selected).toBe(true);
            expect(kept.ranges).toBe(1);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the keys while text is selected", () => {
    /**
     * A person selects a line on the screen to copy it, and goes on typing. A browser moves the focus off the terminal's
     * input as the selection starts -- and focusing it again clears the selection -- so the keys have to reach the
     * terminal without the focus, or the person has to dismiss the selection before they can type.
     */
    test("reach the shell, and the selection stays", async () => {
        const page = await openWide();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf 'select me please\\n'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some((row) => row.textContent?.includes("select me please")), {
                timeout: 15_000,
            });

            // What a drag over the text leaves: a selection, and the focus back on the page.
            const selected = await page.evaluate(() => {
                const row = [...document.querySelectorAll(".gt-row")].find((each) => each.textContent?.includes("select me please"))!;
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;
                const range = document.createRange();

                range.selectNodeContents(row);
                getSelection()!.removeAllRanges();
                getSelection()!.addRange(range);
                input.blur();

                return { text: getSelection()!.toString(), focused: document.activeElement === input };
            });

            expect(selected.text).toContain("select me please");
            expect(selected.focused).toBe(false);

            await page.keyboard.type("echo typed-with-a-selection");
            await page.keyboard.press("Enter");

            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some((row) => row.textContent?.includes("typed-with-a-selection")), {
                timeout: 15_000,
            });

            // The selection is still there to copy, since typing did not have to move the focus to reach the shell.
            expect(await page.evaluate(() => getSelection()!.toString())).toContain("select me please");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the screen", () => {
    test("draws what the shell prints", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.value = "echo the-screen-works\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            const text = await page.$eval(".gt-screen", (screen) => screen.textContent ?? "");

            expect(text).toContain("the-screen-works");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("copies what a program copies with OSC 52", async () => {
        const page = await openPhone();

        try {
            const copied = await page.evaluate(async () => {
                const written: string[] = [];
                const clipboard = navigator.clipboard;

                Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
                });

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.value = "printf '\\033]52;c;aGVsbG8=\\a'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 900));
                Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

                return written;
            });

            expect(copied).toEqual(["hello"]);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws the cursor that a program asks for", async () => {
        const page = await openPhone();

        try {
            // A program asks for a bar and then waits, so that the shell's own prompt does not paint over the answer.
            const bar = await shapeOf(page, "\\033[6 q");

            expect(bar.look).toBe("bar");
            expect(bar.width).toBeLessThan(4);

            const block = await shapeOf(page, "\\033[2 q");

            expect(block.look).toBe("block");
            expect(block.width).toBeGreaterThan(4);
        } finally {
            await page.close();
        }
    }, 30_000);

    /** Runs a program that asks for a cursor shape, and gives back what the screen drew while it ran. */
    async function shapeOf(page: Page, escape: string): Promise<{ look: string; width: number }> {
        await page.evaluate((codes: string) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = `printf '${codes}'; sleep 2\n`;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, escape);
        await settle(page, 900);

        const shape = (await page.$eval(".gt-cursor", (cursor) => ({
            look: (cursor as HTMLElement).dataset.look ?? "",
            width: Number.parseFloat(getComputedStyle(cursor).width),
        }))) as { look: string; width: number };

        // The shell takes the screen back when the program ends, and with it its own cursor shape.
        await settle(page, 2200);

        return shape;
    }
});

describe("the picker", () => {
    test("shows a machine with the sessions under it, and the row that starts one", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-machine");

            const machine = await page.$eval(".gt-machine-name", (one) => one.textContent ?? "");
            const sessions = await page.$$eval(".gt-session:not(.gt-new) .gt-session-name", (rows) =>
                rows.map((row) => row.textContent ?? ""),
            );

            // The preview runs a Rex server of its own, with one session in it, and it is this machine's.
            expect(machine).not.toBe("");
            expect(sessions).toContain("Preview");
            expect(await page.$(".gt-new")).not.toBeNull();
        } finally {
            await page.close();
        }
    }, 30_000);

    test("opens the terminal of the session that a person taps", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-session");

            await tap(page, ".gt-session");

            // The terminal page shows the session's own screen: a prompt, drawn by the engine.
            await page.waitForSelector(".gt-screen", { timeout: 20_000 });
            await page.waitForFunction(
                () => (document.querySelector(".gt-screen")?.textContent ?? "").trim().length > 0,
                { timeout: 20_000 },
            );

            expect(await page.$(".gt-panes")).not.toBeNull();
        } finally {
            await page.close();
        }
    }, 40_000);

    test("ticks the session that the terminal shows, and goes back to this conversation's own", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-own .gt-session");

            // Nothing chosen yet: the conversation's own terminal is the one that the tick is on.
            expect(await page.$eval(".gt-own .gt-session", (row) => row.className)).toContain("is-picked");

            const session = await page.$(".gt-machine .gt-session");

            await session!.click();
            await page.waitForSelector(".gt-bar", { timeout: 20_000 });

            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-session.is-picked");

            const ticked = await page.$$eval(".gt-session.is-picked .gt-session-name", (rows) => rows.map((row) => row.textContent));

            expect(ticked).toEqual(["Preview"]);

            // And back: the conversation's own terminal is the one that a reload of the terminal opens again.
            await page.click(".gt-own .gt-session");
            await page.waitForSelector(".gt-bar", { timeout: 20_000 });

            expect(await page.evaluate(() => localStorage.getItem("x.rex.target"))).toBeNull();
        } finally {
            await page.close();
        }
    }, 40_000);

    test("opens the picker from the terminal's own bar", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=terminal`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-bar .gt-sessions");

            await tap(page, ".gt-bar .gt-sessions");

            await page.waitForSelector(".gt-machine", { timeout: 20_000 });
        } finally {
            await page.close();
        }
    }, 40_000);

    test("names a machine in two fields, and the list of machines then has it", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-new");

            const before = await page.$$eval(".gt-machine", (rows) => rows.length);

            await tap(page, ".gt-picker-foot .gt-new:last-of-type");
            await page.waitForSelector(".gt-add-name");

            // One machine for each run: the preview's Rex server keeps the list, and Rex refuses a name it has.
            await page.type(".gt-add-name", `build-${Date.now() % 100_000}`);
            await page.type(".gt-add-host", "build.example.ts.net");
            // The two buttons of the card, in the order that they are drawn: Cancel, then Add.
            await page.click(".gt-add-actions .button:last-child");

            await page.waitForFunction(
                (was) => document.querySelectorAll(".gt-machine").length > was,
                { timeout: 20_000 },
                before,
            );
        } finally {
            await page.close();
        }
    }, 40_000);

    test("starts a session from the last row, and the list then has two", async () => {
        const page = await openPhone();

        try {
            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-new");

            const before = await page.$$eval(".gt-session:not(.gt-new)", (rows) => rows.length);

            await tap(page, ".gt-new");
            await page.waitForSelector(".gt-screen", { timeout: 20_000 });

            await page.goto(`${URL_BASE}/?page=sessions`, { waitUntil: "networkidle2" });
            await page.waitForFunction(
                (was) => document.querySelectorAll(".gt-session:not(.gt-new)").length > was,
                { timeout: 20_000 },
                before,
            );
        } finally {
            await page.close();
        }
    }, 40_000);
});
