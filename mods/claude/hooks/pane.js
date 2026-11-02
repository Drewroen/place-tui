/**
 * The tmux side of the place mod.
 *
 * Everything here is a plain function: it builds the argument vectors the mod
 * hands to `$.process.run` and reads back what tmux printed. Nothing takes `$`,
 * so the mod's tests call these without a session, and `claude plugin validate`
 * finds every mods API call in `register.js`, where it lives.
 */

/** The tmux user option that marks the panes this mod opened. */
export const MARK = '@place_mod';

/** Is this a tmux pane id, such as `%7`? */
export function isPaneId(value) {
  return typeof value === 'string' && /^%\d+$/.test(value);
}

/**
 * Split the pane Claude runs in and print the new pane's id.
 *
 * `-d` leaves the keyboard on Claude's pane. The mod drops it when it wants the
 * game to have the keys as soon as the pane exists, so the first arrow press
 * already moves you.
 */
export function splitArgs(target, config) {
  const argv = ['tmux', 'split-window'];
  if (!config.focus) argv.push('-d');
  argv.push('-t', target, '-l', config.size, '-P', '-F', '#{pane_id}', config.bin);
  // The client defaults to the public server; pass ours only when it differs,
  // so `place` alone keeps working when the two ever drift.
  if (config.server) argv.push(config.server);
  return argv;
}

/** Stamp the new pane so a reloaded module (which forgets its pane) finds it. */
export function markArgs(pane) {
  return ['tmux', 'set-option', '-p', '-t', pane, MARK, '1'];
}

/** Give the pane a title, so the status bar can say what it is. */
export function titleArgs(pane) {
  return ['tmux', 'select-pane', '-t', pane, '-T', 'place'];
}

/** Every pane in every session, with the mark this mod stamps on its own. */
export function listArgs() {
  return ['tmux', 'list-panes', '-a', '-F', `#{pane_id}\t#{${MARK}}`];
}

/** Close one pane. */
export function killArgs(pane) {
  return ['tmux', 'kill-pane', '-t', pane];
}

/**
 * Read `list-panes` output into the pane ids this mod opened.
 *
 * A pane carries the mark as `1`; every other pane prints an empty column, and
 * tmux prints nothing at all for a format it can't expand.
 */
export function markedPanes(stdout) {
  const panes = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const [pane, mark] = line.split('\t');
    if (isPaneId(pane) && mark === '1') panes.push(pane);
  }
  return panes;
}
