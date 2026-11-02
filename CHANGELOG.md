# Changelog

## Unreleased

### Added

- A Claude Code mod in `mods/claude`: submit a prompt in Claude Code and the
  `place` client opens in a tmux pane to play while Claude works, then closes
  when the answer arrives. `/place` opens or closes it by hand; `PLACE_MOD_*`
  environment variables choose the client, server, split size, focus, and
  whether the game stays open after the answer.
- The repository is also a Claude Code plugin marketplace, so the mod installs
  with `claude plugin install place-tui@place`.
- A Pi extension in `mods/pi`, with the same behavior for the Pi coding agent:
  the pane opens when a run starts and closes when Pi settles. Install it with
  `pi install ./mods/pi`.

## 0.0.5

### Fixed

- The release workflow now creates the GitHub Release before the binary jobs
  upload assets. Previously every binary upload failed with `release not found`.
- Updated the macOS build runners to the current `macos-15` and
  `macos-15-intel` labels.
- Replaced `native-tls`/OpenSSL with `rustls` + `ring`, so the Linux musl
  cross-build no longer needs an OpenSSL installation.

### Changed

- The web map now fills the viewport, wraps infinitely, and supports drag-to-pan
  plus wheel/pinch zoom, with fixed title and stats overlays. Tiles default to a
  terminal-like 1.75:1 aspect ratio; override it with `?aspect=2`, for example,
  to match your terminal font.
- The site footer now has a **play now** modal with a one-line install command
  and a link to crates.io.
- The live map starts more zoomed out so a larger part of the world is visible.
- The site now uses the native system UI font, with monospace retained for
  code, and a simpler play modal.

### Compatibility

- Same client/server protocol as 0.0.4.

## 0.0.4

### Added

- A visual color picker: press `space` to open it, move the outline with the
  arrow keys / `wasd`, and press `enter` to choose a brush.
- Painting as you walk: once a brush is selected, every tile you move onto is
  painted with that color.
- Exact palette colors over the wire. `move` accepts an optional `color`, and
  `paint` accepts an optional `color` so clients no longer have to cycle.

### Changed

- `space` now opens the color picker instead of cycling the tile underfoot.
- Choosing a brush also paints the tile you're standing on.
- The picker renders twelve 6×3 color swatches in a 4×3 grid, with a bright
  outline around the selected swatch.

### Compatibility

- The 0.0.4 client requires a 0.0.4-or-newer `world-server`; deploy both from
  the same tag.
- Servers still accept legacy `paint` messages without a color and cycle the
  tile for older clients.
