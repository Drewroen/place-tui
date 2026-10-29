//! place — a shared-map terminal client.
//!
//! Connects to a `world-server`, draws a camera view of the wrapping 1024x1024
//! tile map (each tile is a single colored character cell), spawns you on a
//! random tile, and lets you walk with the arrow keys and repaint the tile under
//! you with the spacebar. You're a bold white dot; other players are bold green
//! dots.
//!
//! Install:
//!   cargo install place-tui                # from crates.io
//!   cargo install --path .                 # -> ~/.cargo/bin/place
//!   cargo install --path . --root ~/.local # -> ~/.local/bin/place

use std::collections::HashMap;
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
const READ_TIMEOUT_MS: u64 = 50;
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
  arrows / wasd   move around the map (wraps at the edges)
  space           cycle the color of the tile you're standing on
  q / esc         quit
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
    status: String,
    dirty: bool,
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
            status,
            dirty: true,
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
                    self.x = x;
                    self.y = y;
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

        self.ready = true;
        self.dirty = true;
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

fn write_frame(frame: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(frame.as_bytes());
    let _ = out.flush();
}

fn render(app: &App) {
    let (cols, rows) = terminal::size().unwrap_or((80, 24));
    let mut s = String::with_capacity((cols as usize + 16) * rows as usize);
    s.push_str("\x1b[H");

    if !app.ready {
        s.push_str("\x1b[2J\x1b[0m");
        s.push_str(&format!("  {}", app.status));
        s.push_str("\x1b[0m");
        write_frame(&s);
        return;
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

    let color_name = app
        .tile(app.x, app.y)
        .and_then(|c| app.palette.get(c as usize))
        .map(|c| c.name.as_str())
        .unwrap_or("?");
    let bar = format!(
        " place  ({}, {})  color: {}  online {}  |  arrows/wasd move  space paint  q quit ",
        app.x,
        app.y,
        color_name,
        app.players.len() + 1,
    );
    let bar: String = bar.chars().take(cols as usize).collect();
    let padded = format!("{:<width$}", bar, width = cols as usize);
    s.push_str("\x1b[7m");
    s.push_str(&padded);
    s.push_str("\x1b[0m");

    write_frame(&s);
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
            thread::sleep(Duration::from_millis(READ_TIMEOUT_MS));
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
    if !app.ready {
        return;
    }
    app.x = (app.x + dx).rem_euclid(app.width);
    app.y = (app.y + dy).rem_euclid(app.height);
    app.dirty = true;
    let _ = out.send(json!({ "type": "move", "dx": dx, "dy": dy }).to_string());
}

fn send_paint(app: &mut App, out: &Sender<String>) {
    if !app.ready {
        return;
    }
    if let Some(i) = app.index(app.x, app.y) {
        if !app.palette.is_empty() {
            if let Some(t) = app.tiles.get_mut(i) {
                *t = (*t + 1) % app.palette.len() as u8;
            }
        }
    }
    app.dirty = true;
    let _ = out.send(json!({ "type": "paint" }).to_string());
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
    render(&app);

    let mut running = true;
    while running {
        if event::poll(Duration::from_millis(16)).unwrap_or(false) {
            match event::read() {
                Ok(Event::Key(key))
                    if key.kind == KeyEventKind::Press || key.kind == KeyEventKind::Repeat =>
                {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => running = false,
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            running = false
                        }
                        KeyCode::Up | KeyCode::Char('w') | KeyCode::Char('k') => {
                            send_move(&mut app, 0, -1, &out_tx)
                        }
                        KeyCode::Down | KeyCode::Char('s') | KeyCode::Char('j') => {
                            send_move(&mut app, 0, 1, &out_tx)
                        }
                        KeyCode::Left | KeyCode::Char('a') | KeyCode::Char('h') => {
                            send_move(&mut app, -1, 0, &out_tx)
                        }
                        KeyCode::Right | KeyCode::Char('d') | KeyCode::Char('l') => {
                            send_move(&mut app, 1, 0, &out_tx)
                        }
                        KeyCode::Char(' ') => send_paint(&mut app, &out_tx),
                        _ => {}
                    }
                }
                Ok(Event::Resize(_, _)) => app.dirty = true,
                _ => {}
            }
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

        if app.dirty {
            render(&app);
            app.dirty = false;
        }
    }

    let _ = out_tx.send(QUIT_SENTINEL.to_string());
    drop(out_tx);
    drop(_term); // restore the terminal before joining
    let _ = net.join();
    println!("bye 👋");
}
