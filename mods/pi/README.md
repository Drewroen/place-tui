# place — a Pi extension

A prompt is dead time: you send it, then watch it think. This extension hands
that time back. When a run starts it splits the pane Pi runs in, starts the
`place` client there, and you play on the shared map while Pi works. When the run
settles the pane closes and you are back on the prompt.

You are playing a real `place` client — same client, same server, same other
players — not a redrawing of the map. Brush colors, key repeat, painting while
you walk and reconnects all behave exactly as they do in a terminal.

## Requirements

- **Pi 1.x** (`@earendil-works/pi-coding-agent`), tested against 1.5.0
- **tmux 3.1 or later**, with Pi started inside it. An extension has no terminal
  of its own; tmux is what gives the game a pty.
- The `place` command on your `PATH` (`cargo install place-tui`), or
  `PLACE_MOD_BIN` pointing at a built client.

## Install

From a checkout of this repository, install `mods/pi` as a Pi package:

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

Submit any prompt. The pane splits below Pi and the game takes the keyboard:
arrow keys or `wasd` to walk, `space` for the color picker, `q` or `esc` to
leave. Pi's answer appears above while you play; when the run settles the pane
closes by itself.

`/place` opens the game when Pi is idle, and closes it again. `/place off` always
closes it, which is handy when `PLACE_MOD_KEEP=1` is set.

## Settings

Everything is optional, read from the environment Pi runs in:

| Variable | Default | What it does |
| --- | --- | --- |
| `PLACE_MOD_BIN` | `place` | The client to run, e.g. `./bin/place-local`. |
| `PLACE_MOD_SERVER` | the client's own | Server to connect to, e.g. `ws://localhost:8090`. |
| `PLACE_MOD_SIZE` | `40%` | Size of the split. |
| `PLACE_MOD_FOCUS` | on | `0` leaves the keyboard on Pi's pane instead of the game. |
| `PLACE_MOD_KEEP` | off | `1` leaves the game open when the run settles. |

Play against a server you run yourself:

```bash
PLACE_MOD_SERVER=ws://localhost:8090 PLACE_MOD_BIN=./bin/place-local \
  pi -e mods/pi/place.ts
```

## How it works

`place.ts` is one extension module. It hangs on three events:

- `agent_start` — Pi began working on a run, so the extension splits Pi's pane
  (`tmux split-window -t $TMUX_PANE`) and runs the client in it.
- `agent_settled` — Pi is finally idle, so the pane closes. Not `agent_end`: that
  one also fires before a retry, a compaction retry, or a queued follow-up, and
  the game should stay up through those.
- `session_shutdown` — leaving Pi closes the pane it opened, so a game is never
  left running in a pane nobody owns.

The panes it opens carry the tmux user option `@place_mod`, which is how the
extension finds the game again: tmux is the record of what is open, so a
`/reload`, an aborted run, or a run that starts while the game is still up never
stacks a second pane.

## Test

```bash
node --test mods/pi/place.test.ts
```

The tests drive a private tmux server with a stand-in client: the split, the
mark, reuse, `/place`, keep, and cleanup all run for real, and nothing touches
the tmux you are sitting in.
