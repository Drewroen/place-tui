# place for Codex CLI

Play on the shared map while Codex works. Codex has no extension API, but it has
[lifecycle hooks](https://developers.openai.com/codex/hooks), and two of them
bookend the thing we care about:

| Hook | What the mod does |
| --- | --- |
| `UserPromptSubmit` | splits the pane Codex runs in and starts `place` there |
| `Stop` | closes it, unless `PLACE_MOD_KEEP=1` |
| `Interrupt` | closes it when you hit Escape |
| `SessionEnd` | closes it if you quit mid-turn |

A Codex hook is a shell command, so this mod is a script: `place-pane.sh`. It
uses the same pane and the same `PLACE_MOD_*` settings as the Claude Code and Pi
integrations.

## Install

```bash
mkdir -p ~/.codex/hooks
cp place-pane.sh ~/.codex/hooks/
```

Then merge `hooks.json` from this directory into `~/.codex/hooks.json`. If you
have no hooks file yet, copying it over is the merge:

```bash
cp hooks.json ~/.codex/hooks.json
```

Start Codex, run `/hooks` and trust the four entries — Codex pins trust to each
hook's exact command, so editing them means trusting again. In automation, where
nobody can answer `/hooks`, pass `--dangerously-bypass-hook-trust` to
`codex exec`.

Needs tmux 3.1+ and a `place` client on `PATH` (`cargo install place-tui`).

## Settings

Put these in `~/.codex/hooks/place-pane.env`, one `NAME=value` per line:

| Variable | Default | |
| --- | --- | --- |
| `PLACE_MOD_BIN` | `place` | The client to run, e.g. `./bin/place-local`. |
| `PLACE_MOD_SERVER` | the client's own | e.g. `ws://localhost:8090` for a local server. |
| `PLACE_MOD_SIZE` | `40%` | Height or width of the split, as tmux takes it. |
| `PLACE_MOD_FOCUS` | `1` | `0` keeps the keyboard on Codex instead of the game. |
| `PLACE_MOD_KEEP` | `0` | `1` leaves the pane open when the turn stops. |

Use the file rather than exporting variables: Codex passes hooks a filtered
environment (`TMUX`, `PATH`, `HOME` and friends survive, a custom
`PLACE_MOD_BIN` does not). The other route is to put the setting on the hook
command itself in `hooks.json`, which works too:

```json
{ "type": "command", "command": "PLACE_MOD_FOCUS=0 bash ~/.codex/hooks/place-pane.sh start" }
```

## By hand

Hooks only fire around prompts, so the script also runs on its own:

```bash
bash ~/.codex/hooks/place-pane.sh toggle
```

Bind that to a tmux key if you want it a keystroke away. `/place` as a Codex
slash command is not available here: slash commands run inside a prompt turn,
and Codex plugins bundle skills and MCP servers rather than hook-only commands.

## Notes

- Game mode: the pane takes the keyboard, so to talk to Codex switch panes
  (`prefix` + arrow) or set `PLACE_MOD_FOCUS=0`.
- Tested against Codex CLI 0.166.0, where `hooks` is a stable feature flag and
  `UserPromptSubmit`/`Stop` both fire for `codex exec` and the TUI. Older
  versions have no hooks at all.
- `bash place-pane.test.sh` runs the script's tests against a tmux server of
  its own; it never touches the one you are sitting in.
