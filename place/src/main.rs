//! place — a shared-map terminal client.
//!
//! Connects to a `world-server`, draws a camera view of the wrapping 1024x1024
//! tile map (each tile is a single colored character cell), spawns you on a
//! random tile, and lets you walk with the arrow keys. Space opens a color
//! picker; once you choose a brush, every tile you walk onto is painted with it.
//! You're a bold white dot; other players are bold green dots.
//!
//! Install:
//!   cargo install place-tui                # from crates.io
//!   cargo install --path .                 # -> ~/.cargo/bin/place
//!   cargo install --path . --root ~/.local # -> ~/.local/bin/place

use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

const DEFAULT_SERVER: &str = "wss://place-tui.fly.dev";
// Keep the socket read timeout short: the net thread only gets to flush
// outgoing messages after a read returns, so this is added to every move's
// latency. 5ms is cheap (a few hundred cheap wakeups per second at most) and
// keeps keystrokes from sitting in the queue.
const READ_TIMEOUT_MS: u64 = 5;
const RECONNECT_POLL_MS: u64 = 50;
/// How many moves may be awaiting the server's acknowledgement. Bounds the
/// flood a held arrow key can send and the size of the prediction queue.
const MAX_MOVES_IN_FLIGHT: usize = 8;
const SELF_STYLE: &str = "1;97"; // bold bright white — you
const OTHER_STYLE: &str = "1;92"; // bold bright green — other players
const QUIT_SENTINEL: &str = "\u{0}quit";

type Socket = WebSocket<MaybeTlsStream<std::net::TcpStream>>;

// ---- config ----------------------------------------------------------------

#[derive(Clone)]
struct Config {
    server: String,
}

fn help_text() -> &'static str {
    r#"place — shared-map terminal client

Usage:
  place [options] [server]

Arguments:
  server                WebSocket URL (default: wss://place-tui.fly.dev)

Options:
  -s, --server <url>    server URL
  -h, --help            show this help
  -V, --version         show version

Environment:
  PLACE_SERVER   default server URL

Controls:
  arrows / wasd   move around the map, or the color picker
  space           open the color picker
  enter           choose the highlighted color (paints the tile you're on)
  q / esc         close the picker, or quit
"#
}

fn parse_args() -> Config {
    let mut server = env::var("PLACE_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.to_string());

    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].clone();
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{}", help_text());
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("place {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-s" | "--server" => {
                i += 1;
                match args.get(i) {
                    Some(v) => server = v.clone(),
                    None => {
                        eprintln!("Missing value for --server");
                        std::process::exit(2);
                    }
                }
            }
            other
                if other.starts_with("ws://")
                    || other.starts_with("wss://")
                    || other.starts_with("http://")
                    || other.starts_with("https://") =>
            {
                server = other.to_string();
            }
            other => {
                eprintln!("Unexpected argument: {other}\n");
                print!("{}", help_text());
                std::process::exit(2);
            }
        }
        i += 1;
    }

    Config { server }
}

// ---- app state -------------------------------------------------------------

struct PaletteColor {
    name: String,
    fg: u8,
}

struct Player {
    x: i32,
    y: i32,
}

struct App {
    ready: bool,
    width: i32,
    height: i32,
    palette: Vec<PaletteColor>,
    tiles: Vec<u8>,
    id: u64,
    x: i32,
    y: i32,
    players: HashMap<u64, Player>,
    viewers: u64,
    status: String,
    dirty: bool,
    /// Moves sent but not yet acknowledged by the server, in order. We predict
    /// them locally and replay whatever is left on top of each `pos` reply.
    pending_moves: VecDeque<(i32, i32)>,
    /// Space was pressed while moves were pending; paint once they settle.
    paint_queued: bool,
    /// The color chosen from the picker. Every tile stepped onto is painted
    /// with it until another color is chosen.
    brush: Option<usize>,
    /// Highlighted palette index while the color picker is open.
    picker: Option<usize>,
}

impl App {
    fn new(status: String) -> Self {
        App {
            ready: false,
            width: 0,
            height: 0,
            palette: Vec::new(),
            tiles: Vec::new(),
            id: 0,
            x: 0,
            y: 0,
            players: HashMap::new(),
            viewers: 0,
            status,
            dirty: true,
            pending_moves: VecDeque::new(),
            paint_queued: false,
            brush: None,
            picker: None,
        }
    }

    /// Open the picker on the current brush, or on the tile underfoot when no
    /// brush has been chosen yet.
    fn open_picker(&mut self) {
        if self.palette.is_empty() {
            return;
        }
        let selected = self
            .brush
            .or_else(|| self.tile(self.x, self.y).map(|c| c as usize))
            .unwrap_or(0)
            .min(self.palette.len() - 1);
        self.picker = Some(selected);
        self.dirty = true;
    }

    fn close_picker(&mut self) {
        self.picker = None;
        self.dirty = true;
    }

    /// Move the picker highlight around its grid.
    fn move_picker(&mut self, dx: i32, dy: i32) {
        let Some(selected) = self.picker else {
            return;
        };
        let count = self.palette.len();
        if count == 0 {
            return;
        }
        let columns = picker_columns(self);
        let next = if dx < 0 {
            (selected + count - 1) % count
        } else if dx > 0 {
            (selected + 1) % count
        } else if dy < 0 {
            selected.saturating_sub(columns)
        } else if dy > 0 {
            let below = selected + columns;
            if below < count { below } else { selected }
        } else {
            selected
        };
        let next = next.min(count - 1);
        if next != selected {
            self.picker = Some(next);
            self.dirty = true;
        }
    }

    fn tile(&self, x: i32, y: i32) -> Option<u8> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return None;
        }
        self.tiles.get((y * self.width + x) as usize).copied()
    }

    fn apply(&mut self, text: &str) {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };
        match value.get("type").and_then(Value::as_str) {
            Some("init") => self.apply_init(&value),
            Some("tile") => {
                let x = value.get("x").and_then(Value::as_i64).unwrap_or(-1) as i32;
                let y = value.get("y").and_then(Value::as_i64).unwrap_or(-1) as i32;
                let color = value.get("color").and_then(Value::as_u64).unwrap_or(0) as u8;
                if let Some(i) = self.index(x, y) {
                    if let Some(t) = self.tiles.get_mut(i) {
                        *t = color;
                    }
                    self.dirty = true;
                }
            }
            Some("pos") => {
                let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
                let x = value.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
                let y = value.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
                if id == self.id {
                    self.pending_moves.pop_front();
                    self.reconcile(x, y);
                } else if let Some(p) = self.players.get_mut(&id) {
                    p.x = x;
                    p.y = y;
                }
                self.dirty = true;
            }
            Some("join") => {
                let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
                if id != self.id {
                    self.players.insert(
                        id,
                        Player {
                            x: value.get("x").and_then(Value::as_i64).unwrap_or(0) as i32,
                            y: value.get("y").and_then(Value::as_i64).unwrap_or(0) as i32,
                        },
                    );
                    self.dirty = true;
                }
            }
            Some("leave") => {
                let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
                self.players.remove(&id);
                self.dirty = true;
            }
            Some("viewers") => {
                self.viewers = value.get("count").and_then(Value::as_u64).unwrap_or(0);
                self.dirty = true;
            }
            Some("error") => {
                self.status = format!("error: {}", value.get("text").and_then(Value::as_str).unwrap_or(""));
                self.dirty = true;
            }
            _ => {}
        }
    }

    fn apply_init(&mut self, value: &Value) {
        self.width = value.get("width").and_then(Value::as_i64).unwrap_or(0) as i32;
        self.height = value.get("height").and_then(Value::as_i64).unwrap_or(0) as i32;
        self.id = value.get("id").and_then(Value::as_u64).unwrap_or(0);

        self.palette = value
            .get("palette")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|c| PaletteColor {
                        name: c.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                        fg: c.get("fg").and_then(Value::as_u64).unwrap_or(37) as u8,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let cells = (self.width.max(0) * self.height.max(0)) as usize;
        self.tiles = vec![0u8; cells];
        if let Some(rle) = value.get("rle").and_then(Value::as_array) {
            let mut idx = 0usize;
            let mut it = rle.iter();
            while let (Some(color), Some(count)) = (it.next(), it.next()) {
                let color = color.as_u64().unwrap_or(0) as u8;
                let count = count.as_u64().unwrap_or(0) as usize;
                for _ in 0..count {
                    if idx >= cells {
                        break;
                    }
                    self.tiles[idx] = color;
                    idx += 1;
                }
            }
        }

        self.x = value.get("you").and_then(|y| y.get("x")).and_then(Value::as_i64).unwrap_or(0) as i32;
        self.y = value.get("you").and_then(|y| y.get("y")).and_then(Value::as_i64).unwrap_or(0) as i32;

        self.players.clear();
        if let Some(arr) = value.get("players").and_then(Value::as_array) {
            for p in arr {
                let id = p.get("id").and_then(Value::as_u64).unwrap_or(0);
                if id == self.id {
                    continue;
                }
                self.players.insert(
                    id,
                    Player {
                        x: p.get("x").and_then(Value::as_i64).unwrap_or(0) as i32,
                        y: p.get("y").and_then(Value::as_i64).unwrap_or(0) as i32,
                    },
                );
            }
        }

        self.viewers = value.get("viewers").and_then(Value::as_u64).unwrap_or(0);

        self.ready = true;
        self.pending_moves.clear();
        self.paint_queued = false;
        if self.picker.map_or(false, |i| i >= self.palette.len()) {
            self.picker = self.palette.len().checked_sub(1);
        }
        if self.brush.map_or(false, |i| i >= self.palette.len()) {
            self.brush = None;
        }
        self.dirty = true;
    }

    /// Adopt the server's position, then replay the moves it hasn't seen yet.
    /// Each move gets exactly one `pos` reply, so this also undoes any move the
    /// server dropped for rate-limiting without leaving us desynced.
    fn reconcile(&mut self, server_x: i32, server_y: i32) {
        let (mut x, mut y) = (server_x, server_y);
        for &(dx, dy) in &self.pending_moves {
            x = (x + dx).rem_euclid(self.width);
            y = (y + dy).rem_euclid(self.height);
        }
        self.x = x;
        self.y = y;
    }

    fn index(&self, x: i32, y: i32) -> Option<usize> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return None;
        }
        Some((y * self.width + x) as usize)
    }
}

// ---- terminal --------------------------------------------------------------

struct Term;

impl Term {
    fn new() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen, cursor::Hide)?;
        Ok(Term)
    }
}

impl Drop for Term {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), cursor::Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}

fn write_frame(frame: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    out.write_all(frame.as_bytes())?;
    out.flush()
}

const PICKER_BLOCK_WIDTH: usize = 6;
const PICKER_BLOCK_HEIGHT: usize = 3;
const PICKER_GAP: usize = 1;
const PICKER_PADDING: usize = 1;
const PICKER_MAX_COLUMNS: usize = 4;

fn picker_panel_width(columns: usize) -> usize {
    columns * PICKER_BLOCK_WIDTH
        + columns.saturating_sub(1) * PICKER_GAP
        + PICKER_PADDING * 2
}

/// Lay the picker out in as many columns of color blocks as fit.
fn picker_columns(app: &App) -> usize {
    let term_cols = terminal::size().map(|(c, _)| c as usize).unwrap_or(80);
    let max_by_width = (term_cols.saturating_sub(PICKER_PADDING * 2) + PICKER_GAP)
        / (PICKER_BLOCK_WIDTH + PICKER_GAP);
    max_by_width
        .clamp(1, PICKER_MAX_COLUMNS)
        .min(app.palette.len().max(1))
}

/// Top-left cell of a color block inside the picker grid.
fn picker_block_origin(index: usize, columns: usize) -> (usize, usize) {
    (
        PICKER_PADDING + (index % columns) * (PICKER_BLOCK_WIDTH + PICKER_GAP),
        PICKER_PADDING + (index / columns) * (PICKER_BLOCK_HEIGHT + PICKER_GAP),
    )
}

/// The border cell for the selected block at (x, y). The border is drawn just
/// outside the colored swatch, in the one-cell gap around it.
fn picker_border(index: usize, columns: usize, x: usize, y: usize) -> Option<char> {
    let (bx, by) = picker_block_origin(index, columns);
    let left = bx - 1;
    let right = bx + PICKER_BLOCK_WIDTH;
    let bottom = by + PICKER_BLOCK_HEIGHT;

    if y + 1 == by {
        if x == left {
            Some('┏')
        } else if x == right {
            Some('┓')
        } else if x > left && x < right {
            Some('━')
        } else {
            None
        }
    } else if y == bottom {
        if x == left {
            Some('┗')
        } else if x == right {
            Some('┛')
        } else if x > left && x < right {
            Some('━')
        } else {
            None
        }
    } else if y >= by && y < bottom && (x == left || x == right) {
        Some('┃')
    } else {
        None
    }
}

/// The palette index whose block covers (x, y), if any.
fn picker_fill(count: usize, columns: usize, x: usize, y: usize) -> Option<usize> {
    if x < PICKER_PADDING || y < PICKER_PADDING {
        return None;
    }
    let rel_x = x - PICKER_PADDING;
    let rel_y = y - PICKER_PADDING;
    let stride_x = PICKER_BLOCK_WIDTH + PICKER_GAP;
    let stride_y = PICKER_BLOCK_HEIGHT + PICKER_GAP;
    if rel_x % stride_x >= PICKER_BLOCK_WIDTH || rel_y % stride_y >= PICKER_BLOCK_HEIGHT {
        return None;
    }
    let index = (rel_y / stride_y) * columns + rel_x / stride_x;
    (index < count).then_some(index)
}


fn render_picker(app: &App, cols: u16, rows: u16) -> String {
    let count = app.palette.len();
    let selected = app.picker.unwrap_or(0);
    let columns = picker_columns(app);
    let grid_rows = (count + columns - 1) / columns;
    let panel_width = picker_panel_width(columns);
    let grid_height = PICKER_PADDING * 2
        + grid_rows * PICKER_BLOCK_HEIGHT
        + grid_rows.saturating_sub(1) * PICKER_GAP;
    let total_height = grid_height + 2; // one blank row, then the help line
    if count == 0 || panel_width > cols as usize || total_height > rows as usize {
        return String::new();
    }

    let grid_left = ((cols as usize - panel_width) / 2) as u16 + 1;
    let grid_top = ((rows as usize - total_height) / 2) as u16 + 1;
    let mut out = String::new();

    for gy in 0..grid_height {
        let mut line = String::new();
        for gx in 0..panel_width {
            if let Some(ch) = picker_border(selected, columns, gx, gy) {
                line.push_str("\x1b[0;1;97m");
                line.push(ch);
            } else if let Some(index) = picker_fill(count, columns, gx, gy) {
                let bg = app.palette[index].fg as i32 + 10;
                line.push_str(&format!("\x1b[0;{bg}m "));
            } else {
                line.push_str("\x1b[0m ");
            }
        }
        line.push_str("\x1b[0m");
        out.push_str(&format!("\x1b[{};{}H{}", grid_top + gy as u16, grid_left, line));
    }

    let help = "←→↑↓ choose   enter select   esc cancel";
    let help: String = help.chars().take(cols as usize).collect();
    let help_left = ((cols as usize - help.chars().count()) / 2) as u16 + 1;
    let help_row = grid_top + grid_height as u16 + 1;
    out.push_str(&format!(
        "\x1b[{};{}H\x1b[0;2m {} \x1b[0m",
        help_row, help_left, help
    ));
    out
}

/// A hung-up pty makes crossterm's event poll spin on EOF without returning,
/// so a small watchdog thread watches for POLLHUP and exits the process. There
/// is no terminal left to restore, and the OS closes the socket for us.
#[cfg(unix)]
fn spawn_tty_watchdog() {
    use std::os::unix::io::AsRawFd;

    thread::spawn(|| loop {
        thread::sleep(Duration::from_millis(250));
        let mut pfd = libc::pollfd {
            fd: io::stdin().as_raw_fd(),
            // POLLHUP is only reported on macOS when at least one event is
            // requested, so ask for POLLIN (we ignore plain readiness).
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll only writes into the pollfd we own.
        let ready = unsafe { libc::poll(&mut pfd, 1, 0) };
        if ready > 0 && pfd.revents & libc::POLLHUP != 0 {
            std::process::exit(0);
        }
    });
}

#[cfg(not(unix))]
fn spawn_tty_watchdog() {}

fn render(app: &App) -> io::Result<()> {
    let (cols, rows) = terminal::size().unwrap_or((80, 24));
    let mut s = String::with_capacity((cols as usize + 16) * rows as usize);
    s.push_str("\x1b[H");

    if !app.ready {
        s.push_str("\x1b[2J\x1b[0m");
        s.push_str(&format!("  {}", app.status));
        s.push_str("\x1b[0m");
        return write_frame(&s);
    }

    let w = app.width;
    let h = app.height;
    let view_cols = cols as i32;
    let view_rows = (rows as usize).saturating_sub(1).max(1) as i32;
    let ox = app.x - view_cols / 2;
    let oy = app.y - view_rows / 2;
    let self_cell = (view_cols / 2, view_rows / 2);

    // Where other players land in the viewport, honoring wrap-around.
    let mut others: HashMap<(i32, i32), ()> = HashMap::new();
    for p in app.players.values() {
        let dx = (p.x - ox).rem_euclid(w);
        let dy = (p.y - oy).rem_euclid(h);
        if dx < view_cols && dy < view_rows {
            others.insert((dx, dy), ());
        }
    }

    for row in 0..view_rows {
        let mut last_bg: i32 = i32::MIN;
        let mut last_style: &str = "";
        for col in 0..view_cols {
            let wx = (ox + col).rem_euclid(w);
            let wy = (oy + row).rem_euclid(h);
            let color = app.tiles.get((wy * w + wx) as usize).copied().unwrap_or(0);

            let bg: i32 = app
                .palette
                .get(color as usize)
                .map(|c| c.fg as i32 + 10)
                .unwrap_or(47);

            // One character per tile: a bold dot for you (white) and for other
            // players (green). On white tiles those are hard to see, so darker
            // foregrounds are used there.
            let (glyph, style) = if (col, row) == self_cell {
                ('●', if bg == 47 { "1;30" } else { SELF_STYLE })
            } else if others.contains_key(&(col, row)) {
                ('●', if bg == 47 { "1;32" } else { OTHER_STYLE })
            } else {
                (' ', "39")
            };

            if bg != last_bg {
                s.push_str("\x1b[");
                s.push_str(&bg.to_string());
                s.push('m');
                last_bg = bg;
            }
            if style != last_style {
                s.push_str("\x1b[");
                s.push_str(style);
                s.push('m');
                last_style = style;
            }
            s.push(glyph);
        }
        s.push_str("\x1b[0m\x1b[K\r\n");
    }

    // Clear anything below the map, then draw the status bar on the last row.
    s.push_str("\x1b[0m\x1b[J");
    s.push_str(&format!("\x1b[{};1H", rows));

    let tile_name = app
        .tile(app.x, app.y)
        .and_then(|c| app.palette.get(c as usize))
        .map(|c| c.name.as_str())
        .unwrap_or("?");
    let brush_name = app
        .brush
        .and_then(|c| app.palette.get(c))
        .map(|c| c.name.as_str())
        .unwrap_or("none");
    let bar = format!(
        " place  ({}, {})  tile: {}  brush: {}  players: {}  viewers: {}  |  arrows/wasd move  space color  q quit ",
        app.x,
        app.y,
        tile_name,
        brush_name,
        app.players.len() + 1,
        app.viewers,
    );
    let bar: String = bar.chars().take(cols as usize).collect();
    let padded = format!("{:<width$}", bar, width = cols as usize);
    s.push_str("\x1b[7m");
    s.push_str(&padded);
    s.push_str("\x1b[0m");

    if app.picker.is_some() {
        s.push_str(&render_picker(app, cols, rows));
    }

    write_frame(&s)
}

// ---- networking ------------------------------------------------------------

enum NetEvent {
    Message(String),
    Closed(String),
}

fn set_read_timeout(socket: &mut Socket) {
    let timeout = Some(Duration::from_millis(READ_TIMEOUT_MS));
    match socket.get_ref() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(timeout);
        }
        MaybeTlsStream::NativeTls(s) => {
            let _ = s.get_ref().set_read_timeout(timeout);
        }
        _ => {}
    }
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

fn net_thread(
    server: String,
    in_tx: Sender<NetEvent>,
    out_rx: Receiver<String>,
    shutdown: Arc<AtomicBool>,
) {
    let mut attempts: u32 = 0;

    loop {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }

        let url = normalize_url(&server);
        match connect(url.as_str()) {
            Ok((mut socket, _response)) => {
                set_read_timeout(&mut socket);
                attempts = 0;

                loop {
                    if shutdown.load(Ordering::SeqCst) {
                        let _ = socket.close(None);
                        return;
                    }

                    // Forward anything the UI wants to send.
                    let mut quit = false;
                    loop {
                        match out_rx.try_recv() {
                            Ok(cmd) => {
                                if cmd == QUIT_SENTINEL {
                                    quit = true;
                                    break;
                                }
                                let _ = socket.send(Message::Text(cmd.into()));
                            }
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => {
                                quit = true;
                                break;
                            }
                        }
                    }
                    if quit {
                        let _ = socket.close(None);
                        let _ = socket.flush();
                        return;
                    }

                    match socket.read() {
                        Ok(Message::Text(t)) => {
                            let _ = in_tx.send(NetEvent::Message(t.as_str().to_string()));
                        }
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(ref e)) if is_timeout(e) => {}
                        Err(e) => {
                            let _ = in_tx.send(NetEvent::Closed(e.to_string()));
                            break;
                        }
                    }
                }
            }
            Err(tungstenite::Error::Http(response)) => {
                let _ = in_tx.send(NetEvent::Closed(format!(
                    "not a WebSocket server (HTTP {}) — is the world server running?",
                    response.status()
                )));
            }
            Err(e) => {
                let _ = in_tx.send(NetEvent::Closed(e.to_string()));
            }
        }

        // Reconnect with backoff, still honoring a quit request.
        attempts += 1;
        let secs = (1u64 << (attempts.min(4) - 1)).min(8);
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            match out_rx.try_recv() {
                Ok(cmd) if cmd == QUIT_SENTINEL => {
                    shutdown.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(_) => {}
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    shutdown.store(true, Ordering::SeqCst);
                    return;
                }
            }
            thread::sleep(Duration::from_millis(RECONNECT_POLL_MS));
        }
    }
}

/// Make sure the URL has a path component so the HTTP request target is `/`
/// rather than empty.
fn normalize_url(server: &str) -> String {
    // Accept http(s):// as a convenience and map it to ws(s)://.
    let mut s = if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        server.to_string()
    };
    if let Some(pos) = s.find("://") {
        if !s[pos + 3..].contains('/') {
            s.push('/');
        }
    }
    s
}

// ---- input -----------------------------------------------------------------

fn send_move(app: &mut App, dx: i32, dy: i32, out: &Sender<String>) {
    if !app.ready || app.pending_moves.len() >= MAX_MOVES_IN_FLIGHT {
        return;
    }
    // Move immediately so the cursor feels local; the server's `pos` reply
    // (sent for every move, applied or dropped) reconciles us if it disagrees.
    app.x = (app.x + dx).rem_euclid(app.width);
    app.y = (app.y + dy).rem_euclid(app.height);
    app.dirty = true;
    app.pending_moves.push_back((dx, dy));

    // When a brush is selected the move itself carries the color, so the server
    // paints the destination tile as part of the move. It only broadcasts the
    // tile when it actually changes, which keeps walking over old art cheap.
    let message = match app.brush {
        Some(color) => json!({ "type": "move", "dx": dx, "dy": dy, "color": color }),
        None => json!({ "type": "move", "dx": dx, "dy": dy }),
    };
    let _ = out.send(message.to_string());
}

fn send_paint(app: &mut App, out: &Sender<String>) {
    if !app.ready {
        return;
    }
    let Some(color) = app.brush else {
        return;
    };
    // The paint carries our coordinates, and the server only paints the tile it
    // believes we're on. If a move is still in flight our position isn't
    // settled yet, so paint as soon as it is.
    if !app.pending_moves.is_empty() {
        app.paint_queued = true;
        return;
    }
    app.paint_queued = false;
    // Nothing to do when the tile is already the brush color.
    if app.tile(app.x, app.y) == Some(color as u8) {
        return;
    }
    // Painting is server-authoritative too: the `tile` broadcast updates us.
    let _ = out.send(
        json!({ "type": "paint", "x": app.x, "y": app.y, "color": color }).to_string(),
    );
}

fn confirm_picker(app: &mut App, out: &Sender<String>) {
    let Some(selected) = app.picker.take() else {
        return;
    };
    if app.palette.is_empty() {
        return;
    }
    app.brush = Some(selected.min(app.palette.len() - 1));
    app.dirty = true;
    // Paint the tile underfoot too, so choosing a brush does something even
    // before the next step (and gives a way to recolor a single tile).
    send_paint(app, out);
}

// ---- main ------------------------------------------------------------------

fn main() {
    let cfg = parse_args();

    let (in_tx, in_rx) = mpsc::channel::<NetEvent>();
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let shutdown = Arc::new(AtomicBool::new(false));

    let net = {
        let server = cfg.server.clone();
        let shutdown = Arc::clone(&shutdown);
        thread::spawn(move || net_thread(server, in_tx, out_rx, shutdown))
    };

    // Restore the terminal even if we panic.
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen, cursor::Show);
        original_hook(info);
    }));

    let mut app = App::new(format!("Connecting to {} …", cfg.server));

    let _term = match Term::new() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("failed to start terminal: {e}");
            std::process::exit(1);
        }
    };
    spawn_tty_watchdog();
    let _ = render(&app);

    let mut running = true;
    let mut last_health = Instant::now();
    while running {
        // Treat terminal errors (e.g. the pty going away) as a reason to quit;
        // otherwise `poll` fails instantly and this loop spins at 100% CPU.
        match event::poll(Duration::from_millis(16)) {
            Ok(true) => match event::read() {
                Ok(Event::Key(key))
                    if key.kind == KeyEventKind::Press || key.kind == KeyEventKind::Repeat =>
                {
                    match key.code {
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            running = false
                        }
                        KeyCode::Char('q') | KeyCode::Esc => {
                            if app.picker.is_some() {
                                app.close_picker();
                            } else {
                                running = false;
                            }
                        }
                        KeyCode::Enter => {
                            if app.picker.is_some() {
                                confirm_picker(&mut app, &out_tx);
                            }
                        }
                        KeyCode::Up | KeyCode::Char('w') | KeyCode::Char('k') => {
                            if app.picker.is_some() {
                                app.move_picker(0, -1);
                            } else {
                                send_move(&mut app, 0, -1, &out_tx);
                            }
                        }
                        KeyCode::Down | KeyCode::Char('s') | KeyCode::Char('j') => {
                            if app.picker.is_some() {
                                app.move_picker(0, 1);
                            } else {
                                send_move(&mut app, 0, 1, &out_tx);
                            }
                        }
                        KeyCode::Left | KeyCode::Char('a') | KeyCode::Char('h') => {
                            if app.picker.is_some() {
                                app.move_picker(-1, 0);
                            } else {
                                send_move(&mut app, -1, 0, &out_tx);
                            }
                        }
                        KeyCode::Right | KeyCode::Char('d') | KeyCode::Char('l') => {
                            if app.picker.is_some() {
                                app.move_picker(1, 0);
                            } else {
                                send_move(&mut app, 1, 0, &out_tx);
                            }
                        }
                        KeyCode::Char(' ') => {
                            if app.picker.is_none() {
                                app.open_picker();
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Resize(_, _)) => app.dirty = true,
                Ok(_) => {}
                Err(_) => running = false,
            },
            Ok(false) => {}
            Err(_) => running = false,
        }

        loop {
            match in_rx.try_recv() {
                Ok(NetEvent::Message(text)) => app.apply(&text),
                Ok(NetEvent::Closed(reason)) => {
                    app.ready = false;
                    app.status = format!("{reason} — reconnecting…");
                    app.dirty = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    running = false;
                    break;
                }
            }
        }

        // A paint requested while moves were still in flight fires as soon as
        // the server confirms where we ended up.
        if app.paint_queued && app.pending_moves.is_empty() {
            send_paint(&mut app, &out_tx);
        }

        if app.dirty {
            if render(&app).is_err() {
                // The terminal is gone; stop instead of writing to a dead tty.
                running = false;
            } else {
                app.dirty = false;
                last_health = Instant::now();
            }
        }

        // crossterm's poll can busy-loop on POLLHUP without surfacing an error,
        // so probe the terminal now and then with an invisible, idempotent
        // write. If it fails, the tty is gone and we should too.
        if running && last_health.elapsed() >= Duration::from_secs(1) {
            if write_frame("\x1b[?25l").is_err() {
                running = false;
            }
            last_health = Instant::now();
        }
    }

    let _ = out_tx.send(QUIT_SENTINEL.to_string());
    drop(out_tx);
    drop(_term); // restore the terminal before joining
    let _ = net.join();
    // The terminal may already be gone; don't panic on a broken pipe.
    let _ = writeln!(io::stdout(), "bye 👋");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_pending(pending: &[(i32, i32)]) -> App {
        let mut app = App::new(String::new());
        app.width = 10;
        app.height = 10;
        app.pending_moves.extend(pending.iter().copied());
        app
    }

    #[test]
    fn reconcile_replays_moves_the_server_has_not_seen() {
        let mut app = app_with_pending(&[(1, 0), (1, 0)]);
        app.pending_moves.pop_front(); // ack for the first move, server now at (1, 0)
        app.reconcile(1, 0);
        assert_eq!((app.x, app.y), (2, 0), "second move is still predicted");
    }

    #[test]
    fn reconcile_undoes_a_dropped_move() {
        let mut app = app_with_pending(&[(1, 0), (1, 0), (0, 1)]);
        app.pending_moves.pop_front(); // the server dropped it and stayed at (0, 0)
        app.reconcile(0, 0);
        assert_eq!((app.x, app.y), (1, 1), "remaining moves replay from the ack");
    }

    #[test]
    fn reconcile_wraps_at_the_edge() {
        let mut app = app_with_pending(&[(-1, -1)]);
        app.reconcile(0, 0);
        assert_eq!((app.x, app.y), (9, 9));
    }

    #[test]
    fn picker_border_surrounds_the_selected_swatch() {
        assert_eq!(picker_border(0, 4, 0, 0), Some('┏'));
        assert_eq!(picker_border(0, 4, 3, 0), Some('━'));
        assert_eq!(picker_border(0, 4, 7, 0), Some('┓'));
        assert_eq!(picker_border(0, 4, 0, 2), Some('┃'));
        assert_eq!(picker_border(0, 4, 7, 2), Some('┃'));
        assert_eq!(picker_border(0, 4, 0, 4), Some('┗'));
        assert_eq!(picker_border(0, 4, 7, 4), Some('┛'));
        assert_eq!(picker_border(0, 4, 3, 2), None, "the fill stays untouched");
        assert_eq!(picker_border(0, 4, 8, 2), None, "nothing outside the square");
        assert_eq!(picker_border(1, 4, 8, 5), None, "only the selected block");
    }

    #[test]
    fn picker_fill_maps_cells_to_palette_indexes() {
        assert_eq!(picker_fill(12, 4, 1, 1), Some(0));
        assert_eq!(picker_fill(12, 4, 6, 3), Some(0));
        assert_eq!(picker_fill(12, 4, 7, 1), None, "column gap");
        assert_eq!(picker_fill(12, 4, 8, 1), Some(1));
        assert_eq!(picker_fill(12, 4, 22, 9), Some(11));
        assert_eq!(picker_fill(12, 4, 28, 9), None, "right padding");
    }

    #[test]
    fn picker_left_right_wraps_around_the_palette() {
        let mut app = App::new(String::new());
        app.palette = (0..3)
            .map(|i| PaletteColor {
                name: format!("color {i}"),
                fg: 31 + i as u8,
            })
            .collect();
        app.picker = Some(0);

        app.move_picker(1, 0);
        assert_eq!(app.picker, Some(1));
        app.move_picker(-1, 0);
        assert_eq!(app.picker, Some(0));
        app.move_picker(-1, 0);
        assert_eq!(app.picker, Some(2), "left from the first color wraps");
        app.move_picker(1, 0);
        assert_eq!(app.picker, Some(0), "right from the last color wraps");
    }
}
