# place — a Pi extension

A prompt is dead time: you send it, then watch it think. This extension hands
that time back. When a run starts it opens the shared map in Pi's own UI, so you
can walk around and paint while Pi works; when the run settles it closes and you
are back on the prompt.

The game runs inside Pi: no second terminal, no tmux, no child process, no
dependency. It speaks the same WebSocket protocol as the `place` client and draws
the same picture — same camera, colours, keys, colour picker, status bar and
prediction — from rules mirrored out of `place/src/main.rs`.

## Requirements

- **Pi 1.x** (`@earendil-works/pi-coding-agent`), tested against 1.5.0
- Pi's interactive UI (`ctx.ui`); print mode has nowhere to draw

That is the whole list. There is no `place` binary to install: this talks to the
server itself.

## Install

Install the package straight from this repository — the root `package.json`
declares the extension under its `pi` key:

```bash
pi install git:github.com/Drewroen/place-tui
```

From a checkout of this repository, install the `mods/pi` subdirectory instead:

```bash
pi install ./mods/pi
```

Or copy the file into Pi's extensions directory, which auto-discovers it (and
lets `/reload` pick up edits):

```bash
cp mods/pi/place.ts ~/.pi/agent/extensions/
```

Or load it for one session only:

```bash
pi -e mods/pi/place.ts
```

## Use

Submit any prompt. The map takes the middle of the page and the keyboard — the
transcript and prompt stay visible around it — with arrow keys or `wasd` to walk,
`space` for the colour picker, `enter` to choose a brush, `q` or `esc` to leave.
Pi keeps working behind it; when the run settles the game closes by itself and
the answer is there.

`/place` opens the game any time, including while a run is going, and closes it
again. `/place off` closes it, which is handy when `PLACE_MOD_KEEP=1` is set.

Keystrokes are read as raw bytes and understood in both encodings a terminal may
send: the legacy escapes (arrows as `ESC [ A`, escape as a bare `ESC`) and the
Kitty keyboard protocol Pi switches on where it is available (`ESC [ 27 u` for
escape, `ESC [ 1 ; 1 A` for arrows, letters as codepoints).

## Settings

Everything is optional, read from the environment Pi runs in:

| Variable | Default | What it does |
| --- | --- | --- |
| `PLACE_MOD_SERVER` | `wss://place-tui.fly.dev` | Server to connect to, e.g. `ws://localhost:8090`. |
| `PLACE_MOD_SIZE` | `80%` | Share of the screen the game box takes. The rest of the page stays visible. |
| `PLACE_MOD_KEEP` | off | `1` leaves the game open when the run settles. |

Play against a server you run yourself:

```bash
PLACE_MOD_SERVER=ws://localhost:8090 pi -e mods/pi/place.ts
```

## How it works

`place.ts` is one extension module, in two halves.

**The game** is pure functions over a state object — `applyFrame` decodes the
server's frames (`init`, `tile`, `pos`, `join`, `leave`, `viewers`, `error`),
`handleKey` maps a keystroke to the messages the client would send, `renderFrame`
paints the viewport, picker and status bar. They follow the Rust client rule for
rule: moves are predicted and then replayed over each `pos` reply, a paint waits
while moves are in flight, the picker wraps left and right but stops at the ends,
a chosen brush rides along on every move.

**The shell** is Pi's side: `ctx.ui.custom()` with `overlay: true` puts the game in
a box in the middle of the page — `PLACE_MOD_SIZE`, 80% by default — with the
keyboard, and `esc` hands both back. Three events drive it:

- `agent_start` — Pi began working on a run, so the game opens.
- `agent_settled` — Pi is finally idle, so it closes. Not `agent_end`: that one
  also fires before a retry, a compaction retry, or a queued follow-up, and the
  game should stay up through those.
- `session_shutdown` — leaving Pi closes the game, so nothing is left connected.

Tiles are drawn as full blocks in the palette colour rather than as background
colour behind a space: Pi trims trailing space from a rendered line, which would
erase any line that is one flat colour.

## Test

```bash
node --test mods/pi/place.test.ts
```

Thirty tests, no Pi and no server needed: the frame decoder, prediction, the paint
queue, the picker layout, the key map and the rendered lines. They are the record
of what must not drift from `place/src/main.rs`.
