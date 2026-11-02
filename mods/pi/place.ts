/**
 * place — a Pi extension that draws the shared map inside Pi's own UI.
 *
 * `place` is a Rust TUI binary, and an extension cannot host another program's
 * terminal: there is no pty to hand it. So this draws the game itself, from the
 * same WebSocket protocol, with Pi's component API. Same viewport, same colours,
 * same keys, same colour picker, same status bar — mirrored from
 * `place/src/main.rs`, whose rules the tests pin down so the two cannot drift.
 *
 * A prompt opens the game, and Pi's answer closes it. `place` toggles it by hand
 * and works mid-run. No tmux, no child process, no dependency.
 *
 * Settings, all optional, read from Pi's environment:
 *   PLACE_MOD_SERVER   server to connect to   (default: wss://place-tui.fly.dev)
 *   PLACE_MOD_KEEP     "1" leaves the game open when the run settles
 *
 * Install: copy this file to ~/.pi/agent/extensions/, `pi install
 * git:github.com/Drewroen/place-tui`, or run Pi with `pi -e mods/pi/place.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ config -- */

export const DEFAULT_SERVER = "wss://place-tui.fly.dev";

export interface Config {
  server: string;
  /** Leave the game open when the run settles. */
  keep: boolean;
  /**
   * Share of the screen the game takes, as a percentage (`"80%"`). The rest of
   * the page stays visible around it.
   */
  size: string;
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    server: env.PLACE_MOD_SERVER || env.PLACE_SERVER || DEFAULT_SERVER,
    keep: env.PLACE_MOD_KEEP === "1",
    size: parseSize(env.PLACE_MOD_SIZE) === null ? "80%" : env.PLACE_MOD_SIZE!.trim(),
  };
}

/** `"80%"`, `"80"` and `80` all read as 0.8; anything else as null. */
export function parseSize(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/%$/, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.min(1, percent > 1 ? percent / 100 : percent);
}

/** `http(s)://` becomes `ws(s)://`, and a bare host gets a `/` path, as the client does. */
export function normalizeUrl(server: string): string {
  let url = server.trim();
  if (url.startsWith("https://")) url = `wss://${url.slice("https://".length)}`;
  else if (url.startsWith("http://")) url = `ws://${url.slice("http://".length)}`;
  const at = url.indexOf("://");
  if (at < 0) return url;
  return url.slice(at + 3).includes("/") ? url : `${url}/`;
}

/* ------------------------------------------------------------------- state -- */

export interface PaletteColor {
  name: string;
  fg: number;
}

export interface Player {
  x: number;
  y: number;
}

export interface GameState {
  ready: boolean;
  width: number;
  height: number;
  palette: PaletteColor[];
  tiles: Uint8Array;
  id: number;
  x: number;
  y: number;
  players: Map<number, Player>;
  viewers: number;
  status: string;
  /** Moves sent but not yet acknowledged, replayed on top of every `pos` reply. */
  pendingMoves: Array<[number, number]>;
  /** Space was pressed with moves in flight; paint once they settle. */
  paintQueued: boolean;
  /** The colour every tile walked onto is painted with. */
  brush: number | null;
  /** Highlighted palette index while the picker is open. */
  picker: number | null;
  /** Width of the last frame drawn; the picker lays itself out to fit. */
  termCols: number;
}

/** `MAX_MOVES_IN_FLIGHT`: bounds the flood a held key can send. */
export const MAX_MOVES_IN_FLIGHT = 8;

export function newState(status = ""): GameState {
  return {
    ready: false,
    width: 0,
    height: 0,
    palette: [],
    tiles: new Uint8Array(0),
    id: 0,
    x: 0,
    y: 0,
    players: new Map(),
    viewers: 0,
    status,
    pendingMoves: [],
    paintQueued: false,
    brush: null,
    picker: null,
    termCols: 80,
  };
}

const wrap = (value: number, size: number) => ((value % size) + size) % size;

export function indexOf(state: GameState, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  return y * state.width + x;
}

export function tileAt(state: GameState, x: number, y: number): number | null {
  const at = indexOf(state, x, y);
  return at === null ? null : (state.tiles[at] ?? null);
}

/** Adopt the server's position, then replay the moves it has not seen yet. */
export function reconcile(state: GameState, serverX: number, serverY: number): void {
  let x = serverX;
  let y = serverY;
  for (const [dx, dy] of state.pendingMoves) {
    x = wrap(x + dx, state.width);
    y = wrap(y + dy, state.height);
  }
  state.x = x;
  state.y = y;
}

type Json = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Apply one server frame. Unknown types and junk are ignored, as in the client. */
export function applyFrame(state: GameState, text: string): void {
  let frame: Json;
  try {
    frame = JSON.parse(text) as Json;
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object") return;

  switch (frame.type) {
    case "init":
      applyInit(state, frame);
      return;
    case "tile": {
      const at = indexOf(state, num(frame.x, -1), num(frame.y, -1));
      if (at !== null) state.tiles[at] = num(frame.color) & 0xff;
      return;
    }
    case "pos": {
      const id = num(frame.id);
      if (id === state.id) {
        state.pendingMoves.shift();
        reconcile(state, num(frame.x), num(frame.y));
      } else {
        const player = state.players.get(id);
        if (player) {
          player.x = num(frame.x);
          player.y = num(frame.y);
        }
      }
      return;
    }
    case "join": {
      const id = num(frame.id);
      if (id !== state.id) state.players.set(id, { x: num(frame.x), y: num(frame.y) });
      return;
    }
    case "leave":
      state.players.delete(num(frame.id));
      return;
    case "viewers":
      state.viewers = num(frame.count);
      return;
    case "error":
      state.status = `error: ${typeof frame.text === "string" ? frame.text : ""}`;
      return;
    default:
      return;
  }
}

function applyInit(state: GameState, frame: Json): void {
  state.width = num(frame.width);
  state.height = num(frame.height);
  state.id = num(frame.id);

  state.palette = Array.isArray(frame.palette)
    ? (frame.palette as unknown[]).map((entry) => {
        const colour = (entry ?? {}) as Json;
        return {
          name: typeof colour.name === "string" ? colour.name : "?",
          fg: num(colour.fg, 37),
        };
      })
    : [];

  const cells = Math.max(0, state.width) * Math.max(0, state.height);
  const tiles = new Uint8Array(cells);
  if (Array.isArray(frame.rle)) {
    let at = 0;
    for (let i = 0; i + 1 < frame.rle.length; i += 2) {
      const colour = num(frame.rle[i]) & 0xff;
      const count = num(frame.rle[i + 1]);
      for (let n = 0; n < count && at < cells; n += 1) tiles[at++] = colour;
    }
  }
  state.tiles = tiles;

  const you = (frame.you ?? {}) as Json;
  state.x = num(you.x);
  state.y = num(you.y);

  state.players = new Map();
  if (Array.isArray(frame.players)) {
    for (const entry of frame.players as unknown[]) {
      const player = (entry ?? {}) as Json;
      const id = num(player.id);
      if (id === state.id) continue;
      state.players.set(id, { x: num(player.x), y: num(player.y) });
    }
  }

  state.viewers = num(frame.viewers);
  state.ready = true;
  state.pendingMoves = [];
  state.paintQueued = false;
  if (state.picker !== null && state.picker >= state.palette.length) {
    state.picker = state.palette.length === 0 ? null : state.palette.length - 1;
  }
  if (state.brush !== null && state.brush >= state.palette.length) state.brush = null;
}

/* ------------------------------------------------------------------- input -- */

export interface MoveMessage {
  type: "move";
  dx: number;
  dy: number;
  color?: number;
}

export interface PaintMessage {
  type: "paint";
  x: number;
  y: number;
  color: number;
}

export type ClientMessage = MoveMessage | PaintMessage;

/** Move, predicting the step locally and queueing it until `pos` confirms it. */
export function sendMove(state: GameState, dx: number, dy: number): ClientMessage | null {
  if (!state.ready || state.pendingMoves.length >= MAX_MOVES_IN_FLIGHT) return null;
  state.x = wrap(state.x + dx, state.width);
  state.y = wrap(state.y + dy, state.height);
  state.pendingMoves.push([dx, dy]);
  // A chosen brush rides along on the move, so the server paints where we land.
  return state.brush === null
    ? { type: "move", dx, dy }
    : { type: "move", dx, dy, color: state.brush };
}

/**
 * Paint the tile underfoot. While moves are in flight our position is not
 * settled, so the paint waits for them: the server only paints the tile it
 * believes we are standing on.
 */
export function sendPaint(state: GameState): ClientMessage | null {
  if (!state.ready || state.brush === null) return null;
  if (state.pendingMoves.length > 0) {
    state.paintQueued = true;
    return null;
  }
  state.paintQueued = false;
  if (tileAt(state, state.x, state.y) === state.brush) return null;
  return { type: "paint", x: state.x, y: state.y, color: state.brush };
}

/** The paint a settled move queue owed us, if any. */
export function drainQueuedPaint(state: GameState): ClientMessage | null {
  if (!state.paintQueued || state.pendingMoves.length > 0) return null;
  return sendPaint(state);
}

/** Open the picker on the current brush, or on the tile underfoot. */
export function openPicker(state: GameState): void {
  if (state.palette.length === 0) return;
  const selected = Math.min(state.brush ?? tileAt(state, state.x, state.y) ?? 0, state.palette.length - 1);
  state.picker = selected;
}

export function closePicker(state: GameState): void {
  state.picker = null;
}

/** Move the picker highlight around its grid; left/right wrap, down stops at the end. */
export function movePicker(state: GameState, dx: number, dy: number): void {
  if (state.picker === null) return;
  const count = state.palette.length;
  if (count === 0) return;
  const columns = pickerColumns(count, state.termCols);
  let next = state.picker;
  if (dx < 0) next = (state.picker + count - 1) % count;
  else if (dx > 0) next = (state.picker + 1) % count;
  else if (dy < 0) next = Math.max(0, state.picker - columns);
  else if (dy > 0 && state.picker + columns < count) next = state.picker + columns;
  state.picker = Math.min(next, count - 1);
}

/** Choose the highlighted colour: it becomes the brush and paints where we stand. */
export function confirmPicker(state: GameState): ClientMessage | null {
  if (state.picker === null || state.palette.length === 0) return null;
  const brush = Math.min(state.picker, state.palette.length - 1);
  state.picker = null;
  state.brush = brush;
  return sendPaint(state);
}

export type DecodedKey = "up" | "down" | "left" | "right" | "space" | "enter" | "esc" | "ctrl-c";

/** The client's key handling, arrows also spelled `wasd` and `hjkl`. */
export function decodeKey(data: string): DecodedKey | null {
  switch (data) {
    case "\u001b[A":
    case "\u001bOA":
    case "w":
    case "k":
      return "up";
    case "\u001b[B":
    case "\u001bOB":
    case "s":
    case "j":
      return "down";
    case "\u001b[D":
    case "\u001bOD":
    case "a":
    case "h":
      return "left";
    case "\u001b[C":
    case "\u001bOC":
    case "d":
    case "l":
      return "right";
    case " ":
      return "space";
    case "\r":
    case "\n":
      return "enter";
    case "\u001b":
    case "q":
      return "esc";
    case "\u0003":
      return "ctrl-c";
    default:
      return null;
  }
}

export interface KeyResult {
  messages: ClientMessage[];
  /** Leave the game. */
  quit: boolean;
}

/** One keystroke, exactly as the client's match on a key press handles it. */
export function handleKey(state: GameState, key: DecodedKey): KeyResult {
  const messages: ClientMessage[] = [];

  if (key === "ctrl-c") return { messages, quit: true };

  if (key === "esc") {
    if (state.picker !== null) closePicker(state);
    else return { messages, quit: true };
    return { messages, quit: false };
  }

  if (key === "enter") {
    const paint = confirmPicker(state);
    if (paint) messages.push(paint);
    return { messages, quit: false };
  }

  if (key === "space") {
    if (state.picker === null) openPicker(state);
    return { messages, quit: false };
  }

  const step: Record<string, [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };
  const delta = step[key];
  if (!delta) return { messages, quit: false };

  if (state.picker !== null) {
    movePicker(state, delta[0], delta[1]);
    return { messages, quit: false };
  }
  const move = sendMove(state, delta[0], delta[1]);
  if (move) messages.push(move);
  return { messages, quit: false };
}

/* ------------------------------------------------------------------ render -- */

export const PICKER_BLOCK_WIDTH = 6;
export const PICKER_BLOCK_HEIGHT = 3;
export const PICKER_GAP = 1;
export const PICKER_PADDING = 1;
export const PICKER_MAX_COLUMNS = 4;

/** A cell of the picture: one glyph with one SGR prefix. */
interface Cell {
  ch: string;
  sgr: string;
}

export function pickerPanelWidth(columns: number): number {
  return columns * PICKER_BLOCK_WIDTH + Math.max(0, columns - 1) * PICKER_GAP + PICKER_PADDING * 2;
}

/** Lay the picker out in as many columns of colour blocks as fit. */
export function pickerColumns(count: number, termCols: number): number {
  const maxByWidth =
    Math.floor((termCols - PICKER_PADDING * 2 + PICKER_GAP) / (PICKER_BLOCK_WIDTH + PICKER_GAP)) || 1;
  return Math.min(Math.max(1, Math.min(maxByWidth, PICKER_MAX_COLUMNS)), Math.max(1, count));
}

/** Top-left cell of a colour block inside the picker grid. */
export function pickerBlockOrigin(index: number, columns: number): [number, number] {
  return [
    PICKER_PADDING + (index % columns) * (PICKER_BLOCK_WIDTH + PICKER_GAP),
    PICKER_PADDING + Math.floor(index / columns) * (PICKER_BLOCK_HEIGHT + PICKER_GAP),
  ];
}

/** The border glyph around the selected block, drawn in the gap beside it. */
export function pickerBorder(index: number, columns: number, x: number, y: number): string | null {
  const [bx, by] = pickerBlockOrigin(index, columns);
  const left = bx - 1;
  const right = bx + PICKER_BLOCK_WIDTH;
  const bottom = by + PICKER_BLOCK_HEIGHT;

  if (y + 1 === by) {
    if (x === left) return "┏";
    if (x === right) return "┓";
    if (x > left && x < right) return "━";
    return null;
  }
  if (y === bottom) {
    if (x === left) return "┗";
    if (x === right) return "┛";
    if (x > left && x < right) return "━";
    return null;
  }
  if (y >= by && y < bottom && (x === left || x === right)) return "┃";
  return null;
}

/** The palette index whose block covers (x, y), if any. */
export function pickerFill(count: number, columns: number, x: number, y: number): number | null {
  if (x < PICKER_PADDING || y < PICKER_PADDING) return null;
  const relX = x - PICKER_PADDING;
  const relY = y - PICKER_PADDING;
  const strideX = PICKER_BLOCK_WIDTH + PICKER_GAP;
  const strideY = PICKER_BLOCK_HEIGHT + PICKER_GAP;
  if (relX % strideX >= PICKER_BLOCK_WIDTH || relY % strideY >= PICKER_BLOCK_HEIGHT) return null;
  const index = Math.floor(relY / strideY) * columns + Math.floor(relX / strideX);
  return index < count ? index : null;
}

function paintPicker(cells: Cell[][], state: GameState): void {
  const count = state.palette.length;
  if (count === 0 || state.picker === null) return;

  const rows = cells.length;
  const cols = rows > 0 ? cells[0].length : 0;
  const selected = state.picker;
  const columns = pickerColumns(count, cols);
  const gridRows = Math.ceil(count / columns);
  const panelWidth = pickerPanelWidth(columns);
  const gridHeight =
    PICKER_PADDING * 2 + gridRows * PICKER_BLOCK_HEIGHT + Math.max(0, gridRows - 1) * PICKER_GAP;
  const totalHeight = gridHeight + 2; // one blank row, then the help line
  if (panelWidth > cols || totalHeight > rows) return;

  const left = Math.floor((cols - panelWidth) / 2);
  const top = Math.floor((rows - totalHeight) / 2);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = top + gy;
    if (y < 0 || y >= rows) continue;
    for (let gx = 0; gx < panelWidth; gx += 1) {
      const x = left + gx;
      if (x < 0 || x >= cols) continue;
      const border = pickerBorder(selected, columns, gx, gy);
      if (border !== null) {
        cells[y][x] = { ch: border, sgr: "0;1;97" };
        continue;
      }
      const fill = pickerFill(count, columns, gx, gy);
      cells[y][x] =
        fill === null
          ? { ch: " ", sgr: "0" }
          : { ch: "█", sgr: String(state.palette[fill].fg) };
    }
  }

  const help = [..."←→↑↓ choose   enter select   esc cancel"].slice(0, cols).join("");
  const helpAt = left + Math.max(0, Math.floor((panelWidth - help.length) / 2) + PICKER_PADDING);
  const helpRow = top + gridHeight + 1;
  if (helpRow >= 0 && helpRow < rows) {
    for (let i = 0; i < help.length; i += 1) {
      const x = helpAt + i;
      if (x < 0 || x >= cols) continue;
      cells[helpRow][x] = { ch: help[i], sgr: "0;2" };
    }
  }
}

/** Group runs of one style into one escape, and reset at the end of the line. */
function cellsToLine(cells: Cell[]): string {
  let out = "";
  let sgr: string | null = null;
  for (const cell of cells) {
    if (cell.sgr !== sgr) {
      out += `\u001b[${cell.sgr}m`;
      sgr = cell.sgr;
    }
    out += cell.ch;
  }
  return `${out}\u001b[0m`;
}

function padCells(text: string, width: number): Cell[] {
  const cells = [...text].slice(0, width).map((ch) => ({ ch, sgr: "0" }));
  while (cells.length < width) cells.push({ ch: " ", sgr: "0" });
  return cells;
}

/** The reverse-video bar along the bottom, as the client draws it. */
export function statusLine(state: GameState, width: number): string {
  const tileName = state.palette[tileAt(state, state.x, state.y) ?? -1]?.name ?? "?";
  const brushName = state.brush === null ? "none" : (state.palette[state.brush]?.name ?? "none");
  const bar =
    ` place  (${state.x}, ${state.y})  tile: ${tileName}  brush: ${brushName}` +
    `  players: ${state.players.size + 1}  viewers: ${state.viewers}` +
    `  |  arrows/wasd move  space color  q quit `;
  const text = [...bar].slice(0, width).join("");
  return `\u001b[7m${text}${" ".repeat(Math.max(0, width - [...text].length))}\u001b[0m`;
}

/**
 * One frame: the camera view of the map, the status bar, and the picker when it
 * is open — the same layout `render()` produces, one terminal line per row.
 */
export function renderFrame(state: GameState, cols: number, rows: number): string[] {
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(2, Math.floor(rows));
  state.termCols = width;

  if (!state.ready) {
    const lines = [cellsToLine(padCells(`  ${state.status}`, width))];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const viewCols = width;
  const viewRows = Math.max(1, height - 1);
  const ox = state.x - Math.floor(viewCols / 2);
  const oy = state.y - Math.floor(viewRows / 2);
  const selfCol = Math.floor(viewCols / 2);
  const selfRow = Math.floor(viewRows / 2);

  // Where other players land in the viewport, honouring wrap-around.
  const others = new Set<string>();
  for (const player of state.players.values()) {
    const dx = wrap(player.x - ox, state.width);
    const dy = wrap(player.y - oy, state.height);
    if (dx < viewCols && dy < viewRows) others.add(`${dx},${dy}`);
  }

  const cells: Cell[][] = [];
  for (let row = 0; row < viewRows; row += 1) {
    const line: Cell[] = [];
    for (let col = 0; col < viewCols; col += 1) {
      const wx = wrap(ox + col, state.width);
      const wy = wrap(oy + row, state.height);
      const colour = state.tiles[wy * state.width + wx] ?? 0;
      const palette = state.palette[colour];
      const fg = palette ? palette.fg : 37;
      // One glyph per tile. A full block in the tile's colour fills the cell the
      // way the client's background colour does — and, unlike a run of spaces,
      // it survives a line that is nothing but one colour.
      if (col === selfCol && row === selfRow) {
        line.push({ ch: "●", sgr: fg === 37 ? `47;1;30` : `1;97` });
      } else if (others.has(`${col},${row}`)) {
        line.push({ ch: "●", sgr: fg === 37 ? `47;1;32` : `1;92` });
      } else {
        line.push({ ch: "█", sgr: String(fg) });
      }
    }
    cells.push(line);
  }

  paintPicker(cells, state);

  const lines = cells.map(cellsToLine);
  lines.push(statusLine(state, width));
  return lines.slice(0, height);
}

/* ------------------------------------------------------------------ socket -- */

export interface GameSocket {
  send(message: ClientMessage): void;
  close(): void;
}

interface SocketOptions {
  url: string;
  state: GameState;
  onFrame: () => void;
  makeSocket?: (url: string) => WebSocket;
}

/**
 * Keep a socket open, reconnecting with the client's backoff, and feed frames
 * into `state`. Sends are dropped unless the socket is open, which matches the
 * client: it only ever writes while connected.
 */
export function connectSocket(options: SocketOptions): GameSocket {
  const make = options.makeSocket ?? ((url: string) => new WebSocket(url));
  const url = normalizeUrl(options.url);
  let socket: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let status = `Connecting to ${options.url} …`;

  const setStatus = (text: string) => {
    status = text;
    options.state.status = text;
    options.onFrame();
  };

  const open = () => {
    if (closed) return;
    options.state.status = status;
    let next: WebSocket;
    try {
      next = make(url);
    } catch (error) {
      setStatus(`${String((error as Error)?.message ?? error)} — reconnecting…`);
      schedule();
      return;
    }
    socket = next;

    next.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data) applyFrame(options.state, data);
      options.onFrame();
    });
    next.addEventListener("close", () => {
      if (closed) return;
      options.state.ready = false;
      setStatus("disconnected — reconnecting…");
      schedule();
    });
    next.addEventListener("error", () => {
      // A failed connect also fires `close`; nothing to do but stay quiet.
    });
  };

  const schedule = () => {
    if (closed || retry) return;
    attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 8000);
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
    // Node timers keep the process alive; a game must not.
    (retry as unknown as { unref?: () => void }).unref?.();
  };

  open();

  return {
    send(message) {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      retry = null;
      try {
        socket?.close();
      } catch {
        // A socket that is already gone is fine to ignore.
      }
      socket = null;
    },
  };
}

/* --------------------------------------------------------------- pi wiring -- */

/** What the extension needs from Pi's UI to run a game. */
export interface GameContextLike {
  mode?: string;
  ui: {
    custom<T>(
      factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
      options?: {
        overlay?: boolean;
        overlayOptions?: Record<string, unknown>;
        onHandle?: (handle: any) => void;
      },
    ): Promise<T>;
    notify(message: string, level?: string): void;
  };
}

interface OpenGame {
  close(): void;
}

let current: OpenGame | null = null;

/**
 * Run one game until it closes. `ctx.ui.custom` gives the component control of
 * the interactive area and resolves when it calls `done`, which is what both the
 * Esc key and the settle handler trigger.
 */
async function openGame(ctx: GameContextLike, config: Config): Promise<void> {
  if (ctx.mode && ctx.mode !== "tui") {
    ctx.ui.notify("place needs Pi's interactive UI.", "warning");
    return;
  }
  // One game at a time, like one pane: a second prompt reuses what is open.
  if (current) return;

  const state = newState(`Connecting to ${config.server} …`);
  let finish: (() => void) | null = null;
  let requestRender: () => void = () => {};
  let closed = false;

  const socket = connectSocket({
    url: config.server,
    state,
    onFrame: () => requestRender(),
  });

  const handle: OpenGame = {
    close() {
      if (closed) return;
      closed = true;
      socket.close();
      if (current === handle) current = null;
      finish?.();
    },
  };
  current = handle;

  try {
    await ctx.ui.custom<void>(
      (tui: any, _theme: unknown, _keybindings: unknown, done: () => void) => {
        finish = done;
        requestRender = () => tui.requestRender();

        return {
          render(width: number): string[] {
            const share = parseSize(config.size) ?? 0.8;
            const rows = Math.max(3, Math.floor((tui?.terminal?.rows ?? 24) * share));
            return renderFrame(state, width, rows);
          },
          handleInput(data: string): void {
            const key = decodeKey(data);
            if (!key) return;
            const result = handleKey(state, key);
            for (const message of result.messages) socket.send(message);
            if (result.quit) {
              handle.close();
              return;
            }
            const queued = drainQueuedPaint(state);
            if (queued) socket.send(queued);
            tui.requestRender();
          },
          invalidate(): void {},
        };
      },
      // A box in the middle of Pi's page, not the page: the transcript and the
      // prompt stay visible around it, and the size holds the game to a share of
      // the screen.
      {
        overlay: true,
        overlayOptions: {
          width: config.size,
          maxHeight: config.size,
          anchor: "center",
          margin: 1,
        },
        onHandle: (handle: { focus(): void }) => handle.focus(),
      },
    );
  } finally {
    handle.close();
  }
}

export default function (pi: ExtensionAPI) {
  // A run is the wait: open the game when Pi starts working on one. Not awaited:
  // the promise lasts as long as the game, and the run must not wait on it.
  pi.on("agent_start", (_event, ctx) => {
    openGame(ctx as unknown as GameContextLike, readConfig()).catch(() => {
      // A game that will not open must never cost the run it was meant to fill.
    });
  });

  // `agent_settled` is the final idle signal, not `agent_end`: that one also
  // fires before a retry, a compaction retry or a queued follow-up, and the game
  // should stay up through those.
  pi.on("agent_settled", async () => {
    if (readConfig().keep) return;
    current?.close();
  });

  pi.on("session_shutdown", async () => {
    current?.close();
  });

  pi.registerCommand("place", {
    description: "Play on the shared place map while Pi works",
    handler: async (args, ctx) => {
      const wantsOff = args.trim().toLowerCase() === "off";
      try {
        if (wantsOff || current) {
          if (current) {
            current.close();
            ctx.ui.notify("Closed place.", "info");
          } else {
            ctx.ui.notify("place is not open.", "info");
          }
          return;
        }
        await openGame(ctx as unknown as GameContextLike, readConfig());
      } catch (error) {
        ctx.ui.notify(`place: ${String((error as Error)?.message ?? error)}`, "error");
      }
    },
  });
}
