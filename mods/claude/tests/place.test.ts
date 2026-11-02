import { expect, test } from 'claude-code/testing'
import { markedPanes, splitArgs } from '../hooks/pane.js'

// The tmux state a test's fake `process.run` keeps: the panes "the mod" opened.
function fakeTmux(on) {
  const opened: string[] = []
  const calls: string[][] = []
  const env: Record<string, string | undefined> = {
    TMUX: '/tmp/tmux-0/default,1,0',
    TMUX_PANE: '%1',
  }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('process.run', ($, e) => {
    const argv = e.argv as string[]
    calls.push(argv)
    if (argv[1] === 'list-panes') {
      const stdout = opened.map((pane) => `${pane}\t1`).join('\n')
      return { value: { exitCode: 0, stdout, stderr: '' } }
    }
    if (argv[1] === 'split-window') {
      opened.push('%7')
      return { value: { exitCode: 0, stdout: '%7\n', stderr: '' } }
    }
    if (argv[1] === 'kill-pane') {
      const pane = argv[argv.length - 1]
      const at = opened.indexOf(pane)
      if (at >= 0) opened.splice(at, 1)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // The two classic events the mod passes on with next(e)
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  return { opened, calls, env }
}

const PROMPT = { hook_event_name: 'UserPromptSubmit', prompt: 'add a color picker', source: 'user' }
const STOP = { hook_event_name: 'Stop', stop_hook_active: false }

test('a user prompt opens the game and the answer closes it', async ($, on) => {
  const tmux = fakeTmux(on)

  await $.classic.UserPromptSubmit(PROMPT)
  expect(tmux.opened).toEqual(['%7'])

  // The split takes the whole width below Claude, and starts the real client.
  const split = tmux.calls.find((argv) => argv[1] === 'split-window')!
  expect(split).toEqual([
    'tmux', 'split-window',
    '-t', '%1', '-l', '40%',
    '-P', '-F', '#{pane_id}', 'place',
  ])

  await $.classic.Stop(STOP)
  expect(tmux.opened).toEqual([])
})

test('a second prompt reuses the pane that is already open', async ($, on) => {
  const tmux = fakeTmux(on)

  await $.classic.UserPromptSubmit(PROMPT)
  await $.classic.UserPromptSubmit(PROMPT)

  const splits = tmux.calls.filter((argv) => argv[1] === 'split-window')
  expect(splits.length).toBe(1)
})

test('a turn that ends in a tool call leaves the game up', async ($, on) => {
  const tmux = fakeTmux(on)
  await $.classic.UserPromptSubmit(PROMPT)
  // Only Stop ends the wait; the model calling a tool raises no classic Stop.
  await $.classic.SubagentStop({ hook_event_name: 'SubagentStop', stop_hook_active: false })
  expect(tmux.opened).toEqual(['%7'])
})

test('PLACE_MOD_KEEP=1 leaves the pane open after the answer', async ($, on) => {
  const tmux = fakeTmux(on)
  tmux.env.PLACE_MOD_KEEP = '1'

  await $.classic.UserPromptSubmit(PROMPT)
  await $.classic.Stop(STOP)

  expect(tmux.opened).toEqual(['%7'])
})

test('PLACE_MOD_FOCUS=0 keeps the keyboard on Claude', async ($, on) => {
  const tmux = fakeTmux(on)
  tmux.env.PLACE_MOD_FOCUS = '0'

  await $.classic.UserPromptSubmit(PROMPT)

  const split = tmux.calls.find((argv) => argv[1] === 'split-window')!
  expect(split[2]).toBe('-d')
})

test('a server in PLACE_MOD_SERVER rides on the client command', async ($, on) => {
  const tmux = fakeTmux(on)
  tmux.env.PLACE_MOD_SERVER = 'ws://localhost:8090'

  await $.classic.UserPromptSubmit(PROMPT)

  const split = tmux.calls.find((argv) => argv[1] === 'split-window')!
  expect(split[split.length - 1]).toBe('ws://localhost:8090')
})

test('outside tmux nothing runs and nothing throws', async ($, on) => {
  const tmux = fakeTmux(on)
  delete tmux.env.TMUX

  await $.classic.UserPromptSubmit(PROMPT)
  await $.classic.Stop(STOP)

  expect(tmux.calls).toEqual([])
})

test('a prompt Claude Code sent itself opens nothing', async ($, on) => {
  const tmux = fakeTmux(on)
  await $.classic.UserPromptSubmit({ ...PROMPT, source: 'system' })
  expect(tmux.calls).toEqual([])
})

test('/place opens the game and closes it again', async ($, on) => {
  const tmux = fakeTmux(on)

  const opened = await $.command.run({ command: 'place', args: '' })
  expect(opened.text).toBe('Opened place in %7. Press Esc in the game to leave.')
  expect(tmux.opened).toEqual(['%7'])

  const closed = await $.command.run({ command: 'place', args: '' })
  expect(closed.text).toBe('Closed the place pane.')
  expect(tmux.opened).toEqual([])
})

test('the split argument list keeps its shape as it is built', () => {
  const config = { bin: 'place', server: '', size: '40%', focus: true }
  expect(splitArgs('%1', config)).toEqual([
    'tmux', 'split-window', '-t', '%1', '-l', '40%', '-P', '-F', '#{pane_id}', 'place',
  ])
  expect(splitArgs('%1', { ...config, focus: false })[2]).toBe('-d')
  expect(splitArgs('%1', { ...config, server: 'wss://example.dev' }).at(-1)).toBe('wss://example.dev')
})

test('tmux list-panes output reads as the panes the mod marked', () => {
  expect(markedPanes('%1\t\n%7\t1\n%9\t1\n%11\t\n')).toEqual(['%7', '%9'])
  expect(markedPanes('')).toEqual([])
})
