#!/usr/bin/env node
/**
 * world-server — a shared, wrapping 1000x1000 paint map.
 *
 * The server is authoritative: it owns the tile colors and player positions.
 * Every player is an anonymous guest (no names). On connect a client receives
 * the whole map run-length-encoded (tiny while the map is mostly uniform) plus
 * its spawn point. After that the server only broadcasts deltas: tile repaints
 * and player moves.
 *
 * The map is a torus: moving off one edge wraps to the opposite edge.
 *
 * Protocol (JSON):
 *   client -> server:
 *     { type: "move",  dx, dy }   // dx/dy are -1, 0 or 1
 *     { type: "paint" }           // cycle the color of the tile you're standing on
 *   server -> client:
 *     { type: "init",  id, width, height, palette, rle, you, players }
 *     { type: "tile",  x, y, color }
 *     { type: "pos",   id, x, y }
 *     { type: "join",  id, x, y }
 *     { type: "leave", id }
 *     { type: "error", text }
 *
 * Run:  node world-server.js [port]
 * Env:  PORT, HOST
 */
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8090);
const HOST = process.env.HOST ?? '0.0.0.0';

const WIDTH = 1000;
const HEIGHT = 1000;
const MAX_ACTIONS_PER_SEC = Number(process.env.MAX_ACTIONS_PER_SEC ?? 120); // move/paint messages allowed per second

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
  return [...clients.values()].map((p) => ({ id: p.id, x: p.x, y: p.y }));
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

function isRateLimited(player) {
  const now = Date.now();
  if (now - player.lastAction > 1000) {
    player.lastAction = now;
    player.actions = 0;
  }
  player.actions++;
  return player.actions > MAX_ACTIONS_PER_SEC;
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

wss.on('connection', (ws) => {
  const player = {
    id: nextId++,
    x: randomCoord(WIDTH),
    y: randomCoord(HEIGHT),
    lastAction: 0,
    actions: 0,
  };
  clients.set(ws, player);

  log(
    `${C.green}join${C.reset} #${player.id} at (${player.x}, ${player.y}) — ` +
      `${clients.size} online`,
  );

  send(ws, {
    type: 'init',
    id: player.id,
    width: WIDTH,
    height: HEIGHT,
    palette: PALETTE,
    rle: encodeRLE(),
    you: { x: player.x, y: player.y },
    players: playerList(),
  });

  broadcast({ type: 'join', id: player.id, x: player.x, y: player.y }, ws);

  ws.on('message', (data) => {
    if (isRateLimited(player)) {
      send(ws, { type: 'error', text: 'Slow down.' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'move') {
      const dx = Math.sign(Number(msg.dx) || 0);
      const dy = Math.sign(Number(msg.dy) || 0);
      const nx = wrap(player.x + dx, WIDTH);
      const ny = wrap(player.y + dy, HEIGHT);
      if (nx !== player.x || ny !== player.y) {
        player.x = nx;
        player.y = ny;
        broadcast({ type: 'pos', id: player.id, x: nx, y: ny });
      }
    } else if (msg.type === 'paint') {
      const i = player.y * WIDTH + player.x;
      tiles[i] = (tiles[i] + 1) % COLORS;
      broadcast({ type: 'tile', x: player.x, y: player.y, color: tiles[i] });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`${C.yellow}leave${C.reset} #${player.id} — ${clients.size} online`);
    broadcast({ type: 'leave', id: player.id });
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
