/**
 * End-to-end smoke test for the world server.
 * Spawns the real server and drives it with real WebSocket clients.
 *
 * Run:  node test/world-smoke.mjs
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'world-server.js');
const PORT = 8124;
const WIDTH = 1000;
const HEIGHT = 1000;

function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });

  function waitFor(predicate, timeout = 3000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeout);
      waiters.push({ predicate, resolve, timer });
    });
  }

  const send = (obj) => ws.send(JSON.stringify(obj));
  const clear = () => {
    messages.length = 0;
  };
  return { ws, messages, open, waitFor, send, clear };
}

function decodeRLE(rle, expectedCells) {
  const tiles = [];
  for (let i = 0; i < rle.length; i += 2) {
    const color = rle[i];
    const count = rle[i + 1];
    for (let j = 0; j < count; j++) tiles.push(color);
  }
  assert.equal(tiles.length, expectedCells, 'RLE expands to exactly width*height cells');
  return tiles;
}

async function main() {
  const server = spawn(process.execPath, [serverPath, String(PORT)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MAX_ACTIONS_PER_SEC: '100000' },
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('World server')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const base = `ws://127.0.0.1:${PORT}`;

  // ---- alice connects ----
  const alice = createClient(base);
  await alice.open;
  const init = await alice.waitFor((m) => m.type === 'init');
  assert.equal(init.width, WIDTH);
  assert.equal(init.height, HEIGHT);
  assert.equal(init.palette.length, 12, '12 palette colors');
  assert.ok(init.palette.every((c) => typeof c.name === 'string' && typeof c.fg === 'number'));
  assert.ok(init.you.x >= 0 && init.you.x < WIDTH, 'spawn x in bounds');
  assert.ok(init.you.y >= 0 && init.you.y < HEIGHT, 'spawn y in bounds');
  assert.equal(init.players.length, 1, 'sees itself');
  assert.ok(!('name' in init), 'init carries no name');
  assert.ok(!('name' in init.players[0]), 'players carry no name');

  const initialTiles = decodeRLE(init.rle, WIDTH * HEIGHT);
  assert.ok(initialTiles.every((c) => c === 0), 'map starts all white (color 0)');

  // ---- bob connects; alice sees the join ----
  const bob = createClient(base);
  await bob.open;
  await bob.waitFor((m) => m.type === 'init');
  const join = await alice.waitFor((m) => m.type === 'join');
  assert.ok(join.x >= 0 && join.x < WIDTH && join.y >= 0 && join.y < HEIGHT);
  assert.ok(!('name' in join), 'join carries no name');

  // ---- movement + wrapping ----
  const start = { x: init.you.x, y: init.you.y };

  // reach x = 0 by walking left
  for (let i = 0; i < start.x; i++) alice.send({ type: 'move', dx: -1, dy: 0 });
  if (start.x > 0) {
    await alice.waitFor((m) => m.type === 'pos' && m.id === init.id && m.x === 0);
  }

  // one step left off the edge wraps to WIDTH-1
  alice.clear();
  alice.send({ type: 'move', dx: -1, dy: 0 });
  let pos = await alice.waitFor((m) => m.type === 'pos' && m.id === init.id);
  assert.equal(pos.x, WIDTH - 1, 'x wraps around the left edge');

  // step right goes back to 0
  alice.clear();
  alice.send({ type: 'move', dx: 1, dy: 0 });
  pos = await alice.waitFor((m) => m.type === 'pos' && m.id === init.id);
  assert.equal(pos.x, 0, 'x moves right');

  // reach y = 0 by walking up
  for (let i = 0; i < start.y; i++) alice.send({ type: 'move', dx: 0, dy: -1 });
  if (start.y > 0) {
    await alice.waitFor((m) => m.type === 'pos' && m.id === init.id && m.y === 0);
  }

  // one step up off the edge wraps to HEIGHT-1
  alice.clear();
  alice.send({ type: 'move', dx: 0, dy: -1 });
  pos = await alice.waitFor((m) => m.type === 'pos' && m.id === init.id);
  assert.equal(pos.y, HEIGHT - 1, 'y wraps around the top edge');

  // step down goes back to 0 — we are now at (0, 0)
  alice.clear();
  alice.send({ type: 'move', dx: 0, dy: 1 });
  pos = await alice.waitFor((m) => m.type === 'pos' && m.id === init.id);
  assert.equal(pos.y, 0, 'y moves down');

  // ---- painting cycles through the palette and is broadcast ----
  alice.send({ type: 'paint' });
  let tile = await bob.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0);
  assert.equal(tile.color, 1, 'white -> red');

  alice.send({ type: 'paint' });
  tile = await bob.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0 && m.color === 2);
  assert.equal(tile.color, 2, 'red -> green');

  // cycle all the way back to white
  for (let i = 0; i < 10; i++) alice.send({ type: 'paint' });
  await alice.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0 && m.color === 0);

  // ---- a late joiner sees the same (unpainted) tile via RLE ----
  const carol = createClient(base);
  await carol.open;
  const init2 = await carol.waitFor((m) => m.type === 'init');
  const tiles2 = decodeRLE(init2.rle, WIDTH * HEIGHT);
  assert.equal(tiles2[0], 0, 'tile at (0,0) is white again');

  // ---- disconnect announces a leave ----
  bob.ws.close();
  await alice.waitFor((m) => m.type === 'leave');

  alice.ws.close();
  carol.ws.close();
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));

  console.log('✓ all world tests passed');
}

main().catch((err) => {
  console.error('✗ world test failed:', err);
  process.exit(1);
});
