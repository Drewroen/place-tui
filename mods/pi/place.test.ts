/**
 * Tests for the in-UI place extension.
 *
 *   node --test mods/pi/place.test.ts
 *
 * The rules here are the ones the Rust client (`place/src/main.rs`) already
 * implements — prediction, the paint queue, the picker layout, the key map — so
 * a change that drifts from the client fails a test rather than the game.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MOVES_IN_FLIGHT,
  PICKER_BLOCK_WIDTH,
  applyFrame,
  confirmPicker,
  decodeKey,
  drainQueuedPaint,
  handleKey,
  movePicker,
  newState,
  normalizeUrl,
  openPicker,
  parseSize,
  pickerBorder,
  pickerFill,
  readConfig,
  reconcile,
  renderFrame,
  sendMove,
  sendPaint,
  statusLine,
  tileAt,
  type GameState,
} from "./place.ts";

const PALETTE = [
  { name: "black", fg: 30 },
  { name: "red", fg: 31 },
  { name: "blue", fg: 34 },
  { name: "white", fg: 37 },
];

/** A state that has just received `init` with a 4x4 map in one colour. */
function started(overrides: Record<string, unknown> = {}): GameState {
  const state = newState();
  applyFrame(
    state,
    JSON.stringify({
      type: "init",
      width: 4,
      height: 4,
      id: 7,
      palette: PALETTE,
      rle: [1, 16],
      you: { x: 1, y: 1 },
      players: [],
      viewers: 2,
      ...overrides,
    }),
  );
  return state;
}

/* ------------------------------------------------------------------ config -- */

test("the server defaults to the public one and honours PLACE_MOD_SERVER", () => {
  assert.equal(readConfig({}).server, "wss://place-tui.fly.dev");
  assert.equal(readConfig({ PLACE_SERVER: "ws://localhost:8090" }).server, "ws://localhost:8090");
  assert.equal(
    readConfig({ PLACE_MOD_SERVER: "ws://localhost:9000", PLACE_SERVER: "ws://other" }).server,
    "ws://localhost:9000",
  );
  assert.equal(readConfig({ PLACE_MOD_KEEP: "1" }).keep, true);
  assert.equal(readConfig({}).keep, false);
});

test("the game takes a share of the screen, 80% by default", () => {
  assert.equal(readConfig({}).size, "80%");
  assert.equal(readConfig({ PLACE_MOD_SIZE: "50%" }).size, "50%");
  assert.equal(readConfig({ PLACE_MOD_SIZE: "junk" }).size, "80%", "junk falls back");

  assert.equal(parseSize("80%"), 0.8);
  assert.equal(parseSize("60"), 0.6);
  assert.equal(parseSize(0.5), 0.5);
  assert.equal(parseSize("0"), null);
  assert.equal(parseSize("nope"), null);
  assert.equal(parseSize(undefined), null);
});

test("http(s) servers become ws(s) and get a path", () => {
  assert.deepEqual(
    [
      normalizeUrl("https://place-tui.fly.dev"),
      normalizeUrl("http://localhost:8090"),
      normalizeUrl("wss://place-tui.fly.dev/"),
      normalizeUrl("ws://localhost:8090/room"),
    ],
    [
      "wss://place-tui.fly.dev/",
      "ws://localhost:8090/",
      "wss://place-tui.fly.dev/",
      "ws://localhost:8090/room",
    ],
  );
});

/* ------------------------------------------------------------------- init -- */

test("init fills the map from the run-length encoding, and reads you and the others", () => {
  const state = started({ rle: [0, 8, 2, 8], players: [{ id: 9, x: 3, y: 0 }] });

  assert.equal(state.ready, true);
  assert.equal(state.width, 4);
  assert.equal(state.id, 7);
  assert.equal(tileAt(state, 0, 1), 0);
  assert.equal(tileAt(state, 3, 3), 2, "the second run covers the bottom half");
  assert.deepEqual({ x: state.x, y: state.y }, { x: 1, y: 1 });
  assert.deepEqual([...state.players.keys()], [9], "other players arrive in init");
  assert.equal(state.viewers, 2);
});

test("init survives junk and a ragged encoding", () => {
  const state = newState();
  applyFrame(state, "not json");
  applyFrame(state, JSON.stringify({ type: "init", width: 2, height: 2, rle: [1, 1, "x"] }));
  assert.equal(state.ready, true);
  assert.equal(state.tiles.length, 4);
  assert.equal(tileAt(state, 0, 1), 0, "the ragged tail leaves the rest at zero");
});

/* ------------------------------------------------------------------ frames -- */

test("tile, join, pos, leave and viewers update the picture", () => {
  const state = started();

  applyFrame(state, JSON.stringify({ type: "tile", x: 2, y: 2, color: 3 }));
  assert.equal(tileAt(state, 2, 2), 3);

  applyFrame(state, JSON.stringify({ type: "join", id: 11, x: 0, y: 0 }));
  assert.deepEqual(state.players.get(11), { x: 0, y: 0 });

  applyFrame(state, JSON.stringify({ type: "pos", id: 11, x: 3, y: 3 }));
  assert.deepEqual(state.players.get(11), { x: 3, y: 3 });

  applyFrame(state, JSON.stringify({ type: "leave", id: 11 }));
  assert.equal(state.players.has(11), false);

  applyFrame(state, JSON.stringify({ type: "viewers", count: 12 }));
  assert.equal(state.viewers, 12);
});

test("our own pos acknowledges a move and replays the rest", () => {
  const state = started();
  sendMove(state, 1, 0);
  sendMove(state, 1, 0);
  assert.deepEqual({ x: state.x, y: state.y }, { x: 3, y: 1 }, "moves are predicted");

  // The server says it applied the first move only.
  applyFrame(state, JSON.stringify({ type: "pos", id: 7, x: 2, y: 1 }));
  assert.deepEqual({ x: state.x, y: state.y }, { x: 3, y: 1 });
  assert.equal(state.pendingMoves.length, 1);
});

test("a dropped move is undone by the reply that follows it", () => {
  const state = started();
  sendMove(state, 0, 1);
  sendMove(state, 1, 0);
  // The server dropped the first move and stayed put.
  applyFrame(state, JSON.stringify({ type: "pos", id: 7, x: 1, y: 1 }));
  assert.deepEqual({ x: state.x, y: state.y }, { x: 2, y: 1 });
});

test("predicted moves wrap at the edge", () => {
  const state = started({ you: { x: 0, y: 0 } });
  sendMove(state, -1, -1);
  assert.deepEqual({ x: state.x, y: state.y }, { x: 3, y: 3 });
});

test("an error frame replaces the status line", () => {
  const state = started();
  applyFrame(state, JSON.stringify({ type: "error", text: "too fast" }));
  assert.equal(state.status, "error: too fast");
});

/* ------------------------------------------------------------------- moves -- */

test("moves are capped at MAX_MOVES_IN_FLIGHT until the server answers", () => {
  const state = started();
  for (let i = 0; i < MAX_MOVES_IN_FLIGHT; i += 1) {
    assert.ok(sendMove(state, 1, 0), `move ${i} is sent`);
  }
  assert.equal(sendMove(state, 1, 0), null, "the ninth move waits for a reply");

  applyFrame(state, JSON.stringify({ type: "pos", id: 7, x: 2, y: 1 }));
  assert.ok(sendMove(state, 1, 0), "an ack frees a slot");
});

test("a chosen brush rides along on every move", () => {
  const state = started();
  state.brush = 2;
  assert.deepEqual(sendMove(state, 1, 0), { type: "move", dx: 1, dy: 0, color: 2 });
});

/* ------------------------------------------------------------------- paint -- */

test("paint waits for moves in flight, then fires once", () => {
  const state = started();
  state.brush = 3;

  // Nothing in flight: the paint goes straight out.
  assert.deepEqual(sendPaint(state), { type: "paint", x: 1, y: 1, color: 3 });

  // A move the server has not acked leaves our position unsettled.
  state.pendingMoves.push([1, 0]);
  assert.equal(sendPaint(state), null);
  assert.equal(state.paintQueued, true, "the paint is queued behind the move");
  assert.equal(drainQueuedPaint(state), null, "and stays queued while the move is pending");

  state.pendingMoves.length = 0;
  assert.deepEqual(drainQueuedPaint(state), { type: "paint", x: state.x, y: state.y, color: 3 });
  assert.equal(state.paintQueued, false);
});

test("painting a tile that already has the brush colour sends nothing", () => {
  const state = started({ rle: [2, 16] });
  state.brush = 2;
  assert.equal(sendPaint(state), null);
});

test("no brush, no paint", () => {
  const state = started();
  assert.equal(sendPaint(state), null);
});

/* ------------------------------------------------------------------ picker -- */

test("the picker opens on the brush, or on the tile underfoot", () => {
  const state = started({ rle: [2, 16] });
  openPicker(state);
  assert.equal(state.picker, 2, "underfoot is colour 2");

  state.brush = 3;
  openPicker(state);
  assert.equal(state.picker, 3, "a brush wins over the tile");
});

test("picker left/right wrap around the palette", () => {
  const state = started();
  state.picker = 0;
  movePicker(state, 1, 0);
  assert.equal(state.picker, 1);
  movePicker(state, -1, 0);
  assert.equal(state.picker, 0);
  movePicker(state, -1, 0);
  assert.equal(state.picker, 3, "left from the first colour wraps");
  movePicker(state, 1, 0);
  assert.equal(state.picker, 0, "right from the last colour wraps");
});

test("picker up/down moves by a row of blocks and stops at the end", () => {
  const state = started();
  state.termCols = 80; // four columns, so twelve colours would be one row per four
  state.palette = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, fg: 30 + (i % 8) }));
  state.picker = 0;
  movePicker(state, 0, 1);
  assert.equal(state.picker, 4, "down a row is down four blocks");
  movePicker(state, 0, -1);
  assert.equal(state.picker, 0);
  movePicker(state, 0, -1);
  assert.equal(state.picker, 0, "up from the top row stays put");

  state.picker = 8;
  movePicker(state, 0, 1);
  assert.equal(state.picker, 8, "down from the last row stays put");
});

test("the selected block is framed by its border, in the gap around it", () => {
  assert.equal(pickerBorder(0, 4, 0, 0), "┏");
  assert.equal(pickerBorder(0, 4, 3, 0), "━");
  assert.equal(pickerBorder(0, 4, 7, 0), "┓");
  assert.equal(pickerBorder(0, 4, 0, 2), "┃");
  assert.equal(pickerBorder(0, 4, 7, 2), "┃");
  assert.equal(pickerBorder(0, 4, 0, 4), "┗");
  assert.equal(pickerBorder(0, 4, 7, 4), "┛");
  assert.equal(pickerBorder(0, 4, 3, 2), null, "the swatch itself is untouched");
  assert.equal(pickerBorder(0, 4, 8, 2), null, "nothing outside the square");
  assert.equal(pickerBorder(1, 4, 8, 5), null, "only the selected block is framed");
});

test("the blocks cover the palette indexes and nothing else", () => {
  assert.equal(pickerFill(12, 4, 1, 1), 0);
  assert.equal(pickerFill(12, 4, 6, 3), 0, "a block is six cells wide and three tall");
  assert.equal(pickerFill(12, 4, 7, 1), null, "the column gap");
  assert.equal(pickerFill(12, 4, 8, 1), 1);
  assert.equal(pickerFill(12, 4, 22, 9), 11);
  assert.equal(pickerFill(12, 4, 28, 9), null, "the right padding");
  assert.equal(pickerFill(4, 4, 29, 1), null, "past the last column");
});

test("confirming the picker sets the brush and paints where you stand", () => {
  const state = started({ rle: [0, 16] });
  openPicker(state);
  movePicker(state, 1, 0);
  const paint = confirmPicker(state);
  assert.equal(state.brush, 1);
  assert.equal(state.picker, null);
  assert.deepEqual(paint, { type: "paint", x: 1, y: 1, color: 1 });
});

/* -------------------------------------------------------------------- keys -- */

test("the key map covers arrows, wasd, hjkl and the control keys", () => {
  assert.equal(decodeKey("\u001b[A"), "up");
  assert.equal(decodeKey("\u001bOB"), "down");
  assert.equal(decodeKey("\u001b[D"), "left");
  assert.equal(decodeKey("\u001b[C"), "right");
  assert.equal(decodeKey("w"), "up");
  assert.equal(decodeKey("a"), "left");
  assert.equal(decodeKey("s"), "down");
  assert.equal(decodeKey("d"), "right");
  assert.equal(decodeKey("k"), "up");
  assert.equal(decodeKey(" "), "space");
  assert.equal(decodeKey("\r"), "enter");
  assert.equal(decodeKey("q"), "esc");
  assert.equal(decodeKey("\u0003"), "ctrl-c");
  assert.equal(decodeKey("z"), null);
});

test("the Kitty keyboard encodings decode the same way", () => {
  // Pi turns the keyboard protocol on in terminals that support it, and then
  // every key arrives as ESC [ codepoint (; modifiers) u.
  assert.equal(decodeKey("\u001b[27u"), "esc", "escape");
  assert.equal(decodeKey("\u001b[27;1u"), "esc", "escape with explicit modifiers");
  assert.equal(decodeKey("\u001b[13u"), "enter");
  assert.equal(decodeKey("\u001b[32u"), "space");
  assert.equal(decodeKey("\u001b[119u"), "up", "letters arrive as codepoints, and w walks up");
  assert.equal(decodeKey("\u001b[113u"), "esc", "q leaves");
  assert.equal(decodeKey("\u001b[99;5u"), "ctrl-c", "ctrl+c");
  assert.equal(decodeKey("\u001b[3;5u"), "ctrl-c", "…or the control character itself");
  assert.equal(decodeKey("\u001b[108;5u"), null, "ctrl+something else is not ours");

  // Arrows with parameters, which the protocol also allows.
  assert.equal(decodeKey("\u001b[1;1A"), "up");
  assert.equal(decodeKey("\u001b[1;1B"), "down");
  assert.equal(decodeKey("\u001b[1;1C"), "right");
  assert.equal(decodeKey("\u001b[1;1D"), "left");
});

test("escape closes the picker first and only then quits", () => {
  const state = started();
  openPicker(state);
  assert.deepEqual(handleKey(state, "esc"), { messages: [], quit: false });
  assert.equal(state.picker, null);

  assert.deepEqual(handleKey(state, "esc"), { messages: [], quit: true });
});

test("a move key sends one move, and while the picker is open it moves the highlight", () => {
  const state = started();
  const move = handleKey(state, "right");
  assert.deepEqual(move.messages, [{ type: "move", dx: 1, dy: 0 }]);
  assert.equal(move.quit, false);

  openPicker(state);
  const before = state.picker;
  const whilePicking = handleKey(state, "right");
  assert.deepEqual(whilePicking.messages, [], "no move while picking a colour");
  assert.notEqual(state.picker, before);
});

test("space opens the picker, enter confirms it, ctrl-c quits", () => {
  const state = started();
  handleKey(state, "space");
  assert.notEqual(state.picker, null);
  handleKey(state, "enter");
  assert.equal(state.picker, null);
  assert.equal(state.brush, 1, "the highlight starts on the tile underfoot");
  assert.deepEqual(handleKey(state, "ctrl-c"), { messages: [], quit: true });
});

/* ------------------------------------------------------------------ render -- */

test("a frame has one line per row, with the status bar last", () => {
  const state = started();
  const lines = renderFrame(state, 60, 6);
  assert.equal(lines.length, 6);
  assert.match(lines[5], /\u001b\[7m/);
  assert.match(lines[5], /place {2}\(1, 1\)/, "the bar reports where you stand");
  assert.match(lines[5], /tile: red/);
  assert.match(lines[5], /brush: none/);
  assert.match(lines[5], /players: 1/);
});

test("you are a bold dot in the middle of the view", () => {
  const state = started();
  const lines = renderFrame(state, 9, 5);
  assert.match(lines[2], /\u001b\[1;97m●/, "self is a bold white dot");
  assert.equal(
    lines[2].replace(/\u001b\[[0-9;]*m/g, "").indexOf("●"),
    4,
    "…in the middle column",
  );
});

test("other players are green dots, dark on white tiles", () => {
  const state = started({ players: [{ id: 9, x: 2, y: 1 }] });
  const lines = renderFrame(state, 9, 5);
  assert.match(lines[2], /1;92m●/);

  state.palette[1] = { name: "white", fg: 37 };
  state.tiles.fill(1);
  const white = renderFrame(state, 9, 5);
  assert.match(white[2], /1;32m●/, "green goes dark on a white tile");
  assert.match(white[2], /1;30m●/, "so does white");
});

test("the status bar keeps the brush name and pads to the width", () => {
  const state = started();
  state.brush = 2;
  const bar = statusLine(state, 40);
  assert.match(bar, /brush: blue/);
  assert.equal(bar.replace(/\u001b\[[0-9;]*m/g, "").length, 40);
});

test("before init, the frame is the connecting line and blank rows", () => {
  const state = newState("Connecting to ws://localhost:8090 …");
  const lines = renderFrame(state, 60, 4);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /Connecting to ws:\/\/localhost:8090/);
  assert.equal(lines[1], "");
});

test("the picker draws itself over the map when open", () => {
  const state = started();
  state.palette = Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, fg: 31 + (i % 6) }));
  openPicker(state);
  const lines = renderFrame(state, 40, 16);
  const frame = lines.join("\n");
  assert.match(frame, /┏/, "the selected block is framed");
  assert.match(frame, /enter select/, "the help line is there");
  assert.match(frame, /31m█/, "a swatch is painted in its colour");
});
