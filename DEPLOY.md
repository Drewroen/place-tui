# Deploying

There are two parts:

1. **The server** (`world-server.js`) — one always-on instance with a public
   `wss://` URL. It keeps the map in memory, so it must be a single persistent
   process (not serverless / not horizontally scaled).
2. **The client** (`place`) — what people install; it points at your server.

[Fly.io](https://fly.io) is the recommended host: a persistent machine, free TLS,
and a volume so the map survives restarts. The repo already includes a
`Dockerfile` and `fly.toml`.

## One-time setup (Fly.io)

```bash
brew install flyctl
fly auth login

cd <repo>
fly launch --no-deploy --copy-config   # creates the app; change `app` in fly.toml if the name is taken
fly volumes create place_data --region sjc --size 1
```

`fly.toml` runs exactly one machine (`min_machines_running = 1`,
`auto_stop_machines = false`) and mounts the volume at `/data`, with
`WORLD_STATE_FILE=/data/world.bin` so the map persists across deploys.

Deploy manually once:

```bash
fly deploy
```

Your server is now live at `wss://<app>.fly.dev`. Verify:

```bash
place wss://<app>.fly.dev
```

## Auto-deploy on every push to `main`

`.github/workflows/deploy.yml` deploys to Fly on every push to `main` (and via
the Actions **Run workflow** button). It needs one repository secret:

```bash
fly tokens create deploy
gh secret set FLY_API_TOKEN --repo Drewroen/place-tui   # paste the token
```

Until that secret exists, the deploy job is **skipped** (CI still runs), so
nothing breaks before setup.

That's it — push to `main` and it ships.

## Point the client at your server

Users connect with:

```bash
place wss://<app>.fly.dev

# or set it once for their shell:
export PLACE_SERVER=wss://<app>.fly.dev
place
```

To make it the built-in default (so `place` alone works), set `DEFAULT_SERVER` in
`place/src/main.rs` to your URL, cut a release tag, and reinstall.

## Other hosts

- **Render** — create a Web Service from the Dockerfile (WebSockets are
  supported; use a paid instance so it doesn't spin down), copy its **Deploy
  Hook** URL into a `RENDER_DEPLOY_HOOK` secret, and add a step that `curl`s it.
- **Any VPS with Docker** —

  ```bash
  docker build -t place .
  docker run -d --restart=always -p 8090:8090 \
    -v place_data:/data -e WORLD_STATE_FILE=/data/world.bin place
  ```

  Put Caddy or nginx in front for TLS (e.g. Caddy: `reverse_proxy localhost:8090`).

## Client binaries

`.github/workflows/release.yml` builds `place` for macOS (arm64 + x86_64), Linux
(x86_64 + aarch64) and Windows on every `v*` tag and attaches the archives to the
GitHub Release. Users without Rust can download those; users with Rust can run:

```bash
cargo install --git https://github.com/Drewroen/place-tui place
```
