# place

A terminal client for a shared **1000×1000 tile map**. Every tile is a colored
square. You spawn at a random spot, walk around with the arrow keys, and repaint
the tile you're standing on with the spacebar. Everyone connected sees the same
map and each other in real time.

```
                                                                 v
                                                              >  ●  <
                                                                 ^

 place  (550, 973)  color: magenta  online 2  |  arrows/wasd move  space paint  q quit
```

Each tile is a **7-column × 3-row block of colored background**. Terminal cells are
about twice as tall as they are wide, so 7×3 is close to square — and the odd
width centers the marker cleanly. Your position is marked with bold **white**
arrows pointing at your dot; other players appear as bold **green** dots.

## Install

With a Rust toolchain ([rustup.rs](https://rustup.rs)):

```bash
# into ~/.cargo/bin (make sure it's on your PATH)
cargo install --path .

# ...or into ~/.local/bin, which is on the PATH on many systems
cargo install --path . --root ~/.local
```

Or straight from git:

```bash
cargo install --git <repo-url> place
```

Then just run:

```bash
place
```

## Run the server

`place` needs a `world-server` running. From the repo root:

```bash
node world-server.js          # ws://localhost:8090
node world-server.js 9000     # or another port
```

## Usage

```
place [options] [server]

Arguments:
  server                WebSocket URL (default: ws://localhost:8090)

Options:
  -s, --server <url>    server URL
  -h, --help            show help
  -V, --version         show version
```

Examples:

```bash
place                          # ws://localhost:8090
place ws://localhost:8090
place wss://place.example.com
PLACE_SERVER=wss://place.example.com place
```

### Controls

| Key | Action |
| --- | --- |
| arrow keys / `wasd` | move one tile |
| space | cycle the color of the tile you're on |
| `q` / `Esc` / `Ctrl-C` | quit |

## Colors

The server offers **12 colors** built from the standard 16-color ANSI palette,
which renders in essentially every terminal. The spacebar cycles through them in
this order:

`white → red → green → yellow → blue → magenta → cyan → bright red →
bright green → bright yellow → bright blue → bright cyan → white`

`white` is the starting color of every tile.

## Notes

- The whole map is sent once on connect, run-length encoded, then the server
  sends only deltas — so joining is cheap and the map stays in sync.
- Movement is optimistic locally and reconciled with the server, and the map
  wraps around at the edges.
- If the connection drops, `place` reconnects automatically with backoff and
  pulls a fresh map.
- `ws://` and `wss://` are both supported.
