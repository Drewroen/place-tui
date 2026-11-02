'use strict';

/* Read-only map viewer for world-server.
 *
 * Connects as a viewer ("?viewer" in the WebSocket URL), draws the whole
 * map, and applies live deltas — but never sends anything: no moves, no
 * paints. Viewers don't get a player on the map and don't count as players.
 * The page is static hosting; the only server it talks to is the existing
 * world-server over its WebSocket.
 *
 * The map fills the viewport, pans with a drag, zooms with the wheel/pinch,
 * and wraps at every edge.
 *
 * Point it somewhere else with ?server=ws://localhost:8090
 */

const DEFAULT_SERVER = 'wss://place-tui.fly.dev';

const params = new URLSearchParams(location.search);
const SERVER = params.get('server') || DEFAULT_SERVER;
// Watch rather than play: no spawn point, no avatar, not counted as a player.
const WS_URL = SERVER.includes('?') ? `${SERVER}&viewer` : `${SERVER}?viewer`;

// Terminal cells are taller than they are wide, so the map stretches each
// tile vertically. The exact ratio depends on the terminal font; override it
// with ?aspect=2.0, for example, to match your own cell shape.
const DEFAULT_CELL_ASPECT = 1.75;
const requestedAspect = Number.parseFloat(params.get('aspect') || '');
const CELL_ASPECT = Number.isFinite(requestedAspect) && requestedAspect > 0
  ? Math.min(Math.max(requestedAspect, 0.5), 4)
  : DEFAULT_CELL_ASPECT;

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

// The 1px-per-tile world is painted once into an offscreen canvas. The visible
// canvas fills the viewport and samples it with a repeating pattern.
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

// view.zoom is tile width in CSS pixels. Tile height is zoom * CELL_ASPECT.
// cx/cy are the world tile coordinates at the center of the screen.
const DEFAULT_TILE_WIDTH = 6;
const MAX_TILE_WIDTH = 48;
const view = { cx: 0, cy: 0, zoom: DEFAULT_TILE_WIDTH };
let screenW = 1;
let screenH = 1;
let dpr = 1;

let width = 0;
let height = 0;
let tiles = null; // Uint8Array of palette indices
let palette = []; // [{ name, rgb }]
let players = new Map(); // id -> { x, y }
let viewerCount = 0;      // includes this page
let attempts = 0;
let dirty = true;
let frame = null; // ImageData for the offscreen map

// ---- view math -------------------------------------------------------------

/** The smallest zoom where one copy of the map still covers the viewport. */
function minZoom() {
  if (!width || !height) return 1;
  return Math.max(screenW / width, screenH / (height * CELL_ASPECT));
}

function clampZoom(zoom) {
  return Math.min(MAX_TILE_WIDTH, Math.max(minZoom(), zoom));
}

function defaultZoom() {
  return clampZoom(Math.max(DEFAULT_TILE_WIDTH, minZoom()));
}

/** Keep the center bounded; the map is a torus, so this changes nothing visual. */
function normalizeView() {
  if (!width || !height) return;
  view.cx = ((view.cx % width) + width) % width;
  view.cy = ((view.cy % height) + height) % height;
}

function resize() {
  screenW = Math.max(1, window.innerWidth);
  screenH = Math.max(1, window.innerHeight);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(screenW * dpr));
  canvas.height = Math.max(1, Math.round(screenH * dpr));
  canvas.style.width = `${screenW}px`;
  canvas.style.height = `${screenH}px`;
  if (tiles) {
    view.zoom = clampZoom(view.zoom);
    normalizeView();
  }
  dirty = true;
}

window.addEventListener('resize', resize);
resize();

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

  const tileW = view.zoom;
  const tileH = tileW * CELL_ASPECT;
  const visW = screenW / tileW;
  const visH = screenH / tileH;
  const ox = view.cx - visW / 2;
  const oy = view.cy - visH / 2;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e5e5e5';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // A repeating pattern gives us the toroidal wrap for free.
  const pattern = ctx.createPattern(off, 'repeat');
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.setTransform(
      tileW * dpr, 0,
      0, tileH * dpr,
      -ox * tileW * dpr, -oy * tileH * dpr,
    );
    ctx.fillRect(ox, oy, visW, visH);
  }

  // Players are drawn in every wrapped copy that can overlap the viewport.
  if (players.size) {
    ctx.fillStyle = '#00ff00';
    for (const p of players.values()) {
      const startX = p.x + Math.floor((ox - p.x) / width) * width;
      const startY = p.y + Math.floor((oy - p.y) / height) * height;
      for (let wx = startX; wx < ox + visW; wx += width) {
        for (let wy = startY; wy < oy + visH; wy += height) {
          if (wx + 1 > ox && wx < ox + visW && wy + 1 > oy && wy < oy + visH) {
            ctx.fillRect(wx, wy, 1, 1);
          }
        }
      }
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
    const keepView = !!tiles && (msg.width | 0) === width && (msg.height | 0) === height;
    width = msg.width | 0;
    height = msg.height | 0;
    palette = (msg.palette || []).map((c) => ({
      name: c.name,
      rgb: rgbFromHex(ANSI[c.fg] || '#e5e5e5'),
    }));

    off.width = width;
    off.height = height;
    frame = offCtx.createImageData(width, height);
    tiles = decodeRLE(msg.rle || []);
    players = new Map(
      (msg.players || []).filter((p) => p.id !== msg.id).map((p) => [p.id, p]),
    );
    viewerCount = msg.viewers | 0;

    if (keepView) {
      view.zoom = clampZoom(view.zoom);
      normalizeView();
    } else {
      view.cx = width / 2;
      view.cy = height / 2;
      view.zoom = defaultZoom();
    }

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
  } else if (msg.type === 'viewers') {
    viewerCount = msg.count | 0;
  }
  $count.textContent = tiles ? `players: ${players.size} · viewers: ${viewerCount}` : '';
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
    ws = new WebSocket(WS_URL);
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

// ---- pan & zoom ------------------------------------------------------------

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function zoomAt(x, y, factor) {
  if (!tiles) return;
  const oldZoom = view.zoom;
  const newZoom = clampZoom(oldZoom * factor);
  if (Math.abs(newZoom - oldZoom) < 1e-6) return;

  // Keep the world point under the cursor pinned while scaling.
  const wx = view.cx + (x - screenW / 2) / oldZoom;
  const wy = view.cy + (y - screenH / 2) / (oldZoom * CELL_ASPECT);
  view.zoom = newZoom;
  view.cx = wx - (x - screenW / 2) / newZoom;
  view.cy = wy - (y - screenH / 2) / (newZoom * CELL_ASPECT);
  normalizeView();
  dirty = true;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = eventPos(e);
  const dy = e.deltaMode === 1
    ? e.deltaY * 16
    : e.deltaMode === 2
      ? e.deltaY * screenH
      : e.deltaY;
  zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const pointers = new Map(); // pointerId -> { x, y } in CSS pixels
let drag = null;            // last pointer position while one finger drags
let pinch = null;           // gesture anchor while two pointers pinch

function anchorPinch(a, b) {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  pinch = {
    zoom0: view.zoom,
    dist0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
    wx0: view.cx + (midX - screenW / 2) / view.zoom,
    wy0: view.cy + (midY - screenH / 2) / (view.zoom * CELL_ASPECT),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (pointers.size >= 2) return;
  canvas.setPointerCapture(e.pointerId);
  const p = eventPos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    drag = p;
    canvas.classList.add('dragging');
  } else {
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
    view.cx -= (p.x - drag.x) / view.zoom;
    view.cy -= (p.y - drag.y) / (view.zoom * CELL_ASPECT);
    normalizeView();
    drag = p;
    dirty = true;
  } else if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
    const zoom = clampZoom(pinch.zoom0 * dist / pinch.dist0);
    view.zoom = zoom;
    view.cx = pinch.wx0 - (midX - screenW / 2) / zoom;
    view.cy = pinch.wy0 - (midY - screenH / 2) / (zoom * CELL_ASPECT);
    normalizeView();
    dirty = true;
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    pinch = null;
    drag = p;
  } else if (pointers.size === 0) {
    pinch = null;
    drag = null;
    canvas.classList.remove('dragging');
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---- play modal ------------------------------------------------------------

const playLink = document.getElementById('play');
const playModal = document.getElementById('play-modal');
if (playLink && playModal) {
  playLink.addEventListener('click', () => {
    if (typeof playModal.showModal === 'function') {
      playModal.showModal();
    } else {
      playModal.setAttribute('open', '');
    }
  });
  // Close when clicking the backdrop rather than the dialog content.
  playModal.addEventListener('click', (e) => {
    if (e.target === playModal) playModal.close();
  });
}

// Click-to-copy the install command. The clipboard API needs a secure context;
// when it's unavailable (testing over plain http, etc.) select the text instead
// so the usual Cmd/Ctrl-C works.

const copyBtn = document.getElementById('copy');
const installCode = document.getElementById('install-command');
if (copyBtn && installCode) {
  copyBtn.addEventListener('click', async () => {
    const cmd = installCode.textContent.trim();
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(installCode);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    copyBtn.classList.add('copied');
    copyBtn.setAttribute('aria-label', 'Copied');
    copyBtn.title = 'Copied';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.setAttribute('aria-label', 'Copy install command');
      copyBtn.title = 'Copy install command';
    }, 1200);
  });
}
