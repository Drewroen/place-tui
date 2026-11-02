#!/usr/bin/env bash
#
# place for Codex CLI — open the shared map in a tmux pane while Codex works.
#
# Codex calls this from its lifecycle hooks (see hooks.json next to this file).
# A hook is a plain command, so this is the whole mod: it splits the pane Codex
# runs in, starts the place client there, and closes it when the turn stops.
#
#   place-pane.sh start    open the game           (UserPromptSubmit)
#   place-pane.sh stop     close it                (Stop, honouring PLACE_MOD_KEEP)
#   place-pane.sh close    close it, always        (Interrupt, SessionEnd)
#   place-pane.sh toggle   flip whatever is open   (by hand)
#
# Settings, all optional. Codex scrubs custom variables out of a hook's
# environment, so put these in place-pane.env next to this script (~/.codex/hooks/)
# as NAME=value lines, or inline on the hook command in hooks.json.
#   PLACE_MOD_BIN      client to run                 (default: place)
#   PLACE_MOD_SERVER   server to connect to          (default: the client's own)
#   PLACE_MOD_SIZE     split size                    (default: 40%)
#   PLACE_MOD_FOCUS    "0" keeps the keys on Codex   (default: the game takes them)
#   PLACE_MOD_KEEP     "1" leaves the pane open when the turn stops
#
# Every path exits 0 and prints nothing: UserPromptSubmit adds stdout to the
# model's context, and Stop reads stdout as JSON. A failure here must cost the
# game, never the turn.
set -u

# Codex hands hooks a scrubbed environment: TMUX and PATH arrive, but a custom
# variable like PLACE_MOD_BIN usually does not. So settings can also live in a
# small file, which is the route to prefer when editing hooks.json is awkward.
# Point PLACE_MOD_ENV somewhere else to move it.
env_file=${PLACE_MOD_ENV:-$HOME/.codex/hooks/place-pane.env}
if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

MARK='@place_mod'
TAB=$'\t'

size=${PLACE_MOD_SIZE:-40%}
bin=${PLACE_MOD_BIN:-place}
server=${PLACE_MOD_SERVER:-}
focus=${PLACE_MOD_FOCUS:-1}
keep=${PLACE_MOD_KEEP:-0}

# The pane ids this script has the mark on, as tmux lists them right now.
marked() {
  tmux list-panes -a -F "#{pane_id}${TAB}#{${MARK}}" 2>/dev/null |
    awk -F '\t' '$2 == "1" { print $1 }'
}

inside_tmux() {
  [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]
}

start_pane() {
  inside_tmux || return 0
  [ -n "$(marked)" ] && return 0

  set -- -t "$TMUX_PANE" -l "$size" -P -F '#{pane_id}'
  [ "$focus" = "1" ] || set -- -d "$@"

  local pane
  if [ -n "$server" ]; then
    pane=$(tmux split-window "$@" "$bin" "$server" 2>/dev/null) || return 0
  else
    pane=$(tmux split-window "$@" "$bin" 2>/dev/null) || return 0
  fi
  case $pane in
    %[0-9]*) ;;
    *) return 0 ;;
  esac

  # Marking and titling are cosmetic: the pane is playable without them, so a
  # failure here costs the cleanup, not the game.
  tmux set-option -p -t "$pane" "$MARK" 1 2>/dev/null
  tmux select-pane -t "$pane" -T place 2>/dev/null
}

close_panes() {
  inside_tmux || return 0
  local pane
  for pane in $(marked); do
    tmux kill-pane -t "$pane" 2>/dev/null
  done
}

case ${1:-} in
  start) start_pane ;;
  stop) [ "$keep" = "1" ] || close_panes ;;
  close) close_panes ;;
  toggle)
    if [ -n "$(marked)" ]; then close_panes; else start_pane; fi
    ;;
  *)
    printf 'usage: %s start|stop|close|toggle\n' "${0##*/}" >&2
    exit 0
    ;;
esac

exit 0
