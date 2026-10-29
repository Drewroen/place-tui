# place

A shared **1024×1024 tile map** you explore from the terminal. Every tile is a
colored square; you spawn at a random spot, walk around with the arrow keys, and
repaint the tile under you with the spacebar. Everyone connected sees the same
map and each other, live.

```
┌────────────┐        ws://        ┌──────────────────┐
│  place A   │◄──────────────────► │                  │
├────────────┤                     │   world-server   │
│  place B   │◄──────────────────► │  (1024×1024 map) │
├────────────┤                     │                  │
│  place C   │◄──────────────────► │                  │
└────────────┘                     └──────────────────┘
```

Each tile is a **single character cell** of solid background color. Your position
is a bold **white** `●`; other players are bold **green** dots. On white tiles the
dots switch to darker colors so they stay visible.

```
                ●
         ·
 place  (550, 973)  color: magenta  players: 2  viewers: 1  |  arrows/wasd move  space paint  q quit
```

(`●` bold white is you; `·` bold green are other players.)

## Requirements

- Node.js **21+** — runs the world server
- Rust toolchain ([rustup.rs](https://rustup.rs)) — builds the `place` client

## Quick start

Install the client and run it. By default it connects to the public server at
`wss://place-tui.fly.dev`:

```bash
cargo install place-tui      # installs the `place` command
place
```

From a git checkout instead:

```bash
cargo install --git https://github.com/Drewroen/place-tui place-tui
```

`place [server]` points somewhere else when you want to:

```bash
place                              # wss://place-tui.fly.dev (default)
place wss://place-tui.fly.dev
place https://place-tui.fly.dev    # http(s):// is accepted too
place ws://localhost:8090          # a server you run yourself
PLACE_SERVER=ws://localhost:8090 place
```

Run two or more `place` clients (different terminals, or on different machines)
to see each other move and paint.

### Run your own server

```bash
npm install
npm run world                  # ws://localhost:8090
place ws://localhost:8090
```

## Local development

A `Makefile` wraps the usual loop. It builds a debug client and runs both
halves against `localhost:8090`; nothing is installed globally unless you ask.

```bash
make build          # npm ci + cargo build (debug client)

make server         # terminal 1: ws://localhost:8090
./bin/place-local   # terminal 2: client built from this checkout

make test           # server end-to-end tests
make check          # server + client tests

make link           # optional: put `place-local` on PATH (~/.local/bin)
```

`make link` installs a symlink, so it tracks edits to `bin/place-local` and you
can just run `place-local`. `make release` builds an optimized client and
`make clean` removes build artifacts. Both `make server` and `place-local` read
`PORT`, so `PORT=9000 make server` / `PORT=9000 place-local` runs a second world.

## Controls

| Key | Action |
| --- | --- |
| arrow keys / `wasd` | move one tile |
| space | cycle the color of the tile you're on |
| `q` / `Esc` / `Ctrl-C` | quit |

## Colors

12 colors from the standard 16-color ANSI palette, so they render in essentially
every terminal. Space cycles:

```
white → red → green → yellow → blue → magenta → cyan
      → bright red → bright green → bright yellow → bright blue → bright cyan → white
```

Tiles start white.

## Project layout

```
world-server.js           shared map server (Node, authoritative)
place/                    the terminal client (Rust) — installs the `place` command
  src/main.rs             TUI: raw mode, camera, single-cell tile rendering
site/                     read-only live map viewer — static page for GitHub Pages
test/world-smoke.mjs      server end-to-end test
Makefile                  local dev: build, server, client, test
bin/place-local           run the locally built client against the local server
Dockerfile, fly.toml      deploy the server (see DEPLOY.md)
.github/workflows/        CI, auto-deploy on push, and client releases
```

## Server

```bash
npm run world             # ws://0.0.0.0:8090
node world-server.js 9000 # pick a port
PORT=9000 node world-server.js
```

The server is authoritative: it owns the tile colors and player positions. On
connect a client receives the whole map run-length encoded (tiny while the map is
mostly uniform) plus its spawn point; after that the server broadcasts only
deltas (tile repaints and player moves). The map is a torus, so movement wraps
around the edges. Actions are rate-limited per connection, with separate budgets
for moves and paints plus a short per-tile paint cooldown; clients that keep
flooding after repeated warnings are disconnected. Tune it with
`MAX_MOVES_PER_SEC`, `MAX_PAINTS_PER_SEC`, `MAX_MESSAGES_PER_SEC`,
`PAINT_COOLDOWN_MS`, and `MAX_REJECTIONS_PER_SEC`. Set `WORLD_STATE_FILE` to
persist the map across restarts.

## Deploy

The server must be a single always-on instance. Push to `main` and GitHub Actions
deploys to Fly.io automatically (once set up) — a `Dockerfile` and `fly.toml` are
ready to go. See **[DEPLOY.md](DEPLOY.md)** for the one-time setup and other hosts.

## Live map website — place — the wild west

`site/` is a **read-only, live mirror** of the whole map. It opens a WebSocket to
the same world server, draws all 1024×1024 tiles on a `<canvas>`, and applies
updates as they happen — but it never paints. Left-click zooms in 2×, right-click
zooms out 2×, dragging pans the view, and on touch devices one finger pans,
a tap zooms in, and two fingers pinch-zoom. `?server=ws://localhost:8090`
points it elsewhere.

```
npm run world &                            # example: local server
cd site && python3 -m http.server 8123     # open http://localhost:8123
                                           #   ?server=ws://localhost:8090
```

Publish it via **Settings → Pages → Source: GitHub Actions**;
`.github/workflows/pages.yml` deploys `site/` on every push to `main`.

## Tests

```bash
make test             # or: npm test — world server end-to-end test
make check            # the above plus the client's unit tests
```

## Protocol

World server (`world-server.js`). Connect with `?viewer` in the WebSocket URL
to watch instead of play: viewers get the same map and deltas but no spawn
point, never appear in the player list, and their input is ignored.

Client → server (players only):

```jsonc
{ "type": "move",  "dx": -1, "dy": 0 }  // dx/dy are -1, 0 or 1
{ "type": "paint", "x": 550, "y": 973 } // cycle the tile you're standing on
                                         // x/y optional, but must match your
                                         // server-side position when present
```

Server → client:

```jsonc
{ "type": "init",  "id": 1, "width": 1024, "height": 1024,
  "palette": [{ "name": "white", "fg": 37 }, /* … 12 colors … */],
  "rle": [0, 1048576],                   // [color, count, color, count, …]
  "you": { "x": 550, "y": 973 },        // players only
  "players": [{ "id": 2, "x": 512, "y": 300 }],
  "viewers": 1 }
{ "type": "tile",  "x": 550, "y": 973, "color": 5 }
{ "type": "pos",   "id": 1, "x": 551, "y": 973 } // every move is answered with the
                                                  // authoritative position, even when
                                                  // the move is rate-limited away
{ "type": "join",  "id": 2, "x": 512, "y": 300 }
{ "type": "leave", "id": 2 }
{ "type": "viewers", "count": 3 }        // viewer count changed
{ "type": "error", "text": "Slow down." } // rate limited (at most once every few seconds)
{ "type": "error", "text": "Paint where you stand." }
```

## Troubleshooting

**`not a WebSocket server … (got HTTP 200 OK)`** — `place` reached something on
that port, but it isn't the world server. Check what's listening and start the
server on a free port:

```bash
lsof -nP -iTCP:8090 -sTCP:LISTEN     # who owns the port?
npm run world                        # start the world server
place ws://localhost:8090            # point the client at it
```

**`EADDRINUSE: address already in use 0.0.0.0:8090`** — the port is taken. Run on
another port and pass it to the client:

```bash
node world-server.js 9000
place ws://localhost:9000
```
