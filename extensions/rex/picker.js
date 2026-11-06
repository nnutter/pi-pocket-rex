// The sessions page: the machines that a person can reach, and the sessions under each, in the form that Rex's own
// picker uses. A machine is a heading with its own icon; a session is the row under it. The filter keeps the rows that
// match, and a machine that will not answer says so where its sessions would be.

/** A session, as a stack of layers; and a new one, as the same stack with a plus. */
export const SESSION_ICON =
    "M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z";

export const NEW_SESSION_ICON =
    "M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.25 1.25 0 0 1 0-2.162ZM8.125 1.69a.25.25 0 0 0-.25 0L3.244 4.375 7.875 7.06a.25.25 0 0 0 .25 0l4.63-2.685ZM1.602 7.789a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296L1.874 8.813a.75.75 0 0 1-.272-1.024m0 3.5a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296l-5.248-3.044a.75.75 0 0 1-.272-1.024M11.75 15.25v-2h-2a.75.75 0 0 1 0-1.5h2v-2a.75.75 0 0 1 1.5 0v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0";

/** Where the terminal keeps the session that it shows, which is what a tick in this list marks. */
const CHOSEN = "x.rex.target";

function chosen() {
    try {
        return JSON.parse(globalThis.localStorage?.getItem(CHOSEN) ?? "null");
    } catch {
        return null;
    }
}

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
    globe: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 8.75a9.64 9.64 0 0 0 1.363 4.177c.255.426.542.832.857 1.215.245-.296.551-.705.857-1.215A9.64 9.64 0 0 0 10.22 8.75Zm4.44-1.5a9.64 9.64 0 0 0-1.363-4.177c-.307-.51-.612-.919-.857-1.215a9.927 9.927 0 0 0-.857 1.215A9.64 9.64 0 0 0 5.78 7.25Zm-5.944 1.5H1.543a6.507 6.507 0 0 0 4.666 5.5c-.123-.181-.24-.365-.352-.552-.715-1.192-1.437-2.874-1.581-4.948Zm-2.733-1.5h2.733c.144-2.074.866-3.756 1.58-4.948.12-.197.237-.381.353-.552a6.507 6.507 0 0 0-4.666 5.5Zm10.181 1.5c-.144 2.074-.866 3.756-1.58 4.948-.12.197-.237.381-.353.552a6.507 6.507 0 0 0 4.666-5.5Zm2.733-1.5a6.507 6.507 0 0 0-4.666-5.5c.123.181.24.365.353.552.714 1.192 1.436 2.874 1.58 4.948Z",
};

/**
 * One of this page's own icons, drawn here rather than by the app's `Icon`.
 *
 * `Icon` is a 24 by 24 stroke, and every path on this page is a 16 by 16 fill: the app's would draw one at two thirds of
 * its size, off its own corner, and as an outline.
 */
export function Mark({ pocket, path, size = 16 }) {
    return pocket.html`<svg
        class="gt-mark"
        width=${size}
        height=${size}
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
    >
        <path d=${path} />
    </svg>`;
}

/** The tick of the session that the terminal shows, as a 16 by 16 path. */
const TICK = "M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0L3.22 8.78a.75.75 0 1 1 1.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 0 1 1.06 0Z";

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

const Machine = ({ pocket, host, onOpen, here }) => {
    const { html } = pocket;

    return html`<li class="gt-machine">
        <div class="gt-machine-head">
            <span class="gt-machine-icon">
                <${Mark} pocket=${pocket} path=${iconPathOf(host.icon)} />
            </span>
            <span class="gt-session-tick" aria-hidden="true">
                ${here ? html`<${Mark} pocket=${pocket} path=${TICK} size=${14} />` : null}
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
                      (session) => html`<li key=${session.id}>
                          <button class="gt-session" onClick=${() => onOpen(host)}>
                              <span class="gt-session-tick" aria-hidden="true"></span>
                              <span class="gt-session-name">${session.label}</span>
                          </button>
                      </li>`,
                  )}
              </ul>`}
    </li>`;
};

/**
 * The page: every machine that the module can reach, and the sessions under each. It reads again every few seconds,
 * because a session that a person opens on their laptop should show on their phone without a reload.
 *
 * A row under a machine says what Rex holds there. A tap on any of them opens this conversation's own terminal on that
 * machine, since the terminal that Pi Pocket shows is always the one in the Pi Pocket session.
 */
export function PickerPage({ pocket, onOpen, onOpenOwn }) {
    const { html, useEffect, useRef, useState } = pocket;

    const [listing, setListing] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const [address, setAddress] = useState("");
    const [saving, setSaving] = useState(false);
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

    // Rex's own picker ends with a row that starts a session, and this one starts a shell in the Pi Pocket session on
    // the machine that Pi Pocket runs on: the one a person is already using.
    const create = async () => {
        setCreating(true);

        try {
            const made = await pocket.api("sessions", {}, { method: "POST" });

            setError(null);
            onOpen({ key: made.host });
        } catch (failure) {
            setError(failure.message);
        } finally {
            setCreating(false);
        }
    };

    // The other row that Rex's picker has: a machine that is not in any list yet, written where Rex keeps its own.
    const add = async () => {
        setSaving(true);

        try {
            await pocket.api("machines", { label: name, endpoint: address }, { method: "POST" });

            setAdding(false);
            setName("");
            setAddress("");
            setError(null);
            await read();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setSaving(false);
        }
    };

    // The machine that the terminal shows now, and whether the terminal is this conversation's own rather than one on a
    // machine that was chosen: a tick says which one a person already has open.
    const now = chosen();
    const mine = typeof pocket.conversationId === "function" ? pocket.conversationId() : null;
    const here = (host) => now !== null && now.host === host.key;

    const hosted = filtered(listing ?? [], query);
    const machines = hosted.length;
    const sessions = hosted.reduce((total, host) => total + host.sessions.length, 0);

    return html`<div class="gt-list">
        <div class="gt-filter">
            <${Mark}
                pocket=${pocket}
                path="M0 7.5a7.5 7.5 0 1 1 13.307 4.747l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 0 1 0 7.5Zm7.5-6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"
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
        ${mine !== null
            ? html`<ul class="gt-list-rows gt-own">
                  <li>
                      <button class="gt-session ${now === null ? "is-picked" : ""}" onClick=${() => onOpenOwn()}>
                          <span class="gt-session-tick" aria-hidden="true">
                              ${now === null ? html`<${Mark} pocket=${pocket} path=${TICK} size=${14} />` : null}
                          </span>
                          <span class="gt-session-name">This conversation's own terminal</span>
                      </button>
                  </li>
              </ul>`
            : null}
        ${listing !== null && listing.length === 0
            ? html`<p class="muted small">
                  No Rex server answered. Install Rex on this machine, or name a machine in Menu → Extensions → Rex.
              </p>`
            : null}
        ${listing !== null && listing.length > 0 && hosted.length === 0
            ? html`<p class="muted small">No machine or session has that name.</p>`
            : null}
        <ul class="gt-list-rows">
            ${hosted.map(
                (host) => html`<${Machine} key=${host.key} pocket=${pocket} host=${host} onOpen=${onOpen} here=${here(host)} />`,
            )}
        </ul>
        <div class="gt-picker-foot">
            ${adding
                ? html`<div class="gt-add">
                      <input
                          class="gt-filter-box gt-add-name"
                          type="text"
                          placeholder="Name"
                          aria-label="Name"
                          value=${name}
                          onInput=${(event) => setName(event.currentTarget.value)}
                      />
                      <input
                          class="gt-filter-box gt-add-host"
                          type="text"
                          placeholder="host or URL"
                          aria-label="Host or URL"
                          value=${address}
                          onInput=${(event) => setAddress(event.currentTarget.value)}
                      />
                      <div class="gt-add-actions">
                          <button class="button small muted" disabled=${saving} onClick=${() => setAdding(false)}>
                              Cancel
                          </button>
                          <button
                              class="button small"
                              disabled=${saving || name.trim() === "" || address.trim() === ""}
                              onClick=${add}
                          >
                              ${saving ? "Adding…" : "Add"}
                          </button>
                      </div>
                  </div>`
                : html`<button class="gt-session gt-new" disabled=${creating} onClick=${create}>
                          <${Mark} pocket=${pocket} path=${NEW_SESSION_ICON} />
                          <span class="gt-session-name">${creating ? "Starting…" : "New shell"}</span>
                      </button>
                      <button class="gt-session gt-new" onClick=${() => setAdding(true)}>
                          <${Mark} pocket=${pocket} path=${iconPathOf("globe")} />
                          <span class="gt-session-name">Add machine…</span>
                      </button>`}
        </div>
    </div>`;
}
