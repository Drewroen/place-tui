# place — a Claude Code mod

A prompt is dead time: you send it, then watch a spinner. This mod hands that
time back. When you submit a prompt in Claude Code it splits the pane Claude runs
in, starts the `place` client there, and you play on the shared map while Claude
works. When the answer arrives the pane closes and you are back on the prompt.

You are playing a real `place` client — same client, same server, same other
players — not a redrawing of the map. Brush colors, key repeat, painting while
you walk and reconnect all behave exactly as they do in a terminal.

## Requirements

- Claude Code **v2.1.287 or later** (that is the first version that loads mods)
- **tmux 3.1 or later**, with Claude Code started inside it. A mod has no
  terminal of its own; tmux is what gives the game a pty.
- The `place` command on your `PATH` (`cargo install place-tui`), or
  `PLACE_MOD_BIN` pointing at a built client.

## Install

One step, from Claude Code 2.1.275 or later — this repository is a marketplace:

```
/plugin install place-tui --marketplace Drewroen/place-tui
```

Or from a shell:

```bash
claude plugin marketplace add Drewroen/place-tui
claude plugin install place-tui@place
```

From a checkout of this repository, without installing anything:

```bash
claude --plugin-dir mods/claude
```

## Use

Submit any prompt. The pane splits below Claude and the game takes the keyboard:
arrow keys or `wasd` to walk, `space` for the color picker, `q` or `esc` to leave.
Claude's answer appears above while you play; when the turn ends the pane closes
by itself.

`/place` opens the game when Claude is idle, and closes it again. `/place off`
always closes it, which is handy when `PLACE_MOD_KEEP=1` is set.

## Settings

Everything is optional, read from the environment Claude Code runs in:

| Variable | Default | What it does |
| --- | --- | --- |
| `PLACE_MOD_BIN` | `place` | The client to run, e.g. `./bin/place-local`. |
| `PLACE_MOD_SERVER` | the client's own | Server to connect to, e.g. `ws://localhost:8090`. |
| `PLACE_MOD_SIZE` | `40%` | Size of the split. |
| `PLACE_MOD_FOCUS` | on | `0` leaves the keyboard on Claude's pane instead of the game. |
| `PLACE_MOD_KEEP` | off | `1` leaves the game open when the answer arrives. |

Play against a server you run yourself:

```bash
PLACE_MOD_SERVER=ws://localhost:8090 PLACE_MOD_BIN=./bin/place-local \
  claude --plugin-dir mods/claude
```

## How it works

`hooks/register.js` is the mod's hooks module. It hangs on two events:

- `classic.UserPromptSubmit` — a prompt the person sent starts the wait, so the
  mod splits Claude's pane (`tmux split-window -t $TMUX_PANE`) and runs the
  client in it. Prompts Claude Code sends itself (a scheduled task, another
  session) open nothing.
- `classic.Stop` — the answer is complete, so the pane closes. `Stop` fires once
  per prompt, not once per model call, so a turn that pauses for a tool keeps the
  game up.

The panes it opens carry the tmux user option `@place_mod`, which is how the mod
finds the game again: tmux is the record of what is open, so a hot reload, a
`/clear`, or a prompt that lands while the game is still up never stacks a second
pane. Both events can block (a prompt, an answer), so a tmux that hangs costs the
game, never the turn.

## Test

```bash
claude plugin test mods/claude     # hook behavior against a fake tmux
claude plugin validate mods/claude # static analysis of hooks and mods API calls
```
