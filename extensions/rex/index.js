// Rex's browser module: a panel beside the conversation or a page in its place that show a Rex session's terminal, and
// the picker that says which session. `rex.ts` opens the block's stream and sends frames; `terminal.js` draws them;
// `picker.js` is the tree of machines and sessions that Rex itself shows.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

import { TerminalView, keyboardShown, restingHeight, visibleHeight } from "./terminal.js";
import { NEW_SESSION_ICON, PickerPage, SESSION_ICON } from "./picker.js";

/** A prompt, as a 24×24 stroked path like the app's own icons. */
const PROMPT = "M5 7l4 4-4 4M12 16h7";

/** The way back to the keyboard, as a 24×24 stroked path. */
const KEYBOARD = "M3 14h18M3 10h18M6 18h12M6 6h12";

/**
 * A stack of sessions, as a 24×24 stroked path: the rail and the launcher take the app's icons, which are strokes on a
 * 24-unit box, and the sessions page draws the same stack as a 16-unit fill beside a session.
 */
const STACK = "M12 3.25 20.5 7.75 12 12.25 3.5 7.75Zm0 8.2 6.2 3.3M3.5 12l8.5 4.5 8.5-4.5M3.5 16.25l8.5 4.5 8.5-4.5";

/**
 * The row above a phone's keyboard, in the order that a shell and an editor reach for it: the keys that a soft keyboard
 * has not got, then the arrows, then the characters that are a second page away on it. `[label, key, character?]`.
 */
const KEYS = [
    ["Esc", "Escape"],
    ["Tab", "Tab"],
    ["⇧", "Shift"],
    ["⌥", "Alt"],
    ["←", "ArrowLeft"],
    ["↓", "ArrowDown"],
    ["↑", "ArrowUp"],
    ["→", "ArrowRight"],
    ["Home", "Home"],
    ["End", "End"],
    ["PgUp", "PageUp"],
    ["PgDn", "PageDown"],
    ["/", "Slash", "/"],
    ["|", "Backslash", "|"],
    ["~", "Backquote", "~"],
    ["-", "Minus", "-"],
    ["_", "Minus", "_"],
    ["*", "Digit8", "*"],
];

/**
 * A shell that a person left -- with `exit`, or with Ctrl-D at its prompt -- says nothing: its panel just goes. A shell
 * that a signal stopped, or a program that ended with a code, is the one worth a word.
 *
 * Rex reports how a terminal's program ended as an exit code, and a signal as the code that the system gives it, so a
 * shell that a person ended deliberately is the one whose code is 0.
 */
function endedQuietly(state) {
    if (typeof state.signal === "string" && state.signal !== "") return false;

    return state.exitCode === null || state.exitCode === undefined || state.exitCode === 0;
}

/** How a shell ended, as one value to compare: the code and the signal, whichever said so. */
function endedAs(state) {
    return `${state.exitCode ?? ""}:${state.signal ?? ""}`;
}

/** What to say about a shell that did not end quietly. */
function saidOf(state) {
    if (state.signal === "SIGINT") return "The shell was interrupted.";
    // The app's own end of a shell: it closes the pty, which hangs the shell up, or ends it outright.
    if (state.signal === "SIGHUP" || state.signal === "SIGTERM") return "The shell was stopped.";
    if (typeof state.signal === "string" && state.signal !== "") return `The shell was stopped (${state.signal}).`;

    // Rex says -1 when a program left no code of its own, which is how a signal ends one.
    if (state.exitCode === null || state.exitCode === undefined || state.exitCode < 0) return "The shell was stopped.";

    return `The shell ended (code ${state.exitCode}).`;
}

/**
 * Whether a soft keyboard has the window, and so whether the row of keys that it has not got belongs above it.
 *
 * A keyboard either takes a keyboard's worth of height -- the drop from the window at rest -- or covers the window
 * without changing it, which is what a phone does. The third way is for a page that opens while the keyboard is already
 * up, when there is no drop to see: a window on a touch screen that is much shorter than the screen.
 *
 * The page answers this: the row belongs above the keyboard whose keys the shell takes, and not above one that another
 * box of the app asked for.
 */
function useSoftKeyboard(pocket) {
    const { useEffect, useRef, useState } = pocket;
    const [up, setUp] = useState(false);
    const resting = useRef(0);
    const wasUp = useRef(false);

    useEffect(() => {
        if (navigator.maxTouchPoints === 0) return;

        const typing = () => document.activeElement?.classList.contains("gt-input") === true;

        const width = { current: window.innerWidth };

        const check = () => {
            const viewport = window.visualViewport;

            const up = keyboardShown({
                height: Math.min(window.innerHeight, viewport?.height ?? window.innerHeight),
                rest: resting.current,
                viewportHeight: viewport?.height,
                innerHeight: window.innerHeight,
                availHeight: globalThis.screen?.availHeight,
                coarse: globalThis.matchMedia("(pointer: coarse)").matches,
                typing: typing(),
                wasUp: wasUp.current,
            });

            wasUp.current = up;
            setUp(up);
        };

        const remember = () => {
            resting.current = restingHeight(resting.current, {
                height: window.innerHeight,
                width: window.innerWidth,
                lastWidth: width.current,
                typing: typing(),
            });
            width.current = window.innerWidth;
        };

        const onResize = () => {
            remember();
            check();
        };
        const onFocusOut = () => setTimeout(check, 0);

        resting.current = window.innerHeight;

        window.addEventListener("resize", onResize);
        window.visualViewport?.addEventListener("resize", check);
        document.addEventListener("focusin", check);
        document.addEventListener("focusout", onFocusOut);

        return () => {
            window.removeEventListener("resize", onResize);
            window.visualViewport?.removeEventListener("resize", check);
            document.removeEventListener("focusin", check);
            document.removeEventListener("focusout", onFocusOut);
        };
    }, []);

    /** Puts the row away because a person did, whatever the window is still measuring. */
    const away = () => {
        wasUp.current = false;
        setUp(false);
    };

    return [up, away];
}

/**
 * Makes the page as tall as the part of the window that a keyboard leaves.
 *
 * A phone's keyboard does not change the window: the page is still drawn as tall as it was, and the lines that the
 * keyboard covers are the lines that a person is typing on. The visual viewport is the part that is left, so while the
 * keyboard is up the page is that tall, and the screen's last line sits above the keyboard rather than behind it.
 *
 * The room is the box that the app gives the page, less its padding: a panel beside a conversation and a page in its
 * place are different sizes, and the keyboard covers the same height of each.
 */
function useKeyboardRoom(pocket, root, up) {
    const { useEffect } = pocket;

    useEffect(() => {
        const page = root.current;
        const area = page?.parentElement ?? null;
        const view = window.visualViewport;

        // A window with no visual viewport changes its own height for a keyboard, and the app's box already follows it.
        if (page === null || area === null || view === undefined || view === null) return;

        const fit = () => {
            if (!up) {
                page.style.height = "";

                return;
            }

            const style = getComputedStyle(area);
            const room = area.getBoundingClientRect();
            const top = room.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
            const bottom = top + area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            const height = visibleHeight({ top, bottom }, { top: view.offsetTop, height: view.height });

            page.style.height = height > 0 ? `${height}px` : "";
        };

        fit();
        window.addEventListener("resize", fit);
        view.addEventListener("resize", fit);
        view.addEventListener("scroll", fit);

        return () => {
            window.removeEventListener("resize", fit);
            view.removeEventListener("resize", fit);
            view.removeEventListener("scroll", fit);
            page.style.height = "";
        };
    }, [up]);
}

function TerminalPage({ pocket, close, setOpen, surface, onSwitch, target, onChoose }) {
    const { html, useEffect, useRef, useState } = pocket;

    const [state, setState] = useState({});
    const [dismissed, setDismissed] = useState(null);
    const [keyboard, putRowAway] = useSoftKeyboard(pocket);
    const root = useRef(null);
    const box = useRef(null);

    useKeyboardRoom(pocket, root, keyboard);

    const made = useRef(null);
    const keyboardRef = useRef(false);
    // The page's way out, through a ref: a shell that ends asks the page that a person has now to close, and not the one
    // that the first drawing of the page was made with.
    const closeNow = useRef(close);

    closeNow.current = close;

    const armed = state.armed ?? {};

    keyboardRef.current = keyboard;

    /** The view of this page's shell. */
    const view = () => made.current;

    // A panel shows only in a session, so a terminal with no session has one surface, and no button to leave it by. The
    // button's act is the module's: it moves the terminal to the other surface, which draws the same shell.
    const other = typeof pocket.panel === "function" && pocket.conversationId() !== null;
    const switchSurface = () => onSwitch(surface);

    const restart = () => void view()?.restart();
    const end = () => void view()?.kill();

    useEffect(() => {
        const view = new TerminalView(pocket, {
            container: box.current,
            onState: setState,
            onClose: () => closeNow.current(),
            keyboardUp: () => keyboardRef.current,
            target: () => target(),
        });

        made.current = view;
        view.open().catch(() => {});

        setOpen(surface);

        return () => {
            made.current = null;
            setOpen(null);

            // This page is the window of the shell: what a person comes back to keeps running, and the view of it goes.
            view.destroy();
        };
    }, []);

    /**
     * A key of the row, or a button of the bar, is pressed without taking the focus, so that the keyboard stays up
     * under it.
     *
     * A browser moves the focus to the button that is tapped, and a system that has the keyboard takes the keyboard
     * away with the focus. So the tap's own action is stopped, on the touch as well as on the press -- which also stops
     * the click that would have come after it -- and the keys are asked back inside the tap, the one moment when a page
     * may ask for them.
     *
     * The stopping is why the action runs on whichever of the press and the click comes first, once: a tap sends both,
     * and a key of a keyboard that a person pressed sends only the click.
     */
    const keep = (event) => {
        if (event.cancelable) event.preventDefault();
    };

    // When the last press happened, for the whole page: a click that follows a press belongs to that press, and the page
    // may well have drawn itself again between the two, which is a new handler with a new memory of its own.
    const pressedAt = useRef(0);

    const once = (run) => (event) => {
        keep(event);

        const now = Date.now();

        if (event.type === "click" && now - pressedAt.current < 700) return;
        if (event.type === "pointerdown") pressedAt.current = now;

        view()?.keepKeys();
        run();
        view()?.focus();
        setTimeout(() => view()?.focus(), 0);
    };

    /** The bar's own buttons act on the terminal too: a tap on one of them holds the keys rather than leaving them. */
    /** An octicon: a 16 by 16 drawing, in one shape or a few, that takes the button's color and the size of its letters. */
    const icon = (...shapes) =>
        html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            ${shapes.map((shape) => html`<path d=${shape} />`)}
        </svg>`;

    // The frame of a box: a square outline whose corners are rounded a little, filled the width of a line of the drawing.
    const FRAME =
        "M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm10.5 1.5H2.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z";

    const PLUS = "M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4Z";
    // A glass with a minus in it, and one with a plus: the letters' size, smaller or larger.
    const MINUS =
        "M4.5 6.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1 0-1.5Z";
    const GLASS_UNDER =
        "M0 7.5a7.5 7.5 0 1 1 13.307 4.747l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 0 1 0 7.5Zm7.5-6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z";
    const OVER_PLUS =
        "M3.75 7.5a.75.75 0 0 1 .75-.75h2.25V4.5a.75.75 0 0 1 1.5 0v2.25h2.25a.75.75 0 0 1 0 1.5H8.25v2.25a.75.75 0 0 1-1.5 0V8.25H4.5a.75.75 0 0 1-.75-.75Z";
    const GLASS_OVER =
        "M7.5 0a7.5 7.5 0 0 1 5.807 12.247l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 1 1 7.5 0Zm-6 7.5a6 6 0 1 0 12 0 6 6 0 0 0-12 0Z";

    // One frame of a box, with what the surface holds: a bar down one side for the panel, a line across the top for the
    // page. The button shows the surface that a tap gives, and says it in its title.
    const PANEL = "M10.25 2.25h1.5v11.5h-1.5z";
    const PAGE = "M2.25 4.75h11.5v1.5H2.25z";
    const END =
        "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z";

    const button = (label, title, run, extra = "") => {
        // One press, one action: the press and the click that may follow it share the one guard.
        const go = once(run);

        return html`<button
            class="button gt-small ${extra}"
            title=${title}
            aria-label=${title === "" ? undefined : title}
            onPointerDown=${go}
            onClick=${go}
        >
            ${label}
        </button>`;
    };

    const press = (key, text) =>
        once(() => {
            view()?.press(key, text);
        });

    const arm = (name) =>
        once(() => {
            view()?.arm(name);
        });

    // The round Control of the row, and the round key that puts the keyboard away, which asks for nothing back.
    const ctrl = arm("ctrl");

    const away = (event) => {
        keep(event);
        view()?.blur();
        putRowAway();
    };

    return html`<div class="gt-page" ref=${root}>
        <div class="gt-bar">
            ${state.flash ? html`<span class="gt-flash small muted">${state.flash}</span>` : null}
            <div class="gt-actions">
                ${button(icon(NEW_SESSION_ICON), "New shell", restart, "gt-restart")}
                ${button(icon(SESSION_ICON), "Another session", onChoose, "gt-sessions")}
            </div>
            ${state.session
                ? html`<span class="gt-where muted small" title=${[state.host, state.session].filter(Boolean).join(" · ")}>
                      ${state.host ? html`<span class="gt-where-host">${state.host}</span>` : null}${state.host &&
                      state.session
                          ? " · "
                          : ""}${state.session}
                  </span>`
                : null}
            <div class="gt-actions">
                ${other
                    ? button(
                          icon(FRAME, surface === "panel" ? PAGE : PANEL),
                          surface === "panel" ? "As a page" : "As a panel",
                          switchSurface,
                          "gt-surface",
                      )
                    : null}
                ${button(icon(MINUS, GLASS_UNDER), "Smaller text", () => view()?.setFont(-1), "gt-font")}
                ${button(icon(OVER_PLUS, GLASS_OVER), "Larger text", () => view()?.setFont(1), "gt-font")}
                <span class="gt-space"></span>
                ${button(icon(END), "End", end, "gt-end")}
            </div>
        </div>
        <div class="gt-panes">
            <div class="gt-view" ref=${box}></div>
            ${state.error
                ? html`<div class="gt-note">
                      <span class="error-box">${state.error}</span>
                      <button class="button gt-small" onClick=${() => void view()?.open()}>Try again</button>
                  </div>`
                : null}
            ${state.alive === false && !endedQuietly(state) && dismissed !== endedAs(state)
                ? html`<div class="gt-note">
                      <span class="gt-note-said">${saidOf(state)}</span>
                      <button class="button gt-small" onClick=${restart}>New shell</button>
                      <button
                          class="button gt-small gt-note-x"
                          title="Put this away"
                          aria-label="Put this away"
                          onClick=${() => setDismissed(endedAs(state))}
                      >
                          ×
                      </button>
                  </div>`
                : null}
            ${state.notice ? html`<div class="gt-note muted small">${state.notice}</div>` : null}
        </div>
        ${keyboard
            ? html`<div class="gt-keys">
                  <button
                      class="gt-key gt-round ${armed.ctrl ? "gt-key-on" : ""}"
                      aria-pressed=${armed.ctrl ? "true" : "false"}
                      title="Control, for the next key"
                      onPointerDown=${ctrl}
                      onClick=${ctrl}
                  >
                      ⌃
                  </button>
                  <div class="gt-keyrow">
                      ${KEYS.map(([label, key, text]) => {
                          const run = key === "Shift" || key === "Alt" ? arm(key.toLowerCase()) : press(key, text);

                          return html`<button
                                  class="gt-key ${armed[key.toLowerCase()] && (key === "Shift" || key === "Alt") ? "gt-key-on" : ""}"
                                  title=${label}
                                  onPointerDown=${run}
                                  onClick=${run}
                              >
                                  ${label}
                              </button>`;
                      })}
                  </div>
                  <button
                      class="gt-key gt-round"
                      title="Put the keyboard away"
                      onPointerDown=${away}
                      onClick=${away}
                  >
                      <${pocket.Icon} path=${KEYBOARD} size=${18} />
                  </button>
              </div>`
            : null}
    </div>`;
}

export default function setup(pocket) {
    const { html } = pocket;

    // Which surface shows the terminal, or `null` when it is away: the one key that opens it is the one that puts it
    // away, wherever it is.
    let openOn = null;
    const setOpen = (where) => {
        openOn = where;
    };

    // A terminal belongs to the session that it works in, so it docks beside that session's conversation where the
    // Browser and Files panels dock, and takes a tile in the places. It opens as a page of its own too, where it is the
    // whole of the place of the conversation, and a button of its bar moves it from one to the other. A panel came in
    // 0.19.0: an older app gets the page and a button on the rail, with nothing to switch to.
    const canPanel = typeof pocket.panel === "function";
    // When the terminal last moved between its surfaces, so that one tap moves it one time.
    let switchedAt = 0;

    /** Moves the terminal to its other surface, unless it moved a moment ago. */
    const switchSurface = (surface) => {
        const now = Date.now();

        if (now - switchedAt < 400) return;

        switchedAt = now;

        if (surface === "panel") {
            // The panel goes first: a page shows with the panel still set behind it, and the panel comes back when the
            // page closes.
            pocket.closePanel();
            pocket.openPage("terminal");
        } else {
            // A panel closes the page itself, on its way in.
            pocket.openPanel("terminal");
        }
    };

    /**
     * The Rex session that the terminal shows, kept where a reload finds it: the picker chooses it, and the terminal page
     * opens on the terminal of the session that was chosen last.
     */
    const CHOSEN = "x.rex.target";

    const chosen = () => {
        try {
            return JSON.parse(globalThis.localStorage?.getItem(CHOSEN) ?? "null");
        } catch {
            return null;
        }
    };

    /** What the terminal page adds to its call: the machine and the session, and nothing when none was chosen. */
    const targetOf = () => {
        const found = chosen();

        return found === null ? {} : { host: found.host, session: found.session };
    };

    /** A session from the picker: it becomes the one that the terminal shows, and the terminal opens on it. */
    const open = (host, session) => {
        globalThis.localStorage?.setItem(CHOSEN, JSON.stringify({ host: host.key, session: session.id, label: session.label }));

        if (canPanel && pocket.conversationId() !== null) pocket.openPanel("terminal");
        else pocket.openPage("terminal");
    };

    /** Back to the terminal that belongs to this conversation, after a session of someone else's was chosen. */
    const openOwn = () => {
        globalThis.localStorage?.removeItem(CHOSEN);

        if (canPanel && pocket.conversationId() !== null) pocket.openPanel("terminal");
        else pocket.openPage("terminal");
    };

    /** The picker, from the terminal's own bar: choosing another session should not mean leaving the terminal first. */
    const chooseSession = () => pocket.openPage("sessions");

    /** The terminal, on the surface that it is given: `pocket.page` and `pocket.panel` both take the fields that it has. */
    const Terminal = ({ close, surface }) =>
        html`<${TerminalPage}
            pocket=${pocket}
            close=${close}
            setOpen=${setOpen}
            surface=${surface}
            onSwitch=${switchSurface}
            target=${targetOf}
            onChoose=${chooseSession}
        />`;
    const AsPanel = ({ close }) => html`<${Terminal} close=${close} surface="panel" />`;
    const AsPage = ({ close }) => html`<${Terminal} close=${close} surface="page" />`;

    pocket.style("terminal.css");

    if (canPanel) {
        pocket.panel({ id: "terminal", title: "Terminal", component: AsPanel, iconPath: PROMPT, wide: true });
    }

    // Esc belongs to the terminal: it leaves an editor's insert mode, and it is half of what a shell reads.
    pocket.page({ id: "terminal", title: "Terminal", component: AsPage, escape: false, swipe: false });

    if (canPanel) {
        pocket.launcher({
            id: "terminal",
            label: "Terminal",
            detail: "a shell in this session's folder",
            iconPath: PROMPT,
            panel: "terminal",
        });
    } else {
        pocket.rail({ id: "terminal", title: "Terminal", iconPath: PROMPT, page: "terminal" });
        pocket.launcher({
            id: "terminal",
            label: "Terminal",
            detail: "a shell in this session's folder",
            iconPath: PROMPT,
            page: "terminal",
        });
    }

    // Every machine that Rex can reach, with the sessions under each: the same form as Rex's own picker, so that a
    // person finds their work on their phone the way that they find it on their laptop. A session opens its terminal.
    function Sessions() {
        return html`<${PickerPage} pocket=${pocket} onOpen=${open} onOpenOwn=${openOwn} />`;
    }

    pocket.page({ id: "sessions", title: "Rex sessions", component: Sessions });
    pocket.rail({ id: "sessions", title: "Rex sessions", iconPath: STACK, page: "sessions" });
    pocket.launcher({
        id: "sessions",
        label: "Rex sessions",
        detail: "every machine that Rex can reach, and the sessions under each",
        iconPath: STACK,
        page: "sessions",
    });

    // A terminal that opens and closes on one key is a terminal that is beside the work rather than in the way.
    const onKey = (event) => {
        const mod = event.ctrlKey || event.metaKey;

        if (!mod || event.shiftKey || event.altKey || event.code !== "Backquote") return;

        event.preventDefault();
        event.stopPropagation();

        if (openOn === null) {
            // Where it opens: beside the conversation, or as a page when there is no session to be beside.
            if (canPanel && pocket.conversationId() !== null) pocket.openPanel("terminal");
            else pocket.openPage("terminal");
        } else {
            // Whichever surface it is on: a page that the panel did not open is closed by its own call.
            pocket.closePanel();
            pocket.closePage();
        }
    };

    document.addEventListener("keydown", onKey, true);
    pocket.onDispose(() => document.removeEventListener("keydown", onKey, true));
}
