/**
 * Tests for the place Pi extension.
 *
 * `node --test mods/pi/place.test.ts` — Node runs the TypeScript directly.
 * The tmux calls go to a private server, so nothing here touches the tmux you
 * are sitting in, and the client is a stand-in that just prints and waits.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import place, {
  closePanes,
  markedPanes,
  openPane,
  readConfig,
  splitArgs,
} from "./place.ts";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A tmux server of the test's own, inside a throwaway temp dir. */
function privateTmux(t) {
  if (!hasTmux) {
    t.skip("tmux is not installed");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "place-pi-"));
  const socket = join(dir, "sock");
  execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", "test", "-x", "120", "-y", "40", "bash --norc"]);
  t.after(() => execFileSync("tmux", ["-S", socket, "kill-server"]));

  // A stand-in for the place client: it says what it was handed, then idles.
  const bin = join(dir, "fake-place");
  writeFileSync(bin, '#!/usr/bin/env bash\necho "client $*"\nsleep 600\n');
  chmodSync(bin, 0o755);

  const host = execFileSync("tmux", ["-S", socket, "list-panes", "-t", "test", "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();

  process.env.TMUX = `${socket},1,0`;
  process.env.TMUX_PANE = host;
  process.env.PLACE_MOD_BIN = bin;
  delete process.env.PLACE_MOD_SERVER;
  delete process.env.PLACE_MOD_SIZE;
  delete process.env.PLACE_MOD_FOCUS;
  delete process.env.PLACE_MOD_KEEP;
  t.after(() => {
    for (const name of ["TMUX", "TMUX_PANE", "PLACE_MOD_BIN", "PLACE_MOD_SERVER", "PLACE_MOD_SIZE", "PLACE_MOD_FOCUS", "PLACE_MOD_KEEP"]) {
      delete process.env[name];
    }
  });

  const panes = () =>
    execFileSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id} #{@place_mod}"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

  return { socket, bin, host, panes };
}

/** A stand-in for Pi: it records what the extension registers and run tmux. */
function fakePi(socket) {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    async exec(command, args, options) {
      calls.push([command, ...args]);
      try {
        const stdout = execFileSync(command, ["-S", socket, ...args], {
          encoding: "utf8",
          timeout: options?.timeout,
        });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return {
          code: error.status ?? 1,
          stdout: error.stdout ?? "",
          stderr: String(error.stderr ?? error.message),
        };
      }
    },
  };
  return { pi, handlers, commands, calls };
}

test("the split argument list keeps its shape", () => {
  const config = readConfig({});
  assert.deepEqual(splitArgs("%1", config), [
    "split-window", "-t", "%1", "-l", "40%", "-P", "-F", "#{pane_id}", "place",
  ]);
  assert.equal(splitArgs("%1", readConfig({ PLACE_MOD_FOCUS: "0" }))[1], "-d");
  assert.equal(
    splitArgs("%1", readConfig({ PLACE_MOD_SERVER: "ws://localhost:8090" })).at(-1),
    "ws://localhost:8090",
  );
});

test("tmux list-panes output reads as the panes the extension marked", () => {
  assert.deepEqual(markedPanes("%1\t\n%7\t1\n%9\t1\n%11\t\n"), ["%7", "%9"]);
  assert.deepEqual(markedPanes(""), []);
});

test("a run opens the game and settling closes it", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  const { pi, handlers } = fakePi(tmux.socket);
  place(pi);

  await handlers.get("agent_start")();
  const open = tmux.panes();
  assert.equal(open.length, 2);
  assert.match(open[1], /^%\d+ 1$/);

  // The client got a pty, not a copy of Pi's output.
  const game = open[1].split(" ")[0];
  const screen = execFileSync("tmux", ["-S", tmux.socket, "capture-pane", "-p", "-t", game], { encoding: "utf8" });
  assert.match(screen, /client/);

  await handlers.get("agent_settled")();
  assert.equal(tmux.panes().length, 1);
});

test("a second run reuses the pane already open", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  const { pi, handlers, calls } = fakePi(tmux.socket);
  place(pi);

  await handlers.get("agent_start")();
  await handlers.get("agent_start")();

  assert.equal(calls.filter((argv) => argv[1] === "split-window").length, 1);
  assert.equal(tmux.panes().length, 2);
});

test("PLACE_MOD_KEEP=1 leaves the game up when the run settles", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  process.env.PLACE_MOD_KEEP = "1";
  const { pi, handlers } = fakePi(tmux.socket);
  place(pi);

  await handlers.get("agent_start")();
  await handlers.get("agent_settled")();

  assert.equal(tmux.panes().length, 2);
});

test("outside tmux nothing runs and nothing throws", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  delete process.env.TMUX;
  const { pi, handlers, calls } = fakePi(tmux.socket);
  place(pi);

  await handlers.get("agent_start")();
  await handlers.get("agent_settled")();

  assert.deepEqual(calls, []);
});

test("/place opens the game, then closes it", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  const { pi, commands } = fakePi(tmux.socket);
  place(pi);
  const notes = [];
  const ctx = { ui: { notify: (text) => notes.push(text) } };

  await commands.get("place").handler("", ctx);
  assert.match(notes.at(-1), /^Opened place in %\d+\./);
  assert.equal(tmux.panes().length, 2);

  await commands.get("place").handler("", ctx);
  assert.equal(notes.at(-1), "Closed the place pane.");
  assert.equal(tmux.panes().length, 1);
});

test("leaving Pi closes the game it opened", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  const { pi, handlers } = fakePi(tmux.socket);
  place(pi);

  await handlers.get("agent_start")();
  await handlers.get("session_shutdown")();
  assert.equal(tmux.panes().length, 1);
});

test("openPane and closePanes report what they did", async (t) => {
  const tmux = privateTmux(t);
  if (!tmux) return;
  const { pi } = fakePi(tmux.socket);

  const opened = await openPane(pi);
  assert.equal(opened.note, "opened");
  assert.equal((await openPane(pi)).note, "already open");
  assert.equal((await closePanes(pi)).length, 1);
  assert.equal((await closePanes(pi)).length, 0);
});
