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
const WIDTH = 1024;
const HEIGHT = 1024;

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

async function startServer(port, extraEnv = {}) {
  const proc = spawn(process.execPath, [serverPath, String(port)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 5000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('World server')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return proc;
}

async function main() {
  const server = await startServer(PORT, {
    // The test drives the protocol directly and needs the limiter out of the
    // way; the rate limits get their own dedicated servers further down.
    MAX_MOVES_PER_SEC: '100000',
    MAX_PAINTS_PER_SEC: '100000',
    MAX_MESSAGES_PER_SEC: '100000',
    MAX_REJECTIONS_PER_SEC: '100000',
    PAINT_COOLDOWN_MS: '0',
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
  alice.send({ type: 'paint', x: 0, y: 0 });
  let tile = await bob.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0);
  assert.equal(tile.color, 1, 'white -> red');

  alice.send({ type: 'paint', x: 0, y: 0 });
  tile = await bob.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0 && m.color === 2);
  assert.equal(tile.color, 2, 'red -> green');

  // cycle all the way back to white
  for (let i = 0; i < 10; i++) alice.send({ type: 'paint', x: 0, y: 0 });
  await alice.waitFor((m) => m.type === 'tile' && m.x === 0 && m.y === 0 && m.color === 0);

  // ---- paint coordinates must match where the server has you standing ----
  alice.clear();
  bob.clear();
  alice.send({ type: 'paint', x: 500, y: 500 });
  const wrongTile = await alice.waitFor((m) => m.type === 'error');
  assert.match(wrongTile.text, /stand/i, 'rejects a paint aimed somewhere else');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    !bob.messages.some((m) => m.type === 'tile' && m.x === 500 && m.y === 500),
    'a rejected paint changes no tile',
  );

  // ---- a late joiner sees the same (unpainted) tile via RLE ----
  const carol = createClient(base);
  await carol.open;
  const init2 = await carol.waitFor((m) => m.type === 'init');
  const tiles2 = decodeRLE(init2.rle, WIDTH * HEIGHT);
  assert.equal(tiles2[0], 0, 'tile at (0,0) is white again');

  // ---- viewers watch without joining as players ----
  alice.clear();
  const dave = createClient(`${base}/?viewer`);
  await dave.open;
  const daveInit = await dave.waitFor((m) => m.type === 'init');
  assert.ok(!('you' in daveInit), 'viewer init has no spawn point');
  assert.equal(daveInit.viewers, 1, 'viewer init reports one viewer');
  assert.ok(
    !daveInit.players.some((p) => p.id === daveInit.id),
    'viewer is not in the player list',
  );

  // players are told the viewer count changed, but no join is announced
  const vc = await alice.waitFor((m) => m.type === 'viewers' && m.count === 1);
  assert.equal(vc.count, 1);
  assert.ok(
    !alice.messages.some((m) => m.type === 'join' && m.id === daveInit.id),
    'viewers do not announce a join',
  );

  // viewer input is ignored — nothing is broadcast
  alice.clear();
  dave.send({ type: 'move', dx: 1, dy: 0 });
  dave.send({ type: 'paint', x: 0, y: 0 });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(
    !alice.messages.some((m) => m.type === 'pos' || m.type === 'tile'),
    'viewer moves and paints are ignored',
  );

  // a viewer leaving updates the count but announces no leave
  alice.clear();
  dave.ws.close();
  await alice.waitFor((m) => m.type === 'viewers' && m.count === 0);
  assert.ok(
    !alice.messages.some((m) => m.type === 'leave' && m.id === daveInit.id),
    'viewers do not announce a leave',
  );

  // ---- disconnect announces a leave ----
  bob.ws.close();
  await alice.waitFor((m) => m.type === 'leave');

  alice.ws.close();
  carol.ws.close();
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));

  // ---- rate limiting: separate budgets, every move acked, paints throttled ----
  const PORT_LIMITED = PORT + 1;
  const limited = await startServer(PORT_LIMITED, {
    MAX_MOVES_PER_SEC: '5',
    MAX_PAINTS_PER_SEC: '2',
    MAX_MESSAGES_PER_SEC: '100000',
    MAX_REJECTIONS_PER_SEC: '100000', // don't kick here; just observe throttling
    PAINT_COOLDOWN_MS: '0',
  });

  const lim = createClient(`ws://127.0.0.1:${PORT_LIMITED}`);
  await lim.open;
  const limInit = await lim.waitFor((m) => m.type === 'init');

  // A held movement key sends more moves than the budget allows. The extras are
  // dropped, but every move still gets exactly one `pos` reply so a client can
  // tell when its position has settled (and so it can paint from it).
  for (let i = 0; i < 50; i++) lim.send({ type: 'move', dx: 1, dy: 0 });
  await new Promise((r) => setTimeout(r, 250));
  const acks = lim.messages.filter((m) => m.type === 'pos' && m.id === limInit.id);
  assert.equal(acks.length, 50, `every move is acknowledged (got ${acks.length})`);
  const moved = (acks.at(-1).x - limInit.you.x + WIDTH) % WIDTH;
  assert.ok(moved < 50, `excess moves were dropped (moved ${moved} of 50)`);

  // Paints past the budget are throttled before they reach everyone.
  const settled = acks.at(-1);
  lim.clear();
  for (let i = 0; i < 20; i++) lim.send({ type: 'paint', x: settled.x, y: settled.y });
  await new Promise((r) => setTimeout(r, 250));
  const tilesPainted = lim.messages.filter((m) => m.type === 'tile').length;
  assert.ok(tilesPainted >= 1 && tilesPainted <= 3, `paints are throttled (got ${tilesPainted})`);
  lim.ws.close();
  limited.kill('SIGTERM');
  await new Promise((r) => limited.once('exit', r));

  // ---- sustained flooding closes the socket with 1008 ----
  const PORT_FLOOD = PORT + 2;
  const floodServer = await startServer(PORT_FLOOD, {
    MAX_MOVES_PER_SEC: '1',
    MAX_MESSAGES_PER_SEC: '100000',
    MAX_REJECTIONS_PER_SEC: '10',
  });
  const flooder = createClient(`ws://127.0.0.1:${PORT_FLOOD}`);
  await flooder.open;
  await flooder.waitFor((m) => m.type === 'init');
  const closed = new Promise((resolve) => {
    flooder.ws.addEventListener('close', (e) => resolve(e.code), { once: true });
  });
  for (let i = 0; i < 200; i++) flooder.send({ type: 'move', dx: 1, dy: 0 });
  assert.equal(await closed, 1008, 'a flood is closed with 1008');
  floodServer.kill('SIGTERM');
  await new Promise((r) => floodServer.once('exit', r));

  console.log('✓ all world tests passed');
}

main().catch((err) => {
  console.error('✗ world test failed:', err);
  process.exit(1);
});
