# place

A terminal client for a shared **1024×1024 tile map**. Every tile is a colored
square. You spawn at a random spot and walk around with the arrow keys. Press
space to choose a brush color, then every tile you walk onto is painted with it.

## Install

```bash
cargo install place-tui
```

Or straight from git:

```bash
cargo install --git https://github.com/Drewroen/place-tui place-tui
```

From a local checkout:

```bash
# into ~/.cargo/bin (make sure it's on your PATH)
cargo install --path .

# ...or into ~/.local/bin, which is on the PATH on many systems
cargo install --path . --root ~/.local
```

Then just run:

```bash
place
```

By default this connects to the public server at `wss://place-tui.fly.dev`.

## Run your own server

To point at a server you run yourself instead:

```bash
node world-server.js          # ws://localhost:8090
place ws://localhost:8090
```
