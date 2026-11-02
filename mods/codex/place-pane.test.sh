#!/usr/bin/env bash
#
# Tests for the place Codex hook script, against a tmux server of their own.
#
#   bash mods/codex/place-pane.test.sh
#
# Nothing here touches the tmux you are sitting in, and the client is a
# stand-in that prints and waits.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/place-pane.sh

if ! command -v tmux >/dev/null; then
  echo "skip: tmux is not installed"
  exit 0
fi

tmp=$(mktemp -d)
sock=$tmp/sock
client=$tmp/fake-place
printf '#!/usr/bin/env bash\necho "client $*"\nsleep 600\n' >"$client"
chmod +x "$client"

cleanup() {
  tmux -S "$sock" kill-server 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

tmux -S "$sock" new-session -d -s test -x 120 -y 40 'bash --norc'
host=$(tmux -S "$sock" list-panes -t test -F '#{pane_id}' | head -1)

# How Codex runs a hook: inside the pane, with TMUX and TMUX_PANE set.
run() {
  local action=$1
  shift
  env TMUX="$sock,1,0" TMUX_PANE="$host" PLACE_MOD_BIN="$client" "$@" bash "$script" "$action"
}

games() { tmux -S "$sock" list-panes -a -F '#{pane_id} #{@place_mod}' | grep -c ' 1$' || true; }
panes() { tmux -S "$sock" list-panes -a -F '#{pane_id}' | wc -l; }
titles() { tmux -S "$sock" list-panes -a -F '#{pane_title}' | grep -c '^place$' || true; }

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1: want $2, got $3"
    fail=1
  fi
}

# A prompt opens one game, marked and titled, in a pty of its own.
run start
check "a prompt opens a game" 1 "$(games)"
check "the game is a second pane" 2 "$(panes)"
check "the game pane is titled place" 1 "$(titles)"
game=$(tmux -S "$sock" list-panes -a -F '#{pane_id} #{@place_mod}' | awk '$2 == 1 { print $1 }')
check "the client runs in that pane" 1 \
  "$(tmux -S "$sock" capture-pane -p -t "$game" | grep -c 'client' || true)"

# A second prompt reuses the pane instead of stacking another game.
run start
check "a second prompt reuses the game" 1 "$(games)"
check "still two panes" 2 "$(panes)"

# Stop closes it again.
run stop
check "stop closes the game" 0 "$(games)"
check "back to one pane" 1 "$(panes)"

# PLACE_MOD_KEEP=1 leaves the game up; close ignores keep.
run start
run stop PLACE_MOD_KEEP=1
check "keep leaves the game up" 1 "$(games)"
run close PLACE_MOD_KEEP=1
check "close ignores keep" 0 "$(games)"

# Outside tmux it does nothing, quietly, and still exits 0.
out=$(env -u TMUX -u TMUX_PANE PLACE_MOD_BIN="$client" bash "$script" start; echo "exit=$?")
check "outside tmux exits 0 and prints nothing" "exit=0" "$out"
check "outside tmux opens nothing" 1 "$(panes)"

# toggle flips what is open.
run toggle
check "toggle opens" 1 "$(games)"
run toggle
check "toggle closes" 0 "$(games)"

# The size, focus and server settings reach the split, and the client gets the server.
run start PLACE_MOD_SIZE=25% PLACE_MOD_FOCUS=0 PLACE_MOD_SERVER=ws://localhost:8090
check "a detached split still opens the game" 1 "$(games)"
check "the client was handed the server" 1 \
  "$(tmux -S "$sock" capture-pane -p -t "$(tmux -S "$sock" list-panes -a -F '#{pane_id} #{@place_mod}' | awk '$2 == 1 { print $1 }')" | grep -c 'ws://localhost:8090' || true)"
run close

# Settings can come from a file, because Codex scrubs custom variables out of a
# hook's environment.
printf 'PLACE_MOD_BIN=%s\n' "$client" >"$tmp/place-pane.env"
env -u PLACE_MOD_BIN TMUX="$sock,1,0" TMUX_PANE="$host" PLACE_MOD_ENV="$tmp/place-pane.env" \
  bash "$script" start
check "an env file reaches the client" 1 "$(games)"
env TMUX="$sock,1,0" TMUX_PANE="$host" PLACE_MOD_ENV="$tmp/place-pane.env" bash "$script" close

if [ "$fail" = "0" ]; then
  echo "all hook tests passed"
else
  echo "some hook tests failed"
  exit 1
fi
