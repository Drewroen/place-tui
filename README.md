# place

A shared **1024×1024 tile map** you explore from the terminal. Every tile is a
colored square; you spawn at a random spot and walk around with the arrow keys.
Press space to choose a brush color, then every tile you walk onto is painted
with it.

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

```bash
make build          # npm ci + cargo build (debug client)

make server         # terminal 1: ws://localhost:8090
./bin/place-local   # terminal 2: client built from this checkout

make test           # server end-to-end tests
make check          # server + client tests

make link           # optional: put `place-local` on PATH (~/.local/bin)
./bin/release       # interactive release: bump, test, commit, tag, push
```


## Server

```bash
npm run world             # ws://0.0.0.0:8090
node world-server.js 9000 # pick a port
PORT=9000 node world-server.js
```
