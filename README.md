# pi-pocket-rex

A real terminal in Pi Pocket, hosted by [Rex](https://www.superlogical.com/rex/docs/installation), drawn by Ghostty's own
VT engine ([`libghostty-vt`](https://github.com/prime-radiant-inc/ts-libghostty)).

The shell is not this extension's. It lives in a Rex session, on this machine or on another one over Tailscale, where Rex
keeps it and where a person can also reach it from Rex's own app. This extension is a window onto those terminals: it
picks a session the way Rex's picker does, opens that session's terminal, draws its screen in a panel or a page, and
sends what a person types back as the events that the block takes.

## What it needs

- **Rex**, on this machine or on a machine that this one can reach. A server on this machine listens on a Unix socket,
  which is what the extension uses by default; one on another machine needs a tailnet listener, which is what
  `rex server run --extra-listen tailnet://:7297` gives it.
- **Bun** (1.3.13 or newer), because `libghostty-vt` is a Bun FFI binding. Pi Pocket's server runs on Node, so the
  extension starts a Bun process for each terminal and talks to it in JSON lines. The module finds Bun in `PATH`, in
  mise's installs, or where its own setting says.
- **Linux x64 or arm64, or macOS arm64**: the platforms that `libghostty-vt` ships a prebuilt library for.

## Install

```bash
bun run scripts/install.ts      # or: mise run ext:install
```

It writes:

| Where                              | What                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `~/.pi-pocket/extensions/rex.ts`   | the module: the host list, the terminals, the routes              |
| `~/.pi-pocket/extensions/rex/`     | the browser module: the picker, the screen, its stylesheet        |
| `~/.pi-pocket/extensions/_rex-client.ts` | the connection to a Rex server, and a terminal's stream     |
| `~/.pi-pocket/rex/`                | the runtime: `rex-host.ts`, `screen.ts`, `escapes.ts`, `libghostty-vt` |

Then turn it on in **Menu → Extensions → Rex**. It docks beside the conversation where the Browser and Files panels
dock, and takes a **tile in the places**. `Control+Backquote` opens and closes it from anywhere.

## The picker

**Rex sessions**, on the rail, is the tree that Rex's own picker shows: a filter, a heading for each machine with the
icon that the machine gave itself, and the sessions under it. A tap opens that session's terminal.

The machines come from three places, and two entries for one machine are one row:

- **this machine**, when a Rex server is listening on its socket;
- the hosts that this machine's Rex server knows, which is the list Rex.app shows;
- the hosts that the setting names.

A machine that will not answer is a row that says so, rather than a list that fails.

The last two rows are Rex's own: **New session** starts a session on this machine with a shell in it, and **Add
machine…** names a machine that is in no list yet. A machine is written to this machine's Rex server, which is where Rex
keeps its own list, so Rex.app shows it too; with no server here there is nothing to write it to, and the settings are
the way in.

The panel is the other way in: `Control+Backquote` opens **this conversation's own terminal**, which is a session of the
person's on this machine, named after the conversation and started in its folder the first time that it is asked for. A
person who comes back to it — after a reload, or from another tab — finds the same one, because it is found by name
rather than remembered by a number.

## Choosing another session

There are two ways to the picker, and either one is two taps:

- the **globe** in the terminal's bar, which puts the terminal away and shows the list;
- **Rex sessions** on the rail, or in the launcher.

The session that the terminal shows has a **tick** beside it. Tap another one and the terminal opens on that session,
from then on: `Control+Backquote` returns to it, and the bar says which machine and session it is. Tap **This
conversation's own terminal**, at the top of the list, to come back to the one that belongs to the conversation.

A session that was open before keeps running in Rex when another one is chosen: the terminal only stops watching it.

## How it is put together

- `extensions/rex.ts` — the drop-in module. One Rex connection for each machine, one terminal for each block that a
  person opens, and the routes that the page calls: the host list, create, attach, input, resize, scroll, end.
- `extensions/_rex-client.ts` — one connection to one Rex server: the hello, its requests and answers, its events, and a
  terminal's stream with the resume that a dropped connection comes back from.
- `src/rex-host.ts` — the Bun side: a `Terminal` and a `RenderState` from `libghostty-vt`, fed the bytes of the stream,
  and a frame of the rows that changed, at most one each 16 ms.
- `src/screen.ts` — the screen that both hosts share: the runs of a row, the cursor, the frame pacing.
- `extensions/rex/index.js` — the panel, its page, its tile in the places, and a launcher action.
- `extensions/rex/picker.js` — the machines and their sessions, in Rex's form.
- `extensions/rex/terminal.js` — the screen: runs of cells painted into rows of spans, the cursor, the wheel for
  scrollback, and a hidden textarea whose keystrokes go to the terminal.
- `extensions/rex/terminal.css` — the look, from the app's theme tokens.

Why the extra process: `libghostty-vt` imports `bun:ffi`, which Node does not have. Nothing else needs Bun.

## A terminal's stream

A terminal's data connection carries the bytes that its program writes. Two kinds of bytes in it are not the program's,
and the module drops both:

- the **snapshot** that the stream starts with, in Ghostty's own format, which a screen cannot take. The screen that is
  already there is painted instead with `com.superlogical.terminal.format`, as escape sequences that redraw it;
- Rex's **own messages**, such as a resize or a theme, each an APC sequence that carries the connection's nonce, so that
  a program that prints the same bytes is not mistaken for Rex.

A dropped connection resumes from the byte that the module has, because the server keeps a stream for a minute after its
connection goes. That is what keeps a phone that lost its signal from losing the screen it was drawing.

## Settings

In Menu → Extensions: the socket of this machine's Rex server, the other machines (`label = host`, one for each line),
the Bun binary, and the runtime folder.

## Keys

| Key                 | What it does                        |
| ------------------- | ----------------------------------- |
| `Control+Backquote` | opens the terminal, or puts it away |

Keys go to Rex as `block.event`, which is the event that a block takes, so the terminal in Pi Pocket and the terminal in
Rex are one program. Rex encodes them with the modes that the running program set, so `<C-a>`, Alt keys, and the arrows
are what the program asked for. Command belongs to Pi Pocket on an Apple keyboard; Control is the shell's everywhere.

A soft keyboard has no Escape and no Control, so the panel puts a row above it: a round Control, a band of keys that
scrolls sideways, and a round button that puts the keyboard away. Tapping a modifier arms it for the next key. The row
waits for a soft keyboard, so with a Bluetooth keyboard there is none.

A shell that a person leaves says nothing: its panel just goes. A shell that a signal stopped, or a program that ended
with a code, keeps the panel with what happened and a **New shell** button.

## The font

The screen draws with **JetBrains Mono, with Nerd Font's glyphs**, and with the font's ligatures. Nothing is bundled,
because an extension of the gallery may not carry a file over 512 KB. Pi Pocket serves **`Pocket Mono`** and **`Pocket
Nerd Symbols`** to every tab, so the terminal looks the same on a laptop, a phone, and a machine with nothing installed.
A person's own Nerd font is one line away — put its name above `"Pocket Mono"` in `terminal.css`.

## What it does not do

- **No mouse, no images.** Keys and text go in; the screen comes out. Kitty graphics and mouse tracking are not wired, so
  clicking a file name in a full-screen program does nothing.
- **A terminal outlives Pi Pocket.** The shell is Rex's, so closing the panel, or restarting the server, leaves it
  running. Ending the terminal in Pi Pocket gives the block back; it does not end the program.
- **The terminals are the owner's.** A drop-in runs with its owner's rights, and so does anything typed in this page. The
  panel and its routes are for the owner alone; guests and viewers get no route at all.

## Development

```bash
mise run preview      # a page with a real Rex terminal at http://127.0.0.1:4711, without Pi Pocket
mise run test         # everything: the runner, the client, the module, and the page in a browser
mise run test:fast    # everything that needs no browser
mise run check        # typecheck, and parse the browser module as a browser does
```

`scripts/preview.ts` starts a Rex server of its own, in a temporary state folder and on a port of its own, creates a
session with a shell in it, and serves the module's routes behind a small HTTP server. **It must never use a server that
holds a person's sessions:** a test types `exit` into a shell, and a server started with `--exit-empty` destroys the
session that is left with nothing in it. The preview runs under Bun, which
cannot open the Unix socket that a Rex server listens on by default, so it uses a TCP listener that only the machine can
reach; `REX_PREVIEW_LOCAL` points it at another server instead.

`test/browser.test.ts` drives the page in Chromium with Puppeteer: a tap is a real touch, a soft keyboard is a viewport
that lost a keyboard's worth of height, and a shell is a real shell in a real Rex. `CHROME_PATH` names the browser; the
default is the Chromium that Pi Pocket keeps for its own browser panel.

`test/fake-rex.ts` is a Rex server for tests: the welcome, the hello, the methods these tests use, and a data connection
that a test pushes bytes into. `test/fake-web.ts` is the same idea for Pi Pocket's `Web`: it records what the module
sends and lets a test call its routes.

## The gallery entry and the sidecar

`docs/gallery-entry.json` is this extension's gallery entry: its `title` is **Rex**, which is the name a person
reads, though the module is `rex` and Pi Pocket names a local drop-in after its file.

Pi Pocket reads no entry from a repository. What puts the title in **Menu → Extensions** is the provenance sidecar that
it would write for a gallery install: `rex.gallery.json`, in the drop-in folder, holding that entry and the
index it came from. Write it after the files are installed:

```sh
mise run ext:install   # the module and its browser module
mise run sidecar       # ~/.pi-pocket/extensions/rex.gallery.json
```

`mise run gallery-entry` writes the entry again for `HEAD`, with each file's size and SHA-256 at that commit: run it on
the commit you deploy, before the sidecar, since the hashes have to be of the files that are out.
