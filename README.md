# pi-pocket-rex

A real terminal in Pi Pocket, drawn by Ghostty's own VT engine
([`libghostty-vt`](https://github.com/prime-radiant-inc/ts-libghostty)), in a panel beside the conversation.

Pi Pocket has no terminal. Its shell commands (`!git status`) and background tasks run without a pty, so a program that
asks the terminal what it is, moves a cursor, or waits for a keystroke cannot run there. This extension gives those
programs a real one: `vim`, `less`, `ssh`, a REPL, `watch`.

## What it needs

- **Bun** (1.3.13 or newer), because `libghostty-vt` is a Bun FFI binding. Pi Pocket's server runs on Node, so the
  extension starts a Bun process for each terminal and talks to it in JSON lines. The module finds Bun in `PATH`, in
  mise's installs, or where its own setting says.
- **Linux x64 or arm64, or macOS arm64**: the platforms that `libghostty-vt` ships a prebuilt library for.

## Install

```bash
bun run scripts/install.ts      # or: mise run ext:install
```

It writes:

| Where                                      | What                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `~/.pi-pocket/extensions/rex.ts`  | the module: routes, events, the terminals                         |
| `~/.pi-pocket/extensions/rex/`    | the browser module: the panel, its screen, its stylesheet         |
| `~/.pi-pocket/rex/`               | the runtime: `pty-host.ts` and `libghostty-vt`                    |

Then turn it on in **Menu → Extensions → Rex**. It docks beside the conversation where the Browser and
Files panels dock, and takes a **tile in the places** — a terminal belongs to the session that it works in, not to the
app — and `Control+Backquote` opens and closes it from anywhere. It opens as a **page** too, in the place of the
conversation, for a screen of its own; a button of its bar moves it from one surface to the other, and both draw the
same shell. Set `PI_POCKET_DATA` to install into another data folder.

Settings, in Menu → Extensions: the shell to run (empty: your own, with `-l`), the Bun binary, and the runtime folder.

## How it is put together

- `extensions/rex.ts` — the drop-in module. One Bun process for each terminal, a `Terminal` record with the
  screen that it last sent, and the routes that the page calls: create, attach, input, resize, scroll, end.
- `src/pty-host.ts` — the Bun side: `Bun.spawn` with a pty, `Terminal` + `RenderState` from `libghostty-vt`, and a
  frame of the rows that changed, at most one each 16 ms.
- `extensions/rex/index.js` — the panel, its page, its tile in the places, and a launcher action.
- `extensions/rex/terminal.js` — the screen: runs of cells painted into rows of spans, the cursor, the wheel for scrollback,
  and a hidden textarea whose keystrokes go to `libghostty-vt`'s key encoder on the server.
- `extensions/rex/terminals.js` — the page that lists every shell, whichever session started it, and ends one.
- `extensions/rex/terminal.css` — the look, from the app's theme tokens.

Why the extra process: `libghostty-vt` imports `bun:ffi`, which Node does not have. Nothing else needs Bun.

## Keys

| Key                    | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `Control+Backquote`    | opens the terminal, or puts it away            |

Ghostty's own bindings use Super, and a browser keeps Super and `Ctrl+W` for itself, so this page uses Control.

Command belongs to Pi Pocket on an Apple keyboard: ⌘B folds the sidebar, ⌘K opens the launcher, and the shell never
sees them, since a shell has no byte for Command. Control is the shell's everywhere, as readline and an editor read it.
With the keys outside the terminal — a click on the sidebar, say — a key that the app takes for itself is the app's,
and the others are the terminal's.

Each session has one shell, with a pty of its own at the size of the panel, and the module keeps eight at once: it
refuses a ninth. Closing the panel keeps the shell: the one a person comes back to is the one that was there. Opening
the Browser or Files panel closes this one, since a window shows one panel at a time, and the shell keeps running.

A tab that closes leaves its shell running, with nowhere to show it. **All terminals**, on the rail, is the page that
finds those: every shell that the module keeps, with the session and the folder that it works in, and a button that ends
it after a second tap.

## The font

The screen draws with **JetBrains Mono, with Nerd Font's glyphs**, and with the font's ligatures: `->` is an arrow,
`!=` is a not-equal sign, and a file tree has its icons. Nothing is bundled, because an extension of the gallery may not
carry a file over 512 KB. On this machine, put the font in `~/.local/share/fonts` and run `fc-cache -f`; a browser that
was already open needs a restart before it sees a new font.

The stack leads with the two fonts that Pi Pocket serves, because the page was drawn to look like them: **`Pocket
Mono`** is JetBrains Mono, and **`Pocket Nerd Symbols`** is the icons alone, in the private use areas and no further.
Every tab of the app has both, so the terminal looks the same on a laptop, a phone, and a machine with nothing
installed. A person's own Nerd font is one line away — put its name above `"Pocket Mono"` in `terminal.css` — and it
then draws the text, with the icons still coming from `Pocket Nerd Symbols`.

What each of them has, measured per glyph: `Pocket Mono` carries what JetBrains Mono ships itself — powerline arrows
(`U+E0B0`), box drawing (`U+2500`), blocks (`U+2588`) — and no editor icons at all. The Nerd patch's icons are only in
`Pocket Nerd Symbols`: Font Awesome (`U+F121`, `U+F07B`), Material (`U+EA71`), Devicons (`U+E702`), Octicons
(`U+F408`). It is one weight, which is one more reason that no weight is ever made up.

An older version of this page measured the names that a Nerd Font goes by, since a native terminal and a browser can know
the same font by different names. That went with the version that made Pi Pocket's own font the first choice: there is
nothing to find when the font is in every tab.

| Name in the stack             | Where it comes from                              |
| ----------------------------- | ------------------------------------------------ |
| `JetBrainsMono Nerd Font`     | [nerd-fonts](https://github.com/ryanoasis/nerd-fonts) `JetBrainsMono.zip` |
| `JetBrainsMono NF`            | the same font, under the name that some installs use |
| `JetBrains Mono NL`, `JetBrains Mono` | the font without the glyphs: ligatures, no icons |

## What the panel says, and where

A shell that a person leaves — `exit`, or `^D` at its prompt — takes the panel with it, as a terminal's own window
does, and says nothing, whatever the status of its last command said: a shell ends with the status of the command
before it, so `false` and then a `^D` is 1, and that is not news about the shell. So does a shell that the app ends, with
**End** or the archive of its session.

A shell that a signal stopped keeps the panel open with what happened — `The shell was interrupted.` after a `^C`,
`The shell was stopped.` when a signal ends it, or that with the signal's name when it is another one — a **New shell**
button, and a way to put the note away. The note lies over the screen instead of above it, because a line taken from a
terminal changes the columns and rows of everything in it. A status alone cannot bring it on: a shell that catches the
signal says so with a status, and the panel leaves it at that.

## A phone's keyboard

A soft keyboard has no Escape and no Control, so the panel puts a row above it: a round Control, a band of keys that
scrolls sideways, and a round button that puts the keyboard away. It starts with what a shell and an editor reach for
first — Escape, Tab, the modifiers, the arrows, Home and End, the page keys — then the characters that a keyboard keeps
on its second page.

The input that holds the keys sits at the cursor and is one pixel wide, because a phone shows a keyboard for an input
that it can see and not for one parked off the edge of the page, and its text is 16px because a smaller one makes a phone
zoom the page in when it takes the focus.

Tapping a key of the row does not take the keys away: the tap's own action is stopped, and the terminal asks for the
focus back inside the tap, which is the only moment a system that owns the keyboard lets a page ask for it.

The row waits for a soft keyboard. A keyboard either takes a keyboard's worth of height, as this app's viewport setting
makes it do, or covers the window without resizing it; a Bluetooth keyboard does neither, so with one there is no row.
Tapping a modifier arms it for the next key, typed or tapped: `Control`, then `←`, is a word back.

## Neovim

Neovim runs in this terminal with its own modes, registers, and motions, because the terminal answers what Neovim asks
of a terminal:

- **`+` copies to the system clipboard**, and `+` pastes from it, through OSC 52. Neovim needs a clipboard provider that
  speaks it; nothing else on the machine is involved, so this works over SSH and from a phone too.

  ```lua
  local osc52 = require("vim.ui.clipboard.osc52")

  vim.g.clipboard = {
      name = "OSC 52",
      copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
      paste = { ["+"] = osc52.paste("+"), ["*"] = osc52.paste("*") },
  }
  vim.opt.clipboard = "unnamedplus"
  ```

  A copy comes from Neovim, not from the person's own keystroke, and a browser may refuse it or ask first. The page
  falls back when it can, and says in the bar when a copy did not land.
- **The cursor is a block in normal mode and a bar in insert mode**, as `guicursor` says (DECSCUSR). Underline and blink
  come through too.
- **A paste is a bracketed paste** when Neovim asked for one, so `:set paste` is not needed and autoindent stays honest.
- **Focus changes go in** (DECSET 1004), for a `FocusGained` autocmd.

Keys are encoded by Ghostty's key encoder on the server, with the modes that Neovim set, so `<C-a>`, `<C-6>`, Alt keys,
and the arrow keys are what Neovim asked for. One key is not: a browser keeps **`<C-w>`** for closing a tab, and a page
cannot take it back. Use `<C-w>` alternatives, or install Pi Pocket as an app, where the window may let it through.

On an iPad, the system owns the **Escape** key: pressing it puts the on-screen keyboard away. The terminal still gets
the key, and the page asks the keyboard back a moment later, which the system may allow. Two Escapes work whatever the
system does: the **Esc** key in the row above a soft keyboard, which sends the key without moving the focus, and
**`Control+[`**, which is Escape to every terminal.

## What it does not do

- **A terminal ends with the server, or with the extension's next version.** A save of
  `~/.pi-pocket/extensions/rex.ts` starts new shells.
- **One terminal for each session.** Opening the panel again finds the shell you left, with its screen. Two sessions
  in the same folder are two shells.
- **A session's shell goes with it.** Archiving a session ends its shells, for everyone who saw it. An archived session
  starts none of its own; **New shell** starts one there if you want it.
- **No mouse, no images.** Keys and text go in; the screen comes out. Kitty graphics and mouse tracking are not wired,
  so clicking a file name in a full-screen program does nothing.
- **The shell is the person's own.** A drop-in runs with its owner's rights, and so does anything typed in this page.
  The panel and its routes are for the owner alone; guests and viewers get no route at all.

## Development

```bash
mise run preview      # a page with a real shell at http://127.0.0.1:4711, without Pi Pocket
mise run test         # everything: the pty, the module, and the page in a browser
mise run test:fast    # everything that needs no browser
mise run check        # typecheck, and parse the browser module as a browser does
```

`test/browser.test.ts` drives the page in Chromium with Puppeteer: a tap is a real touch, a soft keyboard is a viewport
that lost a keyboard's worth of height, and a shell is a real pty. It exists because the page's behaviour — when the
row of keys shows, what a tap does to the focus, what a program's screen gives back — cannot be seen from a unit test, and four
rounds of broken buttons and vanishing rows were four rounds of finding that out by hand. `CHROME_PATH` names the
browser; the default is the Chromium that Pi Pocket keeps for its own browser panel.

`scripts/preview.ts` serves the module's own routes behind a small HTTP server and gives the page a fake `pocket`, so
the screen can be tried in a browser before Pi Pocket loads the extension. `test/fake-web.ts` is the same idea for
tests: it records what the module sends and lets a test call its routes.

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

The sidecar is not kept in the repository. It says where one installation came from, and its hashes are of the files on
the machine that wrote it.
