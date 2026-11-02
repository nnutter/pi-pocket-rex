// The terminals page: every shell that the module keeps, whichever session started it, and the way to end one.
//
// A shell that a tab left -- a closed tab, a second tab that took the panel -- keeps its pty and one of the eight
// places, and no page shows it. This is the page that shows them again, so that a person can end the ones that nobody
// is looking at instead of waiting for the server to restart.

/** A shell's own name: the title that it set with OSC 2, or the program that it runs. */
export function nameOf(terminal) {
    if (typeof terminal.title === "string" && terminal.title !== "") return terminal.title;

    const program = terminal.argv?.[0] ?? "shell";

    return program.slice(program.lastIndexOf("/") + 1);
}

/**
 * The order of the rows: the shells that are running first, and the oldest first within each, because a shell that
 * started long ago and is still here is the likeliest one that nobody is looking at.
 */
export function orderOf(terminals) {
    return [...terminals].sort((left, right) => {
        if (left.alive !== right.alive) return left.alive ? -1 : 1;

        return left.createdAt - right.createdAt;
    });
}

/** How long ago a shell started, in the fewest words that say it. */
export function since(when, now) {
    const seconds = Math.max(0, Math.round((now - when) / 1000));

    if (seconds < 60) return "just now";

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.round(minutes / 60);

    if (hours < 24) return `${hours} h ago`;

    const days = Math.round(hours / 24);

    return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** What a row says about a shell's size, and about how it went when it is not running. */
function stateOf(terminal) {
    if (terminal.alive) return `${terminal.cols}×${terminal.rows}`;

    if (typeof terminal.signal === "string" && terminal.signal !== "") return `stopped (${terminal.signal})`;

    return `ended (${terminal.exitCode ?? "no code"})`;
}

/** The session that a shell works in, in the words that a person knows it by. */
function sessionOf(terminal) {
    if (terminal.conversation === 0) return "No session";
    if (typeof terminal.session === "string" && terminal.session !== "") return terminal.session;

    return `Session ${terminal.conversation}`;
}

/** One shell: what it is, where it works, and what can be done about it. */
function Row({ pocket, terminal, mine, confirming, busy, ask, cancel, end }) {
    const { html } = pocket;
    const label = terminal.alive ? "End" : "Forget";

    return html`<li class="gt-terminal-row ${terminal.alive ? "" : "is-ended"}">
        <div class="gt-terminal-head">
            <span class="gt-terminal-name mono" title=${terminal.cwd}>${nameOf(terminal)}</span>
            ${mine ? html`<span class="gt-terminal-tag">this session</span>` : null}
            ${terminal.alive ? null : html`<span class="gt-terminal-tag">ended</span>`}
        </div>
        <div class="gt-terminal-meta muted small">
            <span class="gt-meta-item">${sessionOf(terminal)}</span>
            <span class="gt-meta-item">${terminal.cwd}</span>
            <span class="gt-meta-item">${stateOf(terminal)}</span>
            <span class="gt-meta-item">started ${since(terminal.createdAt, Date.now())}</span>
        </div>
        <div class="gt-terminal-actions">
            ${confirming
                ? html`<button class="button small muted gt-terminal-keep" disabled=${busy} onClick=${cancel}>Keep it</button>`
                : null}
            <button class="button small gt-terminal-end" disabled=${busy} onClick=${confirming ? end : ask}>
                ${busy ? "Ending…" : confirming ? "End it" : label}
            </button>
        </div>
    </li>`;
}

/**
 * The page: the shells that the module keeps now, read again as the page stays open, because a shell ends by itself as
 * readily as a person ends one.
 */
export function TerminalsPage({ pocket }) {
    const { html, useEffect, useRef, useState } = pocket;
    const [listing, setListing] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);
    const [confirming, setConfirming] = useState(null);
    // The page draws itself again after each reading, and a reading that lands after the page went must not do that.
    const showing = useRef(true);

    const read = async () => {
        try {
            const answer = await pocket.api("terminals");

            if (!showing.current) return;

            setListing(answer);
            setError(null);
        } catch (failure) {
            if (showing.current) setError(failure.message);
        }
    };

    useEffect(() => {
        showing.current = true;
        void read();

        // A shell that ends by itself leaves this list by the reading after it: no event says that a page went away.
        const timer = setInterval(() => void read(), 4000);

        return () => {
            showing.current = false;
            clearInterval(timer);
        };
    }, []);

    const end = async (terminal) => {
        setBusy(terminal.id);

        try {
            await pocket.api(`terminals/${terminal.id}`, undefined, { method: "DELETE" });
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(null);
            setConfirming(null);
            void read();
        }
    };

    const terminals = orderOf(listing?.terminals ?? []);
    const running = terminals.filter((each) => each.alive).length;
    const most = listing?.max ?? 8;
    const mine = pocket.conversationId?.() ?? null;
    const full = running >= most;

    return html`<div class="gt-list">
        <div class="gt-list-head">
            <span class="small ${full ? "gt-warn" : "muted"}">
                ${running} of ${most} shells running${full ? ": end one to start another" : ""}
            </span>
            <button class="button small" onClick=${() => void read()}>Refresh</button>
        </div>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        ${listing === null && error === null ? html`<${pocket.Loader} />` : null}
        ${listing !== null && terminals.length === 0
            ? html`<p class="muted small">No shell is running. Open the terminal to start one.</p>`
            : null}
        <ul class="gt-list-rows">
            ${terminals.map(
                (terminal) => html`<${Row}
                    key=${terminal.id}
                    pocket=${pocket}
                    terminal=${terminal}
                    mine=${terminal.conversation === mine}
                    confirming=${confirming === terminal.id}
                    busy=${busy === terminal.id}
                    ask=${() => setConfirming(terminal.id)}
                    cancel=${() => setConfirming(null)}
                    end=${() => void end(terminal)}
                />`,
            )}
        </ul>
    </div>`;
}
