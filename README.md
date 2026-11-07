# pi-pocket-rex

A real terminal in Pi Pocket, hosted by [Rex](https://www.superlogical.com/rex/docs/installation), drawn by Ghostty's own
VT engine ([`libghostty-vt`](https://github.com/prime-radiant-inc/ts-libghostty)).

The shell is not this extension's. It lives in a Rex session, on this machine or on another one over Tailscale, where Rex
keeps it and where a person can also reach it from Rex's own app. This extension is a window onto those terminals: it
opens one Rex session of its own, named **Pi Pocket**, gives each conversation a window in it, named after the
conversation, draws that window's shell in a panel or a page, and sends what a person types back as the events that the
block takes.

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
icon that the machine gave itself, the sessions under it, and the windows of each session under those. A tap on a
session says which machine to open on, and the terminal is this conversation's window in the Pi Pocket session there. A
tap on a **window** opens the shell that the window already holds, wherever it is: a shell that a person started in Rex,
or the window of another conversation of Pi Pocket. That shell keeps its own program, and the terminal only watches it.
A window that holds no terminal, such as one a person split for an editor, stays on the list without a tap, because a
page cannot draw one.

The machines come from three places, and two entries for one machine are one row:

- **this machine**, when a Rex server is listening on its socket;
- the hosts that this machine's Rex server knows, which is the list Rex.app shows;
- the hosts that the setting names.

A machine that will not answer is a row that says so, rather than a list that fails.

The last two rows are Rex's own: **New shell** starts a shell in the Pi Pocket session on this machine, and **Add
machine…** names a machine that is in no list yet. A machine is written to this machine's Rex server, which is where Rex
keeps its own list, so Rex.app shows it too; with no server here there is nothing to write it to, and the settings are
the way in.

The panel is the other way in: `Control+Backquote` opens **this conversation's own terminal**, which is a window in the
Pi Pocket session on this machine, named after the conversation and started in its folder the first time that it is
asked for. A person who comes back to it — after a reload, or from another tab — finds the same window, because the
module writes down which window is the conversation's. The name of a window is not enough for that: two conversations
can share a name, such as two worktrees of one branch, and each of them keeps its own shell in its own folder.

## Choosing another machine or window

There are two ways to the picker, and either one is two taps:

- the **globe** in the terminal's bar, which puts the terminal away and shows the list;
- **Rex sessions** on the rail, or in the launcher.

The machine that the terminal is on has a **tick** beside it, and so does the window that it shows. Tap a session under
another machine and the terminal opens this conversation's window there. Tap a window and the terminal opens the shell
in that window. From then on `Control+Backquote` returns to the same one, and the bar says which machine and window it
is. Tap **This conversation's own terminal**, at the top of the list, to come back to this machine.

A window that a person made in Rex carries the name that the program in it gives itself, such as the file that an
editor has open, or the folder that it runs in when the program gives no name. The folder is short: its last three
parts, and a mark that there were more. A window that Pi Pocket made carries the name of its conversation.

A shell that was open before keeps running in Rex when another one is chosen: the terminal only stops watching it. A
window that the terminal only watches is never closed by Pi Pocket, not when the terminal goes, and not when the
conversation is archived: that shell belongs to the program that was in it.

The bar names the shell that it shows. A shell that Pi Pocket made carries the name of its conversation. A shell that
the module only watches carries the name that the program in it gives itself, such as the file that an editor has open,
or the folder that it runs in when the program gives no name. The folder is short: its last three parts, and a mark
that there were more.

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

The extension's screen only watches: the program talks to **Rex's** terminal, which answers its questions, such as where
the cursor is. An answer from the watching screen would reach the program a second time — `^[[21;1R` at a shell prompt,
because by then the shell is no longer waiting for one.

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
scrolls sideways, and a round button that puts the keyboard away. Tapping a modifier arms it for the next key, whether
that is one of the row's or a letter of the keyboard below. The row waits for a soft keyboard, so with a Bluetooth
keyboard there is none.

iOS covers the window with its keyboard instead of giving it room, so a screen as tall as the window would keep the line
being typed behind the keyboard. While the row is up, the page is as tall as the part of the window that the keyboard
leaves, and the shell gets the rows that fit there.

A wheel, or a finger that travels down the screen, moves the view through the scrollback. Typing brings it back to the
prompt, since the line that a person types must be the line that they can see.

A shell that a person leaves says nothing: its panel just goes, whatever the status of the last command was. A shell
that a signal stopped keeps the panel with what happened and a **New shell** button.

## When the last tab closes

A shell lives in Rex, not in the page, so closing the panel, or reloading the page, leaves it running. A tab of the app
says that it is here, and says goodbye when it goes; when the last tab has gone, the module ends what no tab is watching.
Each block that it opened closes. Rex closes a window by itself when its last block leaves, and it keeps an empty
session, so the module destroys the Pi Pocket session once no block is left in it; the next terminal makes it again.

**Archiving a conversation** is the other way that a terminal ends, and it does not wait for a tab to go. That
conversation's block closes rather than being given back, so its window closes with it and the windows of the other
conversations stay as they are. The session goes only if that was its last window.

A session that still holds a block stays: an editor, or a program that a person started in Rex beside the shell. A
reload is a goodbye and a hello a moment apart, so the module waits ten seconds before it ends anything.

A tab that **dies** — a crashed browser, a phone that lost its network, a Pi Pocket that a restart took — says no
goodbye, and would leave its shells behind for good. So the module writes down the session that it makes, the blocks
that it opened in it, and the window that each conversation got, in `~/.pi-pocket/rex/made.json` (`PI_POCKET_DIR` moves
the folder), and a tab that says hello is the moment that it looks at them: every block in that file that no terminal
holds is closed, and a session in it that no block is left in is destroyed. Whether a client has the session open says
nothing about a person's work, because Rex.app stays attached to every session there is, so an empty one is a leftover.
A look waits a minute before the next one, since a reload is a hello too.

Nothing outside that file is ever destroyed: a session that Rex.app made, or that a person made with the Rex CLI, is not
the module's to end, however empty it is. A session that an older Pi Pocket made for a conversation is such a session,
because the file that it kept was a list of names; `rex session ls` shows it, and `rex session kill <id>` clears it.

A file from a version that kept only the sessions and the blocks says nothing about the windows. The first shell of
each conversation after that version starts a window of its own, and the look closes the shells that the older version
left behind.

## The font

The screen draws with **JetBrains Mono, with Nerd Font's glyphs**, and with the font's ligatures. Nothing is bundled,
because an extension of the gallery may not carry a file over 512 KB. Pi Pocket serves **`Pocket Mono`** and **`Pocket
Nerd Symbols`** to every tab, so the terminal looks the same on a laptop, a phone, and a machine with nothing installed.
A person's own Nerd font is one line away — put its name above `"Pocket Mono"` in `terminal.css`.

## What it does not do

- **No mouse, no images.** Keys and text go in; the screen comes out. Kitty graphics and mouse tracking are not wired, so
  clicking a file name in a full-screen program does nothing.
- **A terminal outlives a panel.** The shell is Rex's, so closing the panel, or restarting the server, leaves it
  running; closing the last tab of the app, or archiving the conversation, is what ends it (see [When the last tab
  closes](#when-the-last-tab-closes)).
- **The terminals are the owner's.** A drop-in runs with its owner's rights, and so does anything typed in this page. The
  panel and its routes are for the owner alone; guests and viewers get no route at all.

## Development

```bash
mise run preview      # a page with a real Rex terminal at http://127.0.0.1:4711, without Pi Pocket
mise run test         # everything: the runner, the client, the module, and the page in a browser
mise run test:fast    # everything that needs no browser
mise run check        # typecheck, and parse the browser modules as a browser does
```

The same two commands are what CI runs: `.github/workflows/ci.yml` checks and runs `test:fast` on every pull request.
It takes the types of Pi Pocket's extension API from the copy that Pi Pocket publishes, because a checkout has none — Pi
Pocket writes them beside an installed drop-in, not in a repository.

The browser tests are not in CI, and the reason is Rex: they drive the page against a real Rex server, and Rex is not
installable without an account. Run them on a machine that has it, with `mise run test`.

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
