/**
 * The screen of one terminal: a grid of rows and runs that `rex.ts` sends, drawn as DOM, and a hidden
 * textarea that turns keystrokes into the key events that Ghostty's encoder reads.
 */

/** How long a wheel event waits for another one before it is a notch of its own rather than a turn of a trackpad. */
const NOTCH_MS = 30;

/** The samples of a finger that is moving, and how far back a throw of it is measured: the last quarter second. */
const THROW_WINDOW_MS = 100;

/** How fast a throw may be, in pixels a millisecond, and how slow it is when the view stops on its own. */
const THROW_FASTEST = 4;
const THROW_SLOWEST = 0.03;

/** How long a throw takes to lose most of its speed: its distance is its speed times this. */
const THROW_MS = 325;

/** The bits of a run's `flags`, as `pty-host.ts` writes them. */
const BOLD = 1;
const FAINT = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const STRIKE = 16;
const OVERLINE = 32;
const BLINK = 64;
const INVERSE = 128;
const INVISIBLE = 256;

/**
 * How much of a box is in sight: the box, and the part of the window that a keyboard leaves.
 *
 * A phone's keyboard does not change the window -- it covers the lower part of it -- so a box that runs to the bottom of
 * the window reaches below what a person can see. The visual viewport is the part that is left, and a box that is as
 * tall as the two share keeps its last line above the keyboard, where the line being typed can be read.
 */
export function visibleHeight({ top, bottom }, { top: viewTop, height: viewHeight }) {
    return Math.max(0, Math.min(bottom, viewTop + viewHeight) - Math.max(top, viewTop));
}

/**
 * Whether a shell ended the way a person ends one, and so whether its panel goes without a word.
 *
 * A person leaves a shell with `exit`, or with Ctrl-D at its prompt, and the shell keeps the status of its last command:
 * a `false` and then Ctrl-D is a code of 1, and the panel that says so is a panel in the way. Rex gives a program that a
 * signal ended the code -1, because it left no code of its own, and that is the end worth a word.
 */
export function endedQuietly(state) {
    if (typeof state.signal === "string" && state.signal !== "") return false;

    return state.exitCode === null || state.exitCode === undefined || state.exitCode >= 0;
}

/**
 * The height of the window with no keyboard over it.
 *
 * A window that got shorter lost that height to a keyboard, and a moment without the keys -- a finger on a button, a
 * panel taking the room -- does not make the shorter window the one at rest. So the rest is the tallest that the window
 * has been, and only a turn of the device, which is a new width, makes a new one.
 */
export function restingHeight(previous, { height, width, lastWidth, typing }) {
    if (width !== lastWidth) return height;
    if (typing) return previous;

    return previous === 0 ? height : Math.max(previous, height);
}

/**
 * Whether a soft keyboard has the window, and so whether the row of keys that it has not got belongs above it.
 *
 * A keyboard either takes a keyboard's worth of height -- the drop from the window at rest -- or covers the window
 * without changing it, which is what a phone does. The third way is for a page that opens while the keyboard is already
 * up, when there is no drop to see: a window on a touch screen that is much shorter than the screen.
 *
 * The keyboard's room is the truth about the keyboard: once it is there, a moment without the focus is not a keyboard
 * that left, so a row that was up stays up until the room comes back.
 */
export function keyboardShown({ height, rest, viewportHeight, innerHeight, availHeight, coarse, typing, wasUp }) {
    const dropped = rest > 0 && height < rest - 100;
    const covered = viewportHeight !== undefined && viewportHeight < innerHeight - 100;
    const cramped = coarse === true && availHeight !== undefined && innerHeight < availHeight * 0.72;

    return (dropped || covered || cramped) && (typing === true || wasUp === true);
}

/** The keys that go to the terminal as a key, not as the text that they would write. */
const KEYS_SENT_AS_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "Enter",
    "NumpadEnter",
    "Tab",
    "Escape",
    "Backspace",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
]);

/**
 * The character that the hidden field keeps, so that a soft keyboard's backspace has something to delete.
 *
 * A delete on an empty field is no event at all: the field is emptied after every keystroke, so the delete key did
 * nothing and holding it repeated nothing. The field holds this one invisible character instead, and a delete that takes
 * it is the backspace that the program asked for.
 */
const KEEPER = "\u200b";

/** What takes a key for itself: a field of the app's own, which the terminal must not take the key from. */
const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']";

/**
 * Whether the keyboard has a Command key, which belongs to the app and never to a shell: ⌘B is the app's sidebar, and a
 * shell has no byte for it. A Control key is the shell's on every keyboard, since readline and an editor read it.
 */
const APPLE = /Mac|iPhone|iPad/.test(`${globalThis.navigator?.platform ?? ""} ${globalThis.navigator?.userAgent ?? ""}`);

/** How a run's flags change the look of its text. */
function decoration(flags) {
    const lines = [];

    if (flags & UNDERLINE) lines.push("underline");
    if (flags & STRIKE) lines.push("line-through");
    if (flags & OVERLINE) lines.push("overline");

    return lines.join(" ");
}

/** One span of a row, reused from the frame before when the row keeps its shape. */
function paint(span, run) {
    const [text, fg, bg, flags, columns] = run;

    if (span.textContent !== text) span.textContent = text;

    // The span is as wide as the cells that the terminal gave it, whatever the font makes of the glyphs inside: a font
    // that draws one wider, or narrower, than a cell would otherwise push everything after it out of line, and the
    // cursor, which is drawn at the terminal's column, would sit somewhere that the text is not.
    span.style.display = "inline-block";
    span.style.verticalAlign = "top";
    span.style.width = columns === undefined ? "" : `calc(var(--gt-cell-w, 1ch) * ${columns})`;

    const style = span.style;

    style.color = fg;
    style.backgroundColor = bg;
    style.fontWeight = flags & BOLD ? "700" : "";
    style.fontStyle = flags & ITALIC ? "italic" : "";
    style.opacity = flags & FAINT ? "0.65" : "";
    style.textDecoration = decoration(flags);
    style.visibility = flags & INVISIBLE ? "hidden" : "";

    // Both colors are the theme's own: a swap is the theme's other end.
    const swapped = (flags & INVERSE) !== 0 && fg === "" && bg === "";

    if (span.classList.contains("gt-inverse") !== swapped) span.classList.toggle("gt-inverse", swapped);
}

/**
 * The key that a character types, as a keyboard names it, or null for a character that has no key of its own.
 *
 * Ctrl+C and Alt+B are the row's modifiers on a letter, and a letter that a soft keyboard gives is text, not a key: its
 * name is what the encoder reads the modifier with. A character that is not a letter or a digit keeps its own way -- the
 * row has keys for the punctuation that a phone hides, and its modifiers go with those.
 */
function keyOfText(char) {
    if (/^[a-z]$/i.test(char)) return `Key${char.toUpperCase()}`;
    if (/^[0-9]$/.test(char)) return `Digit${char}`;

    return null;
}

/** A keydown as the key event that `libghostty-vt`'s encoder reads, or null for a key it does not know. */
function keyEventOf(event) {
    if (event.isComposing || event.key === "Dead" || event.key === "Process" || event.code === "") return null;

    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const key = {
        key: event.code || event.key,
        mods: {
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
            super: event.metaKey,
        },
    };

    if (printable) key.utf8 = event.key;

    return key;
}

export class TerminalView {
    #pocket;
    #container;
    #onState;
    #onClose;
    #keyboardUp;
    #target;
    #state = {};

    #screen = null;
    #grid = null;
    #cursorEl = null;
    #input = null;
    #font = 13;
    #cell = { width: 8, height: 17 };

    #id = null;
    #seq = null;
    #reading = false;
    #cols = 80;
    #rows = 24;
    #rowEls = [];
    #rowSpans = [];
    #stashed = new Map();
    #stops = [];
    #eventStops = [];
    #armed = { ctrl: false, shift: false, alt: false };
    #keepUntil = 0;
    #grabTimer = null;
    #focusTimer = null;
    #reported = false;
    #at = null;
    #resizeTimer = null;
    #opening = false;
    #destroyed = false;
    #flashTimer = null;
    #bellTimer = null;
    /** The distance that a wheel or a finger has moved, less than a line of it. */
    #scrollPixels = 0;
    /** When a finger last moved the view: a tap and a selection belong to a finger that stayed. */
    #pannedAt = 0;
    #pendingScroll = 0;
    /** The distance that a wheel has turned and the view has not moved by yet, in pixels. */
    #turnPixels = 0;
    #turnTimer = null;
    /** When a wheel last turned, so that a notch of its own is told from the stream of a trackpad. */
    #turnAt = 0;
    /** The places that a finger has been, and when: what its throw is when it leaves the screen. */
    #finger = [];
    /** How fast the view is going after a finger left, in pixels a millisecond, and the frame that carries it. */
    #throwSpeed = 0;
    #throwTimer = null;
    #throwAt = 0;
    /** Whether a scroll of the view is on its way: one is, so that a wheel's turn moves the view in one piece. */
    #scrolling = false;
    /** What resolves when no scroll of the view is on its way. */
    #scrollIdle = Promise.resolve();
    /** What has not been sent to the terminal yet, oldest first. */
    #waiting = [];
    /** Whether a request of the queue is on its way: only one is, so that the order of what a person did is kept. */
    #sending = false;

    constructor(pocket, { container, onState, onClose, keyboardUp, target }) {
        this.#pocket = pocket;
        this.#container = container;
        this.#onState = onState;
        this.#onClose = onClose;
        this.#keyboardUp = keyboardUp ?? (() => false);
        // The machine that this page shows a terminal on, as the picker chose it; no choice is this machine.
        this.#target = target ?? (() => ({}));
        this.#font = Number(globalThis.localStorage?.getItem("x.rex.font")) || 13;

        this.#build();
    }

    get font() {
        return this.#font;
    }

    #publish(patch) {
        this.#state = { ...this.#state, ...patch };
        this.#onState?.(this.#state);
    }

    /** The screen, the cursor, and the textarea that keeps the keys, once, for the life of the page. */
    #build() {
        const screen = document.createElement("div");

        // No tabindex: the textarea keeps the focus, so the browser never takes it away from a keystroke.
        screen.className = "gt-screen";
        screen.setAttribute("role", "group");
        screen.setAttribute("aria-label", "Terminal");

        const grid = document.createElement("div");

        grid.className = "gt-grid";
        screen.append(grid);

        const cursor = document.createElement("div");

        cursor.className = "gt-cursor";
        cursor.setAttribute("aria-hidden", "true");
        grid.append(cursor);

        const input = document.createElement("textarea");

        input.className = "gt-input";
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("aria-label", "Terminal keys");
        input.value = KEEPER;
        screen.append(input);

        this.#container.append(screen);
        this.#screen = screen;
        this.#grid = grid;
        this.#cursorEl = cursor;
        this.#input = input;

        this.#listen();
        this.#applyFont();

        // A browser draws with a fallback font until it has the real one, so a cell measured at the first paint is the
        // fallback's cell: every run would then be a little too wide or too narrow for the font that arrives, and a line
        // would overlap itself. When the font comes, the grid is measured again.
        const remeasure = () => {
            this.#measure();
            this.#measureSoon();
        };

        document.fonts?.ready.then(remeasure).catch(() => {});
        document.fonts?.addEventListener?.("loadingdone", remeasure);
        this.#stops.push(() => document.fonts?.removeEventListener?.("loadingdone", remeasure));
    }

    /**
     * A key, from the input that holds the keys or from the window when the focus is elsewhere. `typed` says that the
     * character will also come as an input event, which is how a focused input gives its letters.
     */
    #keys(event, typed) {
        const modified = event.ctrlKey || event.altKey || event.metaKey;
        const armed = this.#armedNow();

        // Ctrl+V and ⌘V paste through the browser, which pastes into the field that has the focus. When that field is
        // this terminal's input, the browser's own paste comes next, and the terminal takes the text from there. When
        // the focus is elsewhere -- a selection took it -- there is no field for it to paste into, so the terminal reads
        // the clipboard itself, in the gesture that the key makes, and leaves the selection where it is.
        if (!armed && (event.ctrlKey || event.metaKey) && event.code === "KeyV") {
            if (!typed) {
                event.preventDefault();
                void this.#read();
            }

            return;
        }

        // Command is the app's, on a keyboard that has one: ⌘B folds the sidebar, ⌘K opens the launcher, and a browser
        // copies on ⌘C. The key goes on to the app, which takes the ones that it knows and lets the rest fall away.
        if (APPLE && event.metaKey) return;

        // A character that no input will take: the terminal takes it as the text that the person typed.
        if (!KEYS_SENT_AS_KEYS.has(event.code) && !modified && !armed) {
            if (!typed && event.key.length === 1) {
                event.preventDefault();
                this.#send({ text: event.key });
            }

            return;
        }

        event.preventDefault();

        // Control and the left bracket is Escape to every terminal that a person has used, and the encoder here has no
        // byte for it: on a device whose Escape key belongs to the system, that is the Escape that is left.
        if (event.code === "BracketLeft" && (event.ctrlKey || armed?.ctrl === true)) {
            this.#send({ keys: [{ key: "Escape" }] });
            this.#disarm();

            return;
        }

        const key = keyEventOf(event);

        if (key === null) return;

        // iPadOS takes Escape for itself: it puts a soft keyboard away, and the terminal may not have the key. The key's
        // work goes on, and the keyboard is asked back where the system allows it.
        if (event.code === "Escape" && this.#keyboardUp()) {
            setTimeout(() => {
                if (!this.#destroyed && !this.#focused()) this.#input.focus({ preventScroll: true });
            }, 60);
        }

        // A modifier that a key of the row armed is spent on this key, as a keyboard's own would be.
        if (armed) {
            this.#send({ keys: [{ ...key, mods: { ...key.mods, ...armed } }] });
            this.#disarm();
        } else {
            this.#send({ keys: [key] });
        }
    }

    #listen() {
        const screen = this.#screen;
        const input = this.#input;

        const focus = () => {
            this.#place();

            // A field that a browser emptied -- a selection, an autofill -- asks for the keeper back before it takes the
            // keys, so that the next delete is a backspace rather than nothing.
            if (input.value === "") {
                input.value = KEEPER;
                input.setSelectionRange(KEEPER.length, KEEPER.length);
            }

            input.focus({ preventScroll: true });
        };

        // A tap or a click gives the keys to the terminal, unless the person dragged to select text. Both a pointer's
        // end and a click ask for them: a phone answers one of them with a keyboard.
        // A finger that moved the view is not a finger that meant the keys, or the line under it.
        const panned = () => Date.now() - this.#pannedAt < 400;

        const tap = () => {
            if (panned() || globalThis.getSelection()?.toString()) return;

            focus();
        };

        screen.addEventListener("pointerup", tap);

        // A person who drags over a line means to have it. The selection goes to the clipboard as the drag ends -- the
        // gesture that a browser wants for the clipboard -- and nothing is said, since selecting is not a command.
        screen.addEventListener("pointerup", () => {
            const selection = globalThis.getSelection();

            // Only the screen's own text: a selection in the message box beside it belongs to the person's next command.
            if (panned() || selection === null || selection.rangeCount === 0 || !screen.contains(selection.anchorNode)) return;

            const text = selection.toString();

            if (text.trim() === "") return;

            void this.#write(text);
        });
        screen.addEventListener("click", tap);
        screen.addEventListener("wheel", (event) => {
            event.preventDefault();

            const pixels = this.#turnedBy(event);
            const now = performance.now();
            const notch = now - this.#turnAt > NOTCH_MS && Math.abs(pixels) >= this.#cell.height * 2;

            this.#turnAt = now;

            // A wheel's notch comes by itself, and is a jump of several lines: the view glides to it. A trackpad turns in
            // a stream of small ones, and a stream that waits its turn is a stream that trails the fingers.
            if (notch) this.#turn(pixels);
            else this.#pan(pixels);
        }, { passive: false });

        // A finger on the screen moves the view through the scrollback, as a wheel does: a phone has no wheel, and the
        // buffer is the only way back to what a program printed before. A finger that stays is a tap, and a tap gives
        // the keys, so only a finger that travels moves the view.
        let from = 0;
        let moving = false;

        screen.addEventListener("touchstart", (event) => {
            if (event.touches.length !== 1) return;

            // A finger that comes down takes the view from a throw of the one before it.
            this.#stopThrow();

            from = event.touches[0].clientY;
            moving = false;
            this.#finger = [{ at: performance.now(), y: from }];
        }, { passive: true });

        screen.addEventListener("touchmove", (event) => {
            if (event.touches.length !== 1) return;

            const to = event.touches[0].clientY;
            const now = performance.now();

            // The browser may not take this gesture for a scroll of the page, and it decides before the finger has
            // travelled the little that tells a tap from a swipe: a gesture that it takes is one that it cancels.
            event.preventDefault();

            if (!moving && Math.abs(to - from) < 8) return;

            moving = true;
            this.#pannedAt = Date.now();

            this.#finger.push({ at: now, y: to });

            if (this.#finger.length > 8) this.#finger.shift();

            this.#pan(from - to);
            from = to;
        }, { passive: false });

        // The fingers left the glass: the view goes on at the speed of the last of them, as a terminal that is flung
        // does, rather than stopping on the line where the finger happened to be.
        screen.addEventListener("touchend", () => {
            if (!moving) return;

            moving = false;
            this.#thrown();
        }, { passive: true });

        screen.addEventListener("touchcancel", () => {
            moving = false;
            this.#finger = [];
        }, { passive: true });

        input.addEventListener("keydown", (event) => this.#keys(event, true));

        // A person who selects a line on the screen goes on typing. A browser takes the focus off the input as a
        // selection starts, and giving it back clears the selection, so the keys come to the terminal without it. A
        // field of the app's own keeps its keys: the message box beside the panel is not the terminal.
        //
        // This listens where the app listens, and after it: a key that the app takes for itself -- ⌘B in the sidebar, a
        // key of a button that has the focus -- is the app's, and one that it leaves is the terminal's.
        const loose = (event) => {
            if (this.#destroyed || event.defaultPrevented || event.isComposing) return;
            if (document.activeElement === input) return;
            if (event.target instanceof Element && event.target.closest(EDITABLE) !== null) return;

            this.#keys(event, false);
        };

        window.addEventListener("keydown", loose);
        this.#stops.push(() => window.removeEventListener("keydown", loose));

        input.addEventListener("input", (event) => {
            const value = input.value;

            // The keeper goes back in after every event, at the end, where the next character goes. A value without it
            // is a delete that took it: that is a backspace, and holding the key takes it again and again.
            const kept = value.startsWith(KEEPER);
            const text = kept ? value.slice(KEEPER.length) : value;

            input.value = KEEPER;
            input.setSelectionRange(KEEPER.length, KEEPER.length);

            if (!kept && text === "" && event.isComposing !== true) {
                const armed = this.#armedNow();

                this.#send({ keys: [{ key: "Backspace", mods: armed ?? {} }] });

                if (armed !== null) this.#disarm();

                return;
            }

            if (text === "") return;

            // A soft keyboard gives a character as text, never as a key: Control and `c` is the interrupt that a phone has
            // no other way to send, and a modifier that the row armed would be lost if the text went as it is.
            const armed = this.#armedNow();
            const key = text.length === 1 ? keyOfText(text) : null;

            if (armed !== null && key !== null) {
                // A shifted letter is the capital that the modifier asks for; a phone's own keyboard has already done
                // that for what it sends, and this is the row's Shift beside it.
                const utf8 = armed.shift === true ? text.toUpperCase() : text;

                this.#send({ keys: [{ key, mods: armed, utf8 }] });
                this.#disarm();

                return;
            }

            this.#send({ text });
        });

        input.addEventListener("paste", (event) => {
            const text = event.clipboardData?.getData("text");

            event.preventDefault();

            if (text) this.#paste(text);
        });

        input.addEventListener("focus", () => {
            screen.classList.add("gt-typing");
            this.#focus();
        });
        input.addEventListener("blur", () => {
            screen.classList.remove("gt-typing");
            this.#focus();

            // A key of the row that a finger left the keys for: the keyboard is asked back before the tap ends, since a
            // system that took it away with the focus gives it back only to a page that asks inside a gesture.
            clearTimeout(this.#grabTimer);

            if (Date.now() < this.#keepUntil) {
                this.#grabTimer = setTimeout(() => {
                    if (!this.#destroyed && Date.now() < this.#keepUntil && !this.#focused()) {
                        this.#input.focus({ preventScroll: true });
                    }
                }, 0);
            }
            this.#disarm();
        });

        const observer = new ResizeObserver(() => this.#measureSoon());

        observer.observe(screen);
        this.#stops.push(() => observer.disconnect());
        this.#watchTab();
    }

    /**
     * A hidden tab hears no events, and a tab that falls far behind is cut off with nothing kept for it, so the screen
     * is read again when the tab shows, and again after a while without a frame.
     */
    #watchTab() {
        const onShow = () => this.#onShow();

        document.addEventListener("visibilitychange", onShow);
        this.#stops.push(() => document.removeEventListener("visibilitychange", onShow));

        const idle = setInterval(() => {
            if (document.visibilityState === "visible") void this.#refresh();
        }, 15_000);

        this.#stops.push(() => clearInterval(idle));
    }

    #onShow() {
        if (document.visibilityState === "visible") void this.#refresh();
    }

    #applyFont() {
        this.#screen.style.setProperty("--gt-font", `${this.#font}px`);
        this.#screen.style.setProperty("--gt-line", `${Math.round(this.#font * 1.32)}px`);

        this.#measure();
    }

    /** The width of one character and the height of one line, as the browser draws them in this font. */
    #measure() {
        const probe = document.createElement("span");

        probe.className = "gt-probe";
        // offsetWidth is in layout pixels, unlike getBoundingClientRect(), which includes ancestor transforms.
        // A long probe keeps the integer rounding of offsetWidth small relative to a single cell.
        probe.textContent = "0123456789".repeat(10);
        this.#screen.append(probe);

        const width = probe.offsetWidth / 100;

        probe.remove();

        const style = getComputedStyle(this.#screen);
        const height = parseFloat(style.lineHeight) || Math.round(this.#font * 1.32);

        this.#cell = { width: width > 0 ? width : this.#font * 0.6, height };
        this.#screen.style.setProperty("--gt-cell-w", `${this.#cell.width}px`);
        this.#screen.style.setProperty("--gt-cell-h", `${this.#cell.height}px`);
    }

    /** The columns and rows that fit the room that the page has now, less the margin inside its frame. */
    #fit() {
        const style = getComputedStyle(this.#screen);
        const width =
            this.#screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height =
            this.#screen.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const cols = Math.floor(width / this.#cell.width);
        const rows = Math.floor(height / this.#cell.height);

        return {
            cols: Math.max(20, Math.min(400, cols)),
            rows: Math.max(5, Math.min(200, rows)),
        };
    }

    #measureSoon() {
        if (this.#destroyed) return;

        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = setTimeout(() => {
            const fit = this.#fit();

            if (this.#id === null || (fit.cols === this.#cols && fit.rows === this.#rows)) return;

            this.#pocket.api(`terminals/${this.#id}/resize`, fit).catch(() => {});
        }, 150);
    }

    /**
     * A key from the row above the keyboard: an arrow, an escape, a tab, or a character that is buried in a keyboard's
     * second page. A modifier that the row armed goes with it, so `Ctrl` then `←` is a word back in a shell.
     */
    press(key, text) {
        const armed = this.#armedNow();

        if (armed === null && text !== undefined) {
            this.#send({ text });
        } else {
            const mods = armed ?? {};
            const chars = text !== undefined && !mods.ctrl && !mods.alt;

            this.#send({ keys: [{ key, mods, ...(chars ? { utf8: text } : {}) }] });
        }

        this.#disarm();
    }

    /** Arms a modifier for the next key, or takes it back when it is already armed. */
    arm(name) {
        this.#armed = { ctrl: false, shift: false, alt: false, [name]: !this.#armed[name] };
        this.#publish({ armed: this.#armed });
    }

    /** The modifiers that the row armed, or null when none is. */
    #armedNow() {
        const on = Object.entries(this.#armed).filter(([, value]) => value).map(([name]) => name);

        return on.length === 0 ? null : Object.fromEntries(on.map((name) => [name, true]));
    }

    #disarm() {
        if (this.#armedNow() === null) return;

        this.#armed = { ctrl: false, shift: false, alt: false };
        this.#publish({ armed: this.#armed });
    }

    #focused() {
        return document.activeElement === this.#input;
    }

    /** Puts the keyboard away: the row and the screen with it. */
    blur() {
        // The keys go because a person said so: nothing that was waiting to take them back may take them back.
        this.#keepUntil = 0;
        clearTimeout(this.#grabTimer);
        this.#input.blur();
    }

    /**
     * Says that a finger is on a key of the row, which is not a reason to lose the keyboard: a tap that the browser
     * turns into a focus change is a tap whose focus the terminal takes back.
     */
    keepKeys() {
        this.#keepUntil = Date.now() + 800;
    }

    /** A program rang the terminal's bell: a moment of light, as a terminal with a quiet bell does. */
    bell() {
        this.#screen.classList.remove("gt-bell");
        // A second bell in a row restarts the flash rather than sitting in it.
        void this.#screen.offsetWidth;
        this.#screen.classList.add("gt-bell");

        clearTimeout(this.#bellTimer);
        this.#bellTimer = setTimeout(() => this.#screen.classList.remove("gt-bell"), 140);
    }

    /** Puts the input that holds the keys where the cursor is, which is where a phone shows its keyboard. */
    #place() {
        const at = this.#at;

        if (at === null) return;

        this.#input.style.left = `${at.x * this.#cell.width}px`;
        this.#input.style.top = `${at.y * this.#cell.height}px`;
    }

    /** Takes the keys, as a terminal of its own does when a person comes back to it. */
    focus() {
        this.#place();
        this.#input.focus({ preventScroll: true });
    }

    /** Reads the clipboard, in the gesture that asked for it, and pastes what it holds. */
    async #read() {
        try {
            const text = await navigator.clipboard.readText();

            if (text !== "") this.#paste(text);
        } catch {
            this.#flash("Could not read the clipboard: the browser said no");
        }
    }

    /** Hands text to the browser's clipboard, as a program asked with OSC 52, and says that it did. */
    async #copy(text) {
        this.#flash((await this.#write(text)) ? `Copied ${text.length} characters` : "Could not copy: the browser said no");
    }

    /** Writes text to the clipboard, and answers whether the browser took it. */
    async #write(text) {
        // The copy may come from a program, not from the person's own gesture, and a browser may sit on the question of
        // the clipboard for a long time: a fallback that answers now is better than a copy that waits.
        const written = await Promise.race([
            navigator.clipboard.writeText(text).then(
                () => true,
                () => false,
            ),
            new Promise((resolve) => setTimeout(() => resolve(false), 1200)),
        ]);

        let copied = written;

        if (!copied) {
            // The fallback copies what a hidden field holds, which is a selection of the page's own: the person's
            // selection goes back where it was, since a copy must not take away what it copied.
            const selection = globalThis.getSelection();
            const kept = selection === null ? [] : [...Array(selection.rangeCount)].map((_, at) => selection.getRangeAt(at).cloneRange());
            const holder = document.createElement("textarea");

            holder.value = text;
            holder.setAttribute("readonly", "true");
            holder.className = "gt-input";
            this.#screen.append(holder);
            holder.select();
            copied = document.execCommand("copy");
            holder.remove();

            if (selection !== null && kept.length > 0) {
                selection.removeAllRanges();

                for (const range of kept) selection.addRange(range);
            }
        }

        return copied;
    }

    /** Reads the clipboard for a program that asked (OSC 52 with `?`), and answers with what it holds. */
    async #answer(selection) {
        let text = "";

        try {
            text = await navigator.clipboard.readText();
        } catch {
            this.#flash("Could not read the clipboard: the browser said no");
        }

        if (this.#id === null) return;

        await this.#pocket.api(`terminals/${this.#id}/clipboard`, { selection, text }).catch(() => {});
    }

    /** Says something in the bar for a moment: what the clipboard did, mostly. */
    #flash(message) {
        clearTimeout(this.#flashTimer);
        clearTimeout(this.#bellTimer);
        clearTimeout(this.#focusTimer);
        this.#publish({ flash: message });

        this.#flashTimer = setTimeout(() => {
            this.#flashTimer = null;
            this.#publish({ flash: null });
        }, 2500);
    }

    /** Text from a paste: the server wraps it when the program asked for a bracketed paste. */
    #paste(text) {
        this.#send({ paste: text });
    }

    /** Tells the program whether this terminal has the person's attention. */
    #focus() {
        if (this.#id === null || this.#destroyed) return;

        // A tap can take the focus away and give it back within a moment, and a program that watches for focus would
        // redraw a whole screen for a change that never happened. Only a focus that settles is reported.
        clearTimeout(this.#focusTimer);

        this.#focusTimer = setTimeout(() => {
            const inside = this.#focused();

            if (inside === this.#reported) return;

            this.#reported = inside;
            this.#pocket.api(`terminals/${this.#id}/focus`, { inside }).catch(() => {});
        }, 250);
    }

    /** Moves the view by a distance that a wheel or a finger made: whole lines of it, and the rest kept for the next. */
    #pan(pixels) {
        this.#scrollPixels += pixels;

        const lines = Math.trunc(this.#scrollPixels / this.#cell.height);

        if (lines === 0) return;

        this.#scrollPixels -= lines * this.#cell.height;
        this.#scroll(lines);
    }

    /**
     * Turns the view by the distance that a wheel made. A wheel's notch is six lines at once, and a view that took them
     * all in one frame jumped: the turn is taken a line at a time, on the frames that follow, while a trackpad's turns
     * make a line as often as they do and reach the view as they come.
     */
    #turn(pixels) {
        if (this.#id === null || this.#destroyed) return;

        if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
            this.#pan(pixels);

            return;
        }

        this.#turnPixels += pixels;
        this.#turnSoon();
    }

    /** Moves the view by one line of what the wheel has turned, on the next frame, and on the ones after while any is left. */
    #turnSoon() {
        if (this.#turnTimer !== null || this.#id === null || this.#destroyed) return;

        this.#turnTimer = requestAnimationFrame(() => {
            this.#turnTimer = null;

            const lines = Math.trunc(this.#turnPixels / this.#cell.height);

            if (lines === 0) return;

            const one = Math.sign(lines) * this.#cell.height;

            this.#turnPixels -= one;
            this.#pan(one);

            this.#turnSoon();
        });
    }

    /** Sets the view going at the speed that the finger left at, or stops it when the finger was still. */
    #thrown() {
        const samples = this.#finger;
        const last = samples.at(-1);

        this.#finger = [];

        if (last === undefined) return;

        const first = samples.find((each) => last.at - each.at <= THROW_WINDOW_MS) ?? last;

        if (first === last) return;

        // Down the screen is a view that goes back through the scrollback, which is what a pan of it is.
        const speed = (last.y - first.y) / (last.at - first.at);

        if (Math.abs(speed) < THROW_SLOWEST) return;

        this.#throwSpeed = -Math.max(-THROW_FASTEST, Math.min(THROW_FASTEST, speed));
        this.#throwAt = performance.now();
        this.#throwTimer = requestAnimationFrame((now) => this.#coast(now));
    }

    /** Moves the view by what a throw has left, frame by frame, until it is too slow to see. */
    #coast(now) {
        this.#throwTimer = null;

        if (this.#destroyed || this.#id === null) return;

        // A frame that took long is a frame that the view moves for, and no more: the throw must not jump.
        const took = Math.min(now - this.#throwAt, 32);

        this.#throwAt = now;
        this.#pannedAt = Date.now();

        this.#pan(this.#throwSpeed * took);
        this.#throwSpeed *= Math.exp(-took / THROW_MS);

        if (Math.abs(this.#throwSpeed) >= THROW_SLOWEST) this.#throwTimer = requestAnimationFrame((next) => this.#coast(next));
    }

    /** Stops a view that is going after a throw, as a finger that comes down does. */
    #stopThrow() {
        this.#throwSpeed = 0;

        if (this.#throwTimer !== null) {
            cancelAnimationFrame(this.#throwTimer);
            this.#throwTimer = null;
        }
    }

    /** The distance that a wheel event turns, in pixels: a wheel may count in lines or in pages, and not only in pixels. */
    #turnedBy(event) {
        if (event.deltaMode === 1) return event.deltaY * this.#cell.height;
        if (event.deltaMode === 2) return event.deltaY * this.#cell.height * this.#rows;

        return event.deltaY;
    }

    /**
     * Moves the view through the scrollback: asked for as soon as it is asked for, and one request on its way at a time,
     * so that a wheel's turn moves the view as it comes rather than in one piece after a wait.
     */
    #scroll(lines) {
        if (this.#id === null || this.#destroyed) return;

        this.#pendingScroll += lines;

        if (this.#scrolling) return;

        this.#scrolling = true;
        this.#scrollIdle = this.#flushScroll();
    }

    /** Sends the lines that the view has not moved by yet, until none is left. */
    async #flushScroll() {
        try {
            for (let lines = this.#pendingScroll; lines !== 0; lines = this.#pendingScroll) {
                this.#pendingScroll = 0;

                await this.#pocket.api(`terminals/${this.#id}/scroll`, { lines }).catch(() => {});
            }
        } finally {
            this.#scrolling = false;
        }
    }

    /**
     * Sends one thing to the terminal, after everything that came before it.
     *
     * A keystroke is a request of its own, and requests that are all on their way at once are answered in whatever order
     * the server reaches them: a line that was typed quickly arrived as `pritfn`, and characters of it were lost. So one
     * request is on its way at a time, and the characters that are typed while it is take one request between them.
     */
    #send(body) {
        if (this.#id === null || this.#destroyed) return;

        // A person who types is looking for the prompt, and the module puts the view at it before it types: this page
        // cannot know that the view is back, since another page or a reload may have scrolled it. A scroll that this
        // page asked for, and that has not gone yet, would arrive after the module's own and undo it.
        this.#pendingScroll = 0;
        this.#turnPixels = 0;
        this.#finger = [];
        this.#stopThrow();

        if (this.#turnTimer !== null) {
            cancelAnimationFrame(this.#turnTimer);
            this.#turnTimer = null;
        }

        const last = this.#waiting.at(-1);

        // Only what has not started: the text of a burst of typing joins the request that is waiting to go, which is
        // one keystroke's worth of a phone's keyboard and a whole paste of a terminal's own.
        if (body.text !== undefined && last?.text !== undefined) last.text += body.text;
        else this.#waiting.push({ ...body });

        void this.#flush();
    }

    /** Sends what waits, one request at a time, until nothing is left. */
    async #flush() {
        if (this.#sending) return;

        this.#sending = true;

        try {
            for (let body = this.#waiting.shift(); body !== undefined; body = this.#waiting.shift()) {
                // A scroll of the view that is on its way would land after what is typed, and move the view off the
                // prompt that the module has just put it on.
                await this.#scrollIdle;
                const path = body.paste === undefined ? "input" : "paste";
                const sent = body.paste === undefined ? body : { text: body.paste };

                await this.#pocket.api(`terminals/${this.#id}/${path}`, sent).catch(() => {});
            }
        } finally {
            this.#sending = false;
        }
    }

    /** Opens the shell: the one that the session keeps, or, asked, a new one. */
    async open(asNew = false) {
        if (this.#opening) return;

        this.#opening = true;
        this.#publish({ error: null });

        // Listen before the call: the first frames can come before the answer does.
        if (this.#eventStops.length === 0) this.#eventStops.push(
            this.#pocket.on("frame", ({ id, frame }) => {
                if (this.#id === null || id !== this.#id) {
                    this.#stashed.set(id, frame);
                    if (this.#stashed.size > 64) this.#stashed.delete(this.#stashed.keys().next().value);

                    return;
                }

                this.#apply(frame);
            }),
            this.#pocket.on("exit", ({ id, code, signal }) => {
                if (id !== this.#id) return;

                this.#publish({ alive: false, exitCode: code, signal });

                // A shell that ended the way a person ends one takes its panel with it, as a terminal's window does: a
                // `false` and then Ctrl-D is a status of 1, and a panel is not the place to read about it. A shell that
                // a signal stopped keeps the panel with what stopped it, and the panel decides by the same rule that
                // says whether there is anything to say.
                if (endedQuietly({ exitCode: code, signal })) setTimeout(() => this.#onClose?.(), 250);
            }),
            this.#pocket.on("notice", ({ id, kind, message }) => {
                if (id !== this.#id) return;

                // A bell is not a thing to read: a shell rings one on every completion that found nothing.
                if (kind === "bell") {
                    this.bell();

                    return;
                }

                this.#publish({ notice: message });
            }),
            // A program in the terminal copied something: OSC 52, as Neovim's own clipboard provider sends it.
            this.#pocket.on("clipboard", ({ id, text }) => {
                if (id !== this.#id) return;

                void this.#copy(text);
            }),
            this.#pocket.on("clipboard-read", ({ id, selection }) => {
                if (id !== this.#id) return;

                void this.#answer(selection);
            }),
        );

        try {
            const answer = await this.#pocket.api("terminals", {
                // The Rex session that the picker chose, and the Pi Pocket session that this page was opened from.
                ...this.#target(),
                conversation: this.#pocket.conversationId() ?? undefined,
                // A new shell is one of its own, even in the same folder.
                ...(asNew ? { new: true } : {}),
                ...this.#fit(),
            }, { method: "POST" });

            // The view went while its shell was starting: the shell is made, and has nowhere to be.
            if (this.#destroyed) {
                void this.#pocket.api(`terminals/${answer.terminal.id}`, undefined, { method: "DELETE" }).catch(() => {});

                return;
            }

            this.#id = answer.terminal.id;
            this.#apply(answer.frame);
            this.#publish({
                // Which Rex session this is: the page around the panel says which Pi Pocket session it is, and those
                // are not the same thing.
                host: answer.terminal.hostLabel ?? "",
                session: answer.terminal.windowLabel ?? "",
                cwd: answer.terminal.cwd,
                alive: answer.terminal.alive,
                exitCode: answer.terminal.exitCode,
                signal: answer.terminal.signal,
            });

            for (const [id, frame] of this.#stashed) {
                if (id === this.#id) this.#apply(frame);
            }

            this.#stashed.clear();
            this.#input.focus({ preventScroll: true });
        } catch (error) {
            if (!this.#destroyed) this.#publish({ error: error.message });
        } finally {
            this.#opening = false;
        }
    }

    /** Reads the whole screen again, after a time when this tab heard no frames. */
    async #refresh() {
        if (this.#id === null || this.#reading || this.#destroyed) return;

        this.#reading = true;

        try {
            const answer = await this.#pocket.api(`terminals/${this.#id}`);

            if (answer.terminal.alive !== this.#state.alive) {
                this.#publish({
                    alive: answer.terminal.alive,
                    exitCode: answer.terminal.exitCode,
                    signal: answer.terminal.signal,
                });
            }

            this.#apply(answer.frame);
        } catch {
            // The terminal went while the tab was away: the next open makes a new one.
        } finally {
            this.#reading = false;
        }
    }

    /** Ends the shell and opens a new one in the same folder. */
    async restart() {
        const id = this.#id;

        this.#id = null;

        if (id !== null) {
            try {
                await this.#pocket.api(`terminals/${id}`, undefined, { method: "DELETE" });
            } catch (failure) {
                this.#publish({ error: failure.message });
                return;
            }
        }

        this.#rowEls = [];
        this.#rowSpans = [];
        this.#grid.querySelectorAll(".gt-row").forEach((row) => row.remove());
        this.#publish({ alive: true, exitCode: null, notice: null, error: null });

        // A new shell is the shell that a person asked for: an archived session keeps none of its own.
        await this.open(true);
    }

    setFont(delta) {
        this.#font = Math.max(9, Math.min(22, this.#font + delta));
        globalThis.localStorage?.setItem("x.rex.font", String(this.#font));
        this.#applyFont();
        this.#resizeRows(this.#rows);
        this.#measureSoon();
    }

    /** Draws a frame: the rows that it names, then the cursor, the title, and the scroll position. */
    #apply(frame) {
        // A frame that is older than the one already drawn is the snapshot that a call took before that frame arrived:
        // the call and the frames travel apart, and the screen is the newer of the two.
        if (this.#seq !== null && frame.seq < this.#seq) return;

        // A frame number that skips one means that a frame never arrived, and its rows were never drawn. The events of a
        // tab can be cut off when it is far behind, and a frame that the tab missed does not come again.
        if (this.#seq !== null && frame.seq > this.#seq + 1) this.#refresh();

        this.#seq = frame.seq;

        if (frame.full || frame.rows !== this.#rows) this.#resizeRows(frame.rows);

        this.#cols = frame.cols;
        this.#rows = frame.rows;

        const grid = this.#grid;

        grid.style.setProperty("--gt-cols", String(frame.cols));
        grid.style.setProperty("--gt-rows", String(frame.rows));

        for (const line of frame.lines) {
            const row = this.#rowEls[line.y];

            if (row === undefined) continue;

            const spans = this.#rowSpans[line.y] ?? [];
            const runs = line.runs;

            for (let i = 0; i < runs.length; i += 1) {
                let span = spans[i];

                if (span === undefined) {
                    span = document.createElement("span");
                    spans[i] = span;
                    row.append(span);
                }

                paint(span, runs[i]);
            }

            for (let i = runs.length; i < spans.length; i += 1) spans[i].remove();

            spans.length = runs.length;
            this.#rowSpans[line.y] = spans;
        }

        const cursor = this.#cursorEl;
        const shape = frame.cursor.shape ?? "block";
        const look = `${shape}${frame.cursor.blink ? " blink" : ""}`;

        cursor.style.transform = `translate(${frame.cursor.x * this.#cell.width}px, ${frame.cursor.y * this.#cell.height}px)`;

        this.#at = frame.cursor;
        cursor.style.opacity = frame.cursor.visible ? "1" : "0";

        if (cursor.dataset.look !== look) {
            cursor.dataset.look = look;
            cursor.classList.toggle("gt-cursor--bar", shape === "bar");
            cursor.classList.toggle("gt-cursor--underline", shape === "underline");
            cursor.classList.toggle("gt-cursor--blink", frame.cursor.blink === true);
        }

        if (frame.title !== this.#state.title) this.#publish({ title: frame.title });
    }

    /** Makes the grid have this many rows, as a new frame's size says. */
    #resizeRows(rows) {
        const grid = this.#grid;

        for (let y = 0; y < rows; y += 1) {
            if (this.#rowEls[y] !== undefined) continue;

            const row = document.createElement("div");

            row.className = "gt-row";
            grid.insertBefore(row, this.#cursorEl);
            this.#rowEls[y] = row;
        }

        while (this.#rowEls.length > rows) {
            this.#rowEls.pop()?.remove();
            this.#rowSpans.pop();
        }

        this.#rows = rows;
    }

    destroy() {
        this.#destroyed = true;
        this.#waiting.length = 0;
        this.#pendingScroll = 0;
        this.#turnPixels = 0;

        if (this.#turnTimer !== null) {
            cancelAnimationFrame(this.#turnTimer);
            this.#turnTimer = null;
        }

        this.#finger = [];
        this.#stopThrow();

        clearTimeout(this.#resizeTimer);
        clearTimeout(this.#flashTimer);
        clearTimeout(this.#bellTimer);
        clearTimeout(this.#focusTimer);

        for (const stop of [...this.#stops, ...this.#eventStops]) stop();

        this.#stops = [];
        this.#eventStops = [];
    }
}
