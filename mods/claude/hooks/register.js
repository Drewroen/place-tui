/**
 * place — a Claude Code mod.
 *
 * A prompt is dead time: you send it, then watch a spinner. This mod hands that
 * time back. When you submit a prompt it splits the pane Claude runs in and
 * starts the `place` client there, connected to the shared map, so you can walk
 * around and paint while Claude works. When Claude finishes the answer the mod
 * closes the pane again and you are back on the prompt.
 *
 * The game is a real `place` client, not a redrawing of the map, so brush
 * colors, key repeat, other players and the cost of the connection behave
 * exactly as they do in a terminal. That also means it needs tmux: a mod has no
 * terminal of its own, and tmux is what can give the client a pty.
 *
 * Settings, all optional, read from the environment of the session:
 *   PLACE_MOD_BIN      client to run                 (default: place)
 *   PLACE_MOD_SERVER   server to connect to          (default: the client's own)
 *   PLACE_MOD_SIZE     split size                    (default: 40%)
 *   PLACE_MOD_FOCUS    "0" keeps the keys on Claude  (default: the game takes them)
 *   PLACE_MOD_KEEP     "1" leaves the pane open when the answer arrives
 *
 * `/place` opens the pane by hand, or closes the one already open.
 *
 * Plugin: mods/claude. Load it with `claude --plugin-dir mods/claude`.
 */
import {
  isPaneId,
  killArgs,
  listArgs,
  markArgs,
  markedPanes,
  splitArgs,
  titleArgs,
} from './pane.js';

// tmux calls are cheap, but a wedged tmux server must not hold the turn.
const TMUX_TIMEOUT_MS = 5_000;

/** The settings, as the session's environment holds them. */
async function readConfig($) {
  const focus = await $.env.get('PLACE_MOD_FOCUS');
  const keep = await $.env.get('PLACE_MOD_KEEP');
  return {
    bin: (await $.env.get('PLACE_MOD_BIN')) || 'place',
    server: (await $.env.get('PLACE_MOD_SERVER')) || '',
    size: (await $.env.get('PLACE_MOD_SIZE')) || '40%',
    // The game takes the keyboard unless asked not to: being dropped straight
    // into it is the point, and the prompt is empty while Claude works.
    focus: focus !== '0',
    keep: keep === '1',
  };
}

/** The pane Claude runs in, or null when this session isn't inside tmux. */
async function targetPane($) {
  const socket = await $.env.get('TMUX');
  const pane = await $.env.get('TMUX_PANE');
  return socket && pane ? pane : null;
}

/** Every pane this mod opened, as tmux lists them right now. */
async function panesOpen($) {
  const listed = await $.process.run(listArgs(), { timeoutMs: TMUX_TIMEOUT_MS });
  if (listed.exitCode !== 0) return [];
  return markedPanes(listed.stdout);
}

/** Run one tmux call, returning its result and never throwing. */
async function tmux($, argv) {
  try {
    return await $.process.run(argv, { timeoutMs: TMUX_TIMEOUT_MS });
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: String(error?.message ?? error) };
  }
}

/**
 * Make sure one game is open. tmux is the only record of what is open, so a
 * pane left by an earlier prompt or by a reloaded module is reused instead of
 * stacking a second game beside it.
 */
async function openPane($) {
  const target = await targetPane($);
  if (!target) return { pane: null, note: 'not running inside tmux' };

  const open = await panesOpen($);
  if (open.length > 0) return { pane: open[0], note: 'already open' };

  const config = await readConfig($);
  const split = await tmux($, splitArgs(target, config));
  const pane = split.stdout.trim();
  if (split.exitCode !== 0 || !isPaneId(pane)) {
    return { pane: null, note: split.stderr.trim() || 'tmux refused the split' };
  }

  // Marking and titling are cosmetic: the pane is playable without them, so a
  // failure here costs the cleanup, not the game.
  await tmux($, markArgs(pane));
  await tmux($, titleArgs(pane));
  return { pane, note: 'opened' };
}

/** Close every game this mod opened, wherever it kept it. */
async function closePanes($) {
  // Outside tmux this mod never opened anything, and a session that isn't in
  // tmux shouldn't pay for a tmux call on every answer.
  if (!(await targetPane($))) return [];
  const open = await panesOpen($);
  for (const pane of open) await tmux($, killArgs(pane));
  return open;
}

/** Is there a game open right now? */
async function isOpen($) {
  return (await panesOpen($)).length > 0;
}

/**
 * A prompt from the person is the moment the wait starts. Prompts a plugin or a
 * scheduled task sends don't open a game: nobody is waiting for those.
 */
async function onPrompt($, e, next) {
  if (e.source === undefined || e.source === 'user') {
    await openPane($).catch(() => null);
  }
  return next(e);
}

/**
 * Stop is the end of the wait, not of each model call: a turn that ends in a
 * tool call picks up again in a moment, so the game stays up through those.
 */
async function onStop($, e, next) {
  const keep = await readConfig($).then(
    (config) => config.keep,
    () => false,
  );
  if (!keep) await closePanes($).catch(() => null);
  return next(e);
}

/**
 * What both hooks above do when they fail: nothing, and let the event through.
 *
 * They sit on events that can block (a prompt, an answer), so a wedged tmux
 * server or a pane that vanished while the game ran must cost the game, not the
 * turn. Both hook bodies already swallow their own errors; this is the timeout
 * and the wrong-shape cases.
 */
const passOn = ($, e, next) => next(e);

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'place',
      description: 'Play on the shared place map while Claude works',
      argumentHint: '[off]',
      // Opening the game mid-turn is the whole point: without this, a /place
      // typed while Claude works waits for the turn to end.
      immediate: true,
    });
    return next(e);
  });

  on('classic.UserPromptSubmit', onPrompt).catch(passOn);
  on('classic.Stop', onStop).catch(passOn);

  on('command.run', { command: 'place' }, async ($, e) => {
    const wantsOff = e.args.trim().toLowerCase() === 'off';
    try {
      if (wantsOff || (await isOpen($))) {
        const closed = await closePanes($);
        if (closed.length === 0) return { text: 'No place pane is open.' };
        return { text: 'Closed the place pane.' };
      }

      const opened = await openPane($);
      if (!opened.pane) return { text: `Could not open place: ${opened.note}.` };
      if (opened.note === 'already open') {
        return { text: `place is already open in ${opened.pane}.` };
      }
      return { text: `Opened place in ${opened.pane}. Press Esc in the game to leave.` };
    } catch (error) {
      return { text: `place: ${String(error?.message ?? error)}` };
    }
  });
}
