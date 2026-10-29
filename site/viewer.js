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
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');

// The 1px-per-tile world is painted once into an offscreen canvas; the visible
// canvas draws it scaled through the current view (zoom + offsets).
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');
const view = { scale: 1, ox: 0, oy: 0 };
const MIN_SCALE = 1;   // whole map
const MAX_SCALE = 32;  // 32-tile blocks

let width = 0;
let height = 0;
let tiles = null; // Uint8Array of palette indices
let palette = []; // [{ name, rgb }]
let players = new Map(); // id -> { x, y }
let attempts = 0;
let dirty = true;
let frame = ctx.createImageData(1, 1); // resized on init

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
  offCtx.putImageData(frame, 0, 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(view.scale, 0, 0, view.scale, -view.ox * view.scale, -view.oy * view.scale);
  ctx.drawImage(off, 0, 0, width, height);

  // Other players, in green — info only, we track them and nothing else.
  ctx.fillStyle = '#00ff00';
  for (const p of players.values()) {
    if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) {
      ctx.fillRect(p.x, p.y, 1, 1);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
off.width = width;
off.height = height;
view.scale = 1;
view.ox = 0;
view.oy = 0;
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

// ---- zoom (2× in on left click, 2× out on right click) ---------------------

function clampView() {
  const visW = width / view.scale;
  const visH = height / view.scale;
  view.ox = Math.min(Math.max(view.ox, 0), Math.max(0, width - visW));
  view.oy = Math.min(Math.max(view.oy, 0), Math.max(0, height - visH));
}

/** Map an event to its position in map pixels (canvas coordinates). */
function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    px: (e.clientX - rect.left) * (canvas.width / rect.width),
    py: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function zoomAt(px, py, factor) {
  if (!tiles) return;
  const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  if (target === view.scale) return; // already at a limit
  // Keep the tile under the cursor pinned while the scale changes.
  const wx = view.ox + px / view.scale;
  const wy = view.oy + py / view.scale;
  view.scale = target;
  view.ox = wx - px / view.scale;
  view.oy = wy - py / view.scale;
  clampView();
  dirty = true;
}

// ---- interaction -----------------------------------------------------------
// Desktop: left click zooms in 2×, right click zooms out 2×, drag pans.
// Touch: one finger pans, two fingers pinch-zoom (either direction).

canvas.addEventListener('click', (e) => {
  if (suppressClick) return; // was a drag/pinch, not a tap
  const t = eventPos(e);
  zoomAt(t.px, t.py, 2);
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // don't show the browser menu — right click means zoom out
  const t = eventPos(e);
  zoomAt(t.px, t.py, 0.5);
});

const pointers = new Map(); // pointerId -> { px, py } (canvas coordinates)
let drag = null;            // { px, py, ox, oy } while one pointer pans
let pinch = null;           // gesture anchor while two pointers pinch
let suppressClick = false;  // set when a gesture moved, so a stray click won't zoom

function anchorPinch(a, b) {
  const midPx = (a.px + b.px) / 2;
  const midPy = (a.py + b.py) / 2;
  pinch = {
    scale0: view.scale,
    dist0: Math.max(Math.hypot(a.px - b.px, a.py - b.py), 1),
    wx0: view.ox + midPx / view.scale,
    wy0: view.oy + midPy / view.scale,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return; // right click = zoom out
  if (pointers.size >= 2) return;                          // pinch already running
  canvas.setPointerCapture(e.pointerId);
  const p = eventPos(e);
  pointers.set(e.pointerId, p);
  suppressClick = false;
  if (pointers.size === 1) {
    drag = { px: p.px, py: p.py, ox: view.ox, oy: view.oy };
  } else if (pointers.size === 2) {
    drag = null;
    const [a, b] = [...pointers.values()];
    anchorPinch(a, b);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !tiles) return;
  const p = eventPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1 && drag) {
    // Only treat it as a pan once it moves a little, so mouse clicks aren't
    // swallowed by sub-pixel jitter (click handler still zooms then).
    if (Math.abs(p.px - drag.px) + Math.abs(p.py - drag.py) > 4) {
      suppressClick = true;
    }
    view.ox = drag.ox - (p.px - drag.px) / view.scale;
    view.oy = drag.oy - (p.py - drag.py) / view.scale;
    clampView();
    dirty = true;
  } else if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const dist = Math.max(Math.hypot(a.px - b.px, a.py - b.py), 1);
    const midPx = (a.px + b.px) / 2;
    const midPy = (a.py + b.py) / 2;
    suppressClick = true;
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.scale0 * dist / pinch.dist0));
    // Keep the world point the pinch started on under the midpoint.
    view.ox = pinch.wx0 - midPx / view.scale;
    view.oy = pinch.wy0 - midPy / view.scale;
    clampView();
    dirty = true;
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 1) {
    // A pinch ended with one finger still down: keep panning smoothly.
    const [p] = [...pointers.values()];
    pinch = null;
    drag = { px: p.px, py: p.py, ox: view.ox, oy: view.oy };
  } else if (pointers.size === 0) {
    pinch = null;
    drag = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
