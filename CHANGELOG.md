# Changelog

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
