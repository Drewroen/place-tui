/**
 * place — a Pi extension.
 *
 * A prompt is dead time: you send it, then watch it think. This extension hands
 * that time back. When a run starts it splits the pane Pi runs in and starts the
 * `place` client there, connected to the shared map, so you can walk around and
 * paint while Pi works. When the run settles the pane closes and you are back on
 * the prompt.
 *
 * The game is a real `place` client, not a redrawing of the map, so brush
 * colors, key repeat, painting as you walk and the other players behave exactly
 * as they do in a terminal. That also means it needs tmux: an extension has no
 * terminal of its own, and tmux is what can give the client a pty.
 *
 * Settings, all optional, read from Pi's environment:
 *   PLACE_MOD_BIN      client to run                 (default: place)
 *   PLACE_MOD_SERVER   server to connect to          (default: the client's own)
 *   PLACE_MOD_SIZE     split size                    (default: 40%)
 *   PLACE_MOD_FOCUS    "0" keeps the keys on Pi      (default: the game takes them)
 *   PLACE_MOD_KEEP     "1" leaves the pane open when the run settles
 *
 * `/place` opens the pane by hand, or closes the one already open.
 *
 * Install: copy this file to ~/.pi/agent/extensions/, or run Pi with
 * `pi -e mods/pi/place.ts`. Needs tmux 3.1 or later.
 *
 * The tmux helpers below repeat a little of mods/claude: a Claude Code mod may
 * only import from inside its own plugin directory, so the two can't share them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The tmux user option that marks the panes this extension opened. */
const MARK = "@place_mod";

// tmux calls are cheap, but a wedged tmux server must not hold a run.
const TMUX_TIMEOUT_MS = 5_000;

export type PlaceConfig = {
  bin: string;
  server: string;
  size: string;
  focus: boolean;
  keep: boolean;
};

/** The settings, as the environment Pi runs in holds them. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): PlaceConfig {
  return {
    bin: env.PLACE_MOD_BIN || "place",
    server: env.PLACE_MOD_SERVER || "",
    size: env.PLACE_MOD_SIZE || "40%",
    // The game takes the keyboard unless asked not to: being dropped straight
    // into it is the point, and the prompt is empty while Pi works.
    focus: env.PLACE_MOD_FOCUS !== "0",
    keep: env.PLACE_MOD_KEEP === "1",
  };
}

/** Is this a tmux pane id, such as `%7`? */
export function isPaneId(value: string): boolean {
  return /^%\d+$/.test(value);
}

/**
 * Split the pane Pi runs in and print the new pane's id.
 *
 * `-d` leaves the keyboard on Pi's pane. It is dropped when the game should
 * have the keys as soon as the pane exists, so the first arrow press already
 * moves you.
 */
export function splitArgs(target: string, config: PlaceConfig): string[] {
  const argv = ["split-window"];
  if (!config.focus) argv.push("-d");
  argv.push("-t", target, "-l", config.size, "-P", "-F", "#{pane_id}", config.bin);
  // The client defaults to the public server; pass ours only when it differs,
  // so `place` alone keeps working when the two ever drift.
  if (config.server) argv.push(config.server);
  return argv;
}

/** Every pane in every session, with the mark this extension stamps on its own. */
export function listArgs(): string[] {
  return ["list-panes", "-a", "-F", `#{pane_id}\t#{${MARK}}`];
}

/**
 * Read `list-panes` output into the pane ids this extension opened.
 *
 * A pane carries the mark as `1`; every other pane prints an empty column, and
 * tmux prints nothing at all for a format it can't expand.
 */
export function markedPanes(stdout: string): string[] {
  const panes: string[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    const [pane, mark] = line.split("\t");
    if (pane && isPaneId(pane) && mark === "1") panes.push(pane);
  }
  return panes;
}

type ExecResult = { code: number; stdout: string; stderr: string };

/** Run one tmux call, returning its result and never throwing. */
async function tmux(pi: ExtensionAPI, argv: string[]): Promise<ExecResult> {
  try {
    const result = await pi.exec("tmux", argv, { timeout: TMUX_TIMEOUT_MS });
    return {
      code: result.code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String((error as Error)?.message ?? error) };
  }
}

/** The pane Pi runs in, or null when this run isn't inside tmux. */
function targetPane(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.TMUX && env.TMUX_PANE ? env.TMUX_PANE : null;
}

/** Every pane this extension opened, as tmux lists them right now. */
async function panesOpen(pi: ExtensionAPI): Promise<string[]> {
  const listed = await tmux(pi, listArgs());
  return listed.code === 0 ? markedPanes(listed.stdout) : [];
}

/**
 * Make sure one game is open. tmux is the only record of what is open, so a
 * pane left by an earlier run or by a reload of the extension is reused instead
 * of stacking a second game beside it.
 */
export async function openPane(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ pane: string | null; note: string }> {
  const target = targetPane(env);
  if (!target) return { pane: null, note: "not running inside tmux" };

  const open = await panesOpen(pi);
  if (open.length > 0) return { pane: open[0], note: "already open" };

  const split = await tmux(pi, splitArgs(target, readConfig(env)));
  const pane = split.stdout.trim();
  if (split.code !== 0 || !isPaneId(pane)) {
    return { pane: null, note: split.stderr.trim() || "tmux refused the split" };
  }

  // Marking and titling are cosmetic: the pane is playable without them, so a
  // failure here costs the cleanup, not the game.
  await tmux(pi, ["set-option", "-p", "-t", pane, MARK, "1"]);
  await tmux(pi, ["select-pane", "-t", pane, "-T", "place"]);
  return { pane, note: "opened" };
}

/** Close every game this extension opened. */
export async function closePanes(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  // Outside tmux this extension never opened anything, and a run without tmux
  // shouldn't pay for a tmux call on every settle.
  if (!targetPane(env)) return [];
  const open = await panesOpen(pi);
  for (const pane of open) await tmux(pi, ["kill-pane", "-t", pane]);
  return open;
}

export default function (pi: ExtensionAPI) {
  // A run is the wait: open the game when Pi starts working on one.
  pi.on("agent_start", async () => {
    await openPane(pi).catch(() => null);
  });

  // `agent_settled` is the final idle signal, not `agent_end`: that one also
  // fires before a retry, a compaction retry or a queued follow-up, and the
  // game should stay up through those.
  pi.on("agent_settled", async () => {
    if (readConfig().keep) return;
    await closePanes(pi).catch(() => null);
  });

  // Leaving Pi shouldn't leave a game behind in a pane nobody owns any more.
  pi.on("session_shutdown", async () => {
    await closePanes(pi).catch(() => null);
  });

  pi.registerCommand("place", {
    description: "Play on the shared place map while Pi works",
    handler: async (args, ctx) => {
      const wantsOff = args.trim().toLowerCase() === "off";
      try {
        if (wantsOff || (await panesOpen(pi)).length > 0) {
          const closed = await closePanes(pi);
          ctx.ui.notify(closed.length > 0 ? "Closed the place pane." : "No place pane is open.", "info");
          return;
        }

        const opened = await openPane(pi);
        if (!opened.pane) {
          ctx.ui.notify(`Could not open place: ${opened.note}.`, "warning");
          return;
        }
        if (opened.note === "already open") {
          ctx.ui.notify(`place is already open in ${opened.pane}.`, "info");
          return;
        }
        ctx.ui.notify(`Opened place in ${opened.pane}. Press Esc in the game to leave.`, "info");
      } catch (error) {
        ctx.ui.notify(`place: ${String((error as Error)?.message ?? error)}`, "error");
      }
    },
  });
}
