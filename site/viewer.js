'use strict';

/* Read-only map viewer for world-server.
 *
 * Connects like the `place` terminal client does, draws the whole map, and
 * applies live deltas — but never sends anything: no moves, no paints. The
 * page is static hosting; the only server it talks to is the existing
 * world-server over its WebSocket.
 *
 * Point it somewhere else with ?server=ws://localhost:8090
 */

const DEFAULT_SERVER = 'wss://place-tui.fly.dev';

const params = new URLSearchParams(location.search);
const SERVER = params.get('server') || DEFAULT_SERVER;

// Standard 16-color ANSI palette (xterm values), keyed by SGR fg code — the
// same codes the server's palette is built from.
const ANSI = {
  30: '#000000', 31: '#cd0000', 32: '#00cd00', 33: '#cdcd00',
  34: '#0000ee', 35: '#cd00cd', 36: '#00cdcd', 37: '#e5e5e5',
  90: '#7f7f7f', 91: '#ff0000', 92: '#00ff00', 93: '#ffff00',
  94: '#5c5cff', 95: '#ff00ff', 96: '#00ffff', 97: '#ffffff',
};

const $status = document.getElementById('status');
const $count = document.getElementById('count');
const $tile = document.getElementById('tile');
const $serverLabel = document.getElementById('server');
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');

let width = 0;
let height = 0;
let tiles = null; // Uint8Array of palette indices
let palette = []; // [{ name, rgb }]
let players = new Map(); // id -> { x, y }
let attempts = 0;
let dirty = true;
let frame = ctx.createImageData(1, 1); // resized on init

$serverLabel.textContent = SERVER.replace(/^wss?:\/\//, '');

// ---- rendering -------------------------------------------------------------

function rgbFromHex(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Write one pixel of `color` (palette index) into the frame. */
function paintTile(i, color) {
  const rgb = palette[color] ? palette[color].rgb : [229, 229, 229];
  const data = frame.data;
  data[i * 4 + 0] = rgb[0];
  data[i * 4 + 1] = rgb[1];
  data[i * 4 + 2] = rgb[2];
  data[i * 4 + 3] = 255;
}

function render() {
  if (!dirty || !tiles) return;
  dirty = false;
  ctx.putImageData(frame, 0, 0);

  // Other players, in green — info only, we track them and nothing else.
  ctx.fillStyle = '#00ff00';
  for (const p of players.values()) {
    if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) {
      ctx.fillRect(p.x, p.y, 1, 1);
    }
  }
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();

// ---- messages --------------------------------------------------------------

function decodeRLE(rle) {
  const out = new Uint8Array(width * height);
  let i = 0;
  for (let k = 0; k < rle.length; k += 2) {
    const color = rle[k];
    const count = rle[k + 1];
    for (let j = 0; j < count && i < out.length; j++, i++) {
      out[i] = color;
      paintTile(i, color);
    }
  }
  return out;
}

function handle(msg) {
  if (msg.type === 'init') {
    width = msg.width | 0;
    height = msg.height | 0;
    palette = (msg.palette || []).map((c) => ({
      name: c.name,
      rgb: rgbFromHex(ANSI[c.fg] || '#e5e5e5'),
    }));
    canvas.width = width;
    canvas.height = height;
    frame = ctx.createImageData(width, height);
    tiles = decodeRLE(msg.rle || []);
    players = new Map(
      (msg.players || []).filter((p) => p.id !== msg.id).map((p) => [p.id, p]),
    );
    dirty = true;
    setStatus('live', 'live');
    attempts = 0; // packets flow: the reconnect backoff has done its job
  } else if (msg.type === 'tile') {
    if (!tiles) return;
    const i = msg.y * width + msg.x;
    if (msg.x >= 0 && msg.y >= 0 && msg.x < width && msg.y < height) {
      tiles[i] = msg.color;
      paintTile(i, msg.color);
      dirty = true;
    }
  } else if (msg.type === 'pos') {
    const p = players.get(msg.id);
    if (p) {
      p.x = msg.x;
      p.y = msg.y;
      dirty = true;
    }
  } else if (msg.type === 'join') {
    players.set(msg.id, { x: msg.x, y: msg.y });
    dirty = true;
  } else if (msg.type === 'leave') {
    players.delete(msg.id);
    dirty = true;
  }
  $count.textContent = tiles ? `players: ${players.size + 1}` : '';
}

function setStatus(text, cls) {
  $status.textContent = text;
  $status.className = cls || '';
}

// ---- connection ------------------------------------------------------------

function connect() {
  setStatus('connecting…', '');
  let ws;
  try {
    ws = new WebSocket(SERVER);
  } catch {
    return scheduleReconnect();
  }

  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data));
    } catch {
      /* malformed frame: ignore, like the TUI client */
    }
  };

  ws.onclose = () => {
    setStatus('reconnecting…', 'down');
    scheduleReconnect();
  };
  ws.onerror = () => setStatus('error', 'down');
}

function scheduleReconnect() {
  attempts += 1;
  const secs = Math.min(1 << Math.min(attempts - 1, 4), 8);
  setTimeout(connect, secs * 1000);
}
connect();

// ---- hover inspection ------------------------------------------------------

canvas.addEventListener('pointermove', (e) => {
  if (!tiles) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const color = tiles[y * width + x];
  const name = palette[color] ? palette[color].name : '?';
  $tile.textContent = `(${x}, ${y}) · ${name}`;
});

canvas.addEventListener('pointerleave', () => {
  $tile.textContent = 'hover the map to inspect a tile';
});
