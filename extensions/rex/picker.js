// The sessions page: the machines that a person can reach, and the sessions under each, in the form that Rex's own
// picker uses. A machine is a heading with its own icon; a session is the row under it. The filter keeps the rows that
// match, and a machine that will not answer says so where its sessions would be.

/** The icons that Rex names for a host, drawn as 16 by 16 paths. Anything else gets the monitor. */
const ICONS = {
    desktopcomputer:
        "M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 13H9v1.5h2.25a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5H7V13H1.75A1.75 1.75 0 0 1 0 11.25v-7.5C0 2.784.784 2 1.75 2Zm0 1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z",
    macbook:
        "M2 3.75C2 2.784 2.784 2 3.75 2h8.5c.966 0 1.75.784 1.75 1.75v6.5h.75a.75.75 0 0 1 0 1.5H1.25a.75.75 0 0 1 0-1.5H2Zm1.5 0v6.5h9V3.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z",
    macstudio:
        "M1.75 4h12.5c.966 0 1.75.784 1.75 1.75v4.5A1.75 1.75 0 0 1 14.25 12H1.75A1.75 1.75 0 0 1 0 10.25v-4.5C0 4.784.784 4 1.75 4Zm0 1.5a.25.25 0 0 0-.25.25v4.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-4.5a.25.25 0 0 0-.25-.25ZM4 9.25a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 4 9.25Z",
    "server.rack":
        "M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 14.25 7H1.75A1.75 1.75 0 0 1 0 5.25v-2.5C0 1.784.784 1 1.75 1Zm0 1.5a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25ZM1.75 9h12.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25v-2.5C0 9.784.784 9 1.75 9Zm0 1.5a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25ZM3 12.25a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Z",
    globe: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm5.9 5h-2.2a12 12 0 0 0-.9-3.4A6.5 6.5 0 0 1 13.9 5ZM8 1.6c.7.9 1.4 2.4 1.8 3.4H6.2c.4-1 1.1-2.5 1.8-3.4ZM2.1 5h3.1c.2-1.2.5-2.4.9-3.4A6.5 6.5 0 0 0 2.1 5Zm0 1.5a6.5 6.5 0 0 0 3.4 4.9c-.4-1-.7-2.2-.9-3.4H2.1Zm5.9 6.9c-.7-.9-1.4-2.4-1.8-3.4h3.6c-.4 1-1.1 2.5-1.8 3.4Zm2.8-4.9c-.2 1.2-.5 2.4-.9 3.4a6.5 6.5 0 0 0 3.4-4.9h-2.5Z",
};

/** The path for a host's icon: Rex's own name for it, or the monitor when this page does not know the name. */
export function iconPathOf(name) {
    return ICONS[name] ?? ICONS.desktopcomputer;
}

/**
 * The hosts and sessions that match a filter, as Rex filters them: a session shows when its name or its machine's name
 * holds the text, and a machine shows when it or any session under it does.
 */
export function filtered(hosts, query) {
    const wanted = query.trim().toLowerCase();

    if (wanted === "") return hosts;

    return hosts
        .map((host) => {
            const machine = host.label.toLowerCase().includes(wanted);

            return {
                ...host,
                sessions: machine ? host.sessions : host.sessions.filter((session) => session.label.toLowerCase().includes(wanted)),
                kept: machine || host.sessions.some((session) => session.label.toLowerCase().includes(wanted)),
            };
        })
        .filter((host) => host.kept);
}

/** What a machine's heading says about it under its name. */
function stateOf(host) {
    if (!host.online) return host.error ?? "Not answering";

    const count = host.sessions.length;

    return count === 1 ? "1 session" : `${count} sessions`;
}

const Machine = ({ pocket, host }) => {
    const { html } = pocket;

    return html`<li class="gt-machine">
        <div class="gt-machine-head">
            <span class="gt-machine-icon">
                <${pocket.Icon} path=${iconPathOf(host.icon)} size=${16} />
            </span>
            <span class="gt-machine-name">${host.label}</span>
            ${host.local ? html`<span class="gt-machine-tag">this machine</span>` : null}
            <span class="gt-machine-state small ${host.online ? "muted" : "gt-warn"}" title=${host.endpoint}>
                ${stateOf(host)}
            </span>
        </div>
        ${host.sessions.length === 0
            ? host.online
                ? html`<div class="gt-session-line muted small">No session on this machine.</div>`
                : null
            : html`<ul class="gt-sessions">
                  ${host.sessions.map(
                      (session) => html`<li class="gt-session" key=${session.id}>
                          <span class="gt-session-name">${session.label}</span>
                      </li>`,
                  )}
              </ul>`}
    </li>`;
};

/**
 * The page: every machine that the module can reach, and the sessions under each. It reads again every few seconds,
 * because a session that a person opens on their laptop should show on their phone without a reload.
 */
export function PickerPage({ pocket }) {
    const { html, useEffect, useRef, useState } = pocket;

    const [listing, setListing] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState("");
    // The page draws itself again after each reading, and a reading that lands after the page went must not do that.
    const showing = useRef(true);

    const read = async () => {
        try {
            const answer = await pocket.api("hosts");

            if (!showing.current) return;

            setListing(answer.hosts ?? []);
            setError(null);
        } catch (failure) {
            if (showing.current) setError(failure.message);
        }
    };

    useEffect(() => {
        showing.current = true;
        void read();

        const timer = setInterval(() => void read(), 5000);

        return () => {
            showing.current = false;
            clearInterval(timer);
        };
    }, []);

    const hosted = filtered(listing ?? [], query);
    const machines = hosted.length;
    const sessions = hosted.reduce((total, host) => total + host.sessions.length, 0);

    return html`<div class="gt-list">
        <div class="gt-filter">
            <${pocket.Icon}
                path="M0 7.5a7.5 7.5 0 1 1 13.307 4.747l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 0 1 0 7.5Zm7.5-6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"
                size=${16}
            />
            <input
                class="gt-filter-box"
                type="search"
                placeholder="Filter…"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </div>
        <div class="gt-list-head">
            <span class="small muted">
                ${machines === 0 ? "No machine" : machines === 1 ? "1 machine" : `${machines} machines`}, ${sessions === 1
                    ? "1 session"
                    : `${sessions} sessions`}
            </span>
            <button class="button small" onClick=${() => void read()}>Refresh</button>
        </div>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        ${listing === null && error === null ? html`<${pocket.Loader} />` : null}
        ${listing !== null && listing.length === 0
            ? html`<p class="muted small">
                  No Rex server answered. Install Rex on this machine, or name a machine in Menu → Extensions → Rex.
              </p>`
            : null}
        ${listing !== null && listing.length > 0 && hosted.length === 0
            ? html`<p class="muted small">No machine or session has that name.</p>`
            : null}
        <ul class="gt-list-rows">
            ${hosted.map((host) => html`<${Machine} key=${host.key} pocket=${pocket} host=${host} />`)}
        </ul>
    </div>`;
}
