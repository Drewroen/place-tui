#!/usr/bin/env node
/**
 * world-server — a shared, wrapping 1024x1024 paint map.
 *
 * The server is authoritative: it owns the tile colors and player positions.
 * Every player is an anonymous guest (no names). On connect a client receives
 * the whole map run-length-encoded (tiny while the map is mostly uniform) plus
 * its spawn point. After that the server only broadcasts deltas: tile repaints
 * and player moves.
 *
 * The map is a torus: moving off one edge wraps to the opposite edge.
 *
 * Clients connect as players by default, or as viewers by adding "?viewer"
 * to the WebSocket URL (that's what the web viewer does). Viewers get the
 * same map and deltas but no spawn point, never appear in the player list,
 * and their input is ignored.
 *
 * Protocol (JSON):
 *   connect:  ws://host/?viewer   // join as a viewer instead of a player
 *   client -> server:
 *     { type: "move",  dx, dy }   // dx/dy are -1, 0 or 1 (players only)
 *     { type: "paint", x, y }     // cycle the color of the tile you're standing on
 *                                 // (players only; x/y are optional, but when sent they
 *                                 // must match the server's position for this player)
 *   server -> client:
 *     { type: "init",  id, width, height, palette, rle, you, players, viewers }
 *                                   // "you" is present for players only
 *     { type: "tile",  x, y, color }
 *     { type: "pos",   id, x, y }
 *     { type: "join",  id, x, y }
 *     { type: "leave", id }
 *     { type: "viewers", count }  // sent to everyone when the viewer count changes
 *     { type: "error", text }
 *
 * Run:  node world-server.js [port]
 * Env:  PORT, HOST
 */
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8090);
const HOST = process.env.HOST ?? '0.0.0.0';

const WIDTH = 1024;
const HEIGHT = 1024;
// Rate limits, per connection. Moves and paints get separate budgets because a
// held paint key is far more expensive (a full broadcast to everyone) and more
// visible (flickering) than a held movement key. MAX_ACTIONS_PER_SEC is the
// legacy single-budget name, still honored as a fallback.
const LEGACY_MAX_PER_SEC = process.env.MAX_ACTIONS_PER_SEC;
const MAX_MOVES_PER_SEC = Number(process.env.MAX_MOVES_PER_SEC ?? LEGACY_MAX_PER_SEC ?? 30);
const MAX_PAINTS_PER_SEC = Number(process.env.MAX_PAINTS_PER_SEC ?? LEGACY_MAX_PER_SEC ?? 8);
const MAX_MESSAGES_PER_SEC = Number(process.env.MAX_MESSAGES_PER_SEC ?? LEGACY_MAX_PER_SEC ?? 150);
const PAINT_COOLDOWN_MS = Number(process.env.PAINT_COOLDOWN_MS ?? 200); // per tile
const MAX_REJECTIONS_PER_SEC = Number(process.env.MAX_REJECTIONS_PER_SEC ?? 60);
const WARN_INTERVAL_MS = 3000; // don't nag on every dropped message

/**
 * 12 colors built from the standard 16-color ANSI palette (codes 30-37 and
 * 90-97), which every terminal supports. `fg` is the foreground SGR code; the
 * background code is `fg + 10`. Index 0 (white) is the starting color.
 */
const PALETTE = [
  { name: 'white', fg: 37 },
  { name: 'red', fg: 31 },
  { name: 'green', fg: 32 },
  { name: 'yellow', fg: 33 },
  { name: 'blue', fg: 34 },
  { name: 'magenta', fg: 35 },
  { name: 'cyan', fg: 36 },
  { name: 'bright red', fg: 91 },
  { name: 'bright green', fg: 92 },
  { name: 'bright yellow', fg: 93 },
  { name: 'bright blue', fg: 94 },
  { name: 'bright cyan', fg: 96 },
];
const COLORS = PALETTE.length;

// ---- world state -----------------------------------------------------------

const tiles = new Uint8Array(WIDTH * HEIGHT); // 0 == white
const clients = new Map(); // ws -> { id, x, y, lastAction, actions }
let nextId = 1;

// Optional persistence: set WORLD_STATE_FILE to a path to keep the map across
// restarts (useful on a host with a volume mounted).
const STATE_FILE = process.env.WORLD_STATE_FILE || null;

function loadState() {
  if (!STATE_FILE) return;
  try {
    const buf = fs.readFileSync(STATE_FILE);
    if (buf.length === tiles.length) {
      tiles.set(buf);
      log(`Loaded map state from ${STATE_FILE}`);
    } else {
      log(`Ignoring ${STATE_FILE}: expected ${tiles.length} bytes, got ${buf.length}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Could not load ${STATE_FILE}: ${err.message}`);
  }
}

function saveState() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, tiles);
  } catch (err) {
    log(`Could not save ${STATE_FILE}: ${err.message}`);
  }
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// ---- helpers ---------------------------------------------------------------

function log(...args) {
  console.log(`${C.dim}[${new Date().toLocaleTimeString()}]${C.reset}`, ...args);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, except = null) {
  const data = JSON.stringify(obj);
  for (const ws of clients.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function playerList() {
  return [...clients.values()]
    .filter((p) => !p.viewer)
    .map((p) => ({ id: p.id, x: p.x, y: p.y }));
}

function playerCount() {
  let n = 0;
  for (const p of clients.values()) if (!p.viewer) n++;
  return n;
}

function viewerCount() {
  return clients.size - playerCount();
}

function counts() {
  const p = playerCount();
  const v = viewerCount();
  return `${p} player${p === 1 ? '' : 's'}, ${v} viewer${v === 1 ? '' : 's'}`;
}

/** Does this connection want to watch rather than play? ("?viewer" in the URL) */
function isViewerRequest(req) {
  try {
    return new URL(req.url, 'http://x').searchParams.has('viewer');
  } catch {
    return false;
  }
}

function randomCoord(max) {
  return Math.floor(Math.random() * max);
}

/** Encode the whole map as [color, count, color, count, ...]. */
function encodeRLE() {
  const out = [];
  let color = tiles[0];
  let count = 1;
  for (let i = 1; i < tiles.length; i++) {
    if (tiles[i] === color) {
      count++;
    } else {
      out.push(color, count);
      color = tiles[i];
      count = 1;
    }
  }
  out.push(color, count);
  return out;
}

/** A token bucket that refills at `rate` per second (capacity `rate`). */
function bucket(rate) {
  return { tokens: rate, rate, last: Date.now() };
}

/** Spend one token; false when the bucket is empty. O(1), no allocation. */
function take(b) {
  const now = Date.now();
  b.tokens = Math.min(b.rate, b.tokens + ((now - b.last) / 1000) * b.rate);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function newActionState() {
  return {
    messages: bucket(MAX_MESSAGES_PER_SEC),
    moves: bucket(MAX_MOVES_PER_SEC),
    paints: bucket(MAX_PAINTS_PER_SEC),
    lastPaint: 0,
    rejections: 0,
    rejectionWindow: Date.now(),
    lastWarn: 0,
  };
}

/**
 * Refuse an action. Warn at most once every few seconds, and close the
 * connection (1008) if the client keeps flooding after the limit. A couple of
 * dropped actions from key repeat is normal; sustained rejection is not.
 *
 * Returns true when the socket was closed.
 */
function rejectAction(player, ws, text) {
  const now = Date.now();
  if (now - player.rejectionWindow > 1000) {
    player.rejectionWindow = now;
    player.rejections = 0;
  }
  player.rejections++;

  if (player.rejections > MAX_REJECTIONS_PER_SEC) {
    log(`${C.red}kick${C.reset} #${player.id}: too many dropped actions`);
    ws.close(1008, 'too many actions');
    return true;
  }
  if (now - player.lastWarn >= WARN_INTERVAL_MS) {
    player.lastWarn = now;
    send(ws, { type: 'error', text });
  }
  return false;
}

/** Wrap a coordinate around the toroidal map. */
function wrap(v, max) {
  return ((v % max) + max) % max;
}

// ---- connections -----------------------------------------------------------

loadState();

const wss = new WebSocketServer({ host: HOST, port: PORT });

// Persist the map periodically so a restart doesn't wipe everyone's art.
setInterval(saveState, 30_000).unref();

wss.on('connection', (ws, req) => {
  const viewer = isViewerRequest(req);
  const player = viewer
    ? { id: nextId++, viewer: true, ...newActionState() }
    : {
        id: nextId++,
        viewer: false,
        x: randomCoord(WIDTH),
        y: randomCoord(HEIGHT),
        ...newActionState(),
      };
  clients.set(ws, player);

  if (viewer) {
    log(`${C.cyan}watch${C.reset} #${player.id} — ${counts()}`);
  } else {
    log(`${C.green}join${C.reset} #${player.id} at (${player.x}, ${player.y}) — ${counts()}`);
  }

  send(ws, {
    type: 'init',
    id: player.id,
    width: WIDTH,
    height: HEIGHT,
    palette: PALETTE,
    rle: encodeRLE(),
    players: playerList(),
    viewers: viewerCount(),
    ...(viewer ? {} : { you: { x: player.x, y: player.y } }),
  });

  if (viewer) {
    broadcast({ type: 'viewers', count: viewerCount() }, ws);
  } else {
    broadcast({ type: 'join', id: player.id, x: player.x, y: player.y }, ws);
  }

  ws.on('message', (data) => {
    if (ws.readyState !== ws.OPEN) return;

    // Cheap ceiling on raw message volume, before spending time on JSON parse.
    if (!take(player.messages)) {
      rejectAction(player, ws, 'Slow down.');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (player.viewer) return; // viewers never move or paint

    if (msg.type === 'move') {
      if (!take(player.moves)) {
        // Still acknowledge where the server thinks we are: clients count these
        // replies to know when their position is settled (safe to paint from).
        send(ws, { type: 'pos', id: player.id, x: player.x, y: player.y });
        rejectAction(player, ws, 'Slow down.');
        return;
      }

      const dx = Math.sign(Number(msg.dx) || 0);
      const dy = Math.sign(Number(msg.dy) || 0);
      const nx = wrap(player.x + dx, WIDTH);
      const ny = wrap(player.y + dy, HEIGHT);
      if (nx !== player.x || ny !== player.y) {
        player.x = nx;
        player.y = ny;
        player.lastPaint = 0; // a fresh tile can be painted immediately
        broadcast({ type: 'pos', id: player.id, x: nx, y: ny });
      } else {
        // A no-op move still gets an acknowledgement so the client's in-flight
        // move count drains. Every move message gets exactly one `pos` reply.
        send(ws, { type: 'pos', id: player.id, x: player.x, y: player.y });
      }
    } else if (msg.type === 'paint') {
      // The server decides which tile is painted — never a coordinate the
      // client nominates. If coordinates are sent (new clients do), they must
      // match the authoritative position, which catches stale/desynced clients.
      if (msg.x !== undefined || msg.y !== undefined) {
        if (msg.x !== player.x || msg.y !== player.y) {
          rejectAction(player, ws, 'Paint where you stand.');
          return;
        }
      }

      // Coalesce key repeat before spending a token: repainting the same tile
      // faster than this only flickers and multiplies broadcasts.
      const now = Date.now();
      if (now - player.lastPaint < PAINT_COOLDOWN_MS) return;

      if (!take(player.paints)) {
        rejectAction(player, ws, 'Slow down.');
        return;
      }
      player.lastPaint = now;

      const i = player.y * WIDTH + player.x;
      tiles[i] = (tiles[i] + 1) % COLORS;
      broadcast({ type: 'tile', x: player.x, y: player.y, color: tiles[i] });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (player.viewer) {
      log(`${C.yellow}unwatch${C.reset} #${player.id} — ${counts()}`);
      broadcast({ type: 'viewers', count: viewerCount() });
    } else {
      log(`${C.yellow}leave${C.reset} #${player.id} — ${counts()}`);
      broadcast({ type: 'leave', id: player.id });
    }
  });

  ws.on('error', (err) => log(`${C.red}error${C.reset} #${player.id}: ${err.message}`));
});

wss.on('listening', () => {
  log(`World server on ${C.cyan}ws://${HOST}:${PORT}${C.reset}`);
  log(`Map ${WIDTH}x${HEIGHT} (wrapping), ${COLORS} colors, ${tiles.length} tiles.`);
});

wss.on('error', (err) => {
  log(`${C.red}server error:${C.reset} ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('Shutting down…');
    saveState();
    for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
