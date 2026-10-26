import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'conductor-board',
  component: 'Pane',
  requestId: 'conductor-board',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// Tasks out of the reading order on purpose, plus a state no group takes.
const BOARD = {
  updated: '2026-10-20T12:00:00Z',
  needs: [{ n: 1, task: 'approve', ask: 'ship it?', session: 'local_a' }],
  tasks: [
    { task: 'q-task', state: 'queued', last: 'x' },
    { task: 'r-task', state: 'released', last: 'x' },
    { task: 'w-task', state: 'working', last: 'x', session: 'local_a' },
    { task: 'b-task', state: 'blocked', last: 'x' },
    { task: 'n-task', state: 'needs', last: 'x' },
    { task: 'o-task', state: 'waiting_on', last: 'x', waits_on: [{ task: 'w-task' }] },
  ],
}

const REGISTRY = {
  sessions: {
    s1: {
      task_id: 'live-task',
      status: 'in_progress',
      created: '2026-10-20T10:00:00Z',
      last_updated: '2026-10-20T11:00:00Z',
      dev_done: true,
      committed: false,
    },
  },
}

const SESSIONS = [
  {
    sessionId: 'local_a',
    title: 'Session A',
    isRunning: true,
    lastActivityAt: '2026-10-20T12:00:00Z',
    link: 'claude://example/local_a',
    startedBy: 'local_conductor',
  },
]

// Terminal mode: two tmux work sessions and the state each one's hook recorded.
const TMUX = { t1: { window_id: '@1', started_at: '2026-10-20T11:00:00Z' }, t2: { window_id: '@2', started_at: '2026-10-20T11:30:00Z' } }
const STATUS: Record<string, any> = {
  t1: { state: 'working', updated: '2026-10-20T11:59:00Z' },
  t2: { state: 'needs_you', updated: '2026-10-20T11:58:00Z' },
}

/**
 * Answers the engine calls the board makes; `config` is the .conductor/config.json body or null.
 * With `terminal`, the desktop session tools are missing and the tmux session files are there.
 */
function engine(on: any, config: any, terminal = false) {
  mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') } as any)
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_: any, e: any) => {
    if (e.path.endsWith('.conductor/board/BOARD.json')) return { value: JSON.stringify(BOARD) }
    if (e.path.endsWith('.conductor/state/registry.json')) return { value: JSON.stringify(REGISTRY) }
    if (e.path.endsWith('.conductor/config.json') && config) return { value: JSON.stringify(config) }
    if (terminal && e.path.endsWith('.conductor/state/tmux-sessions.json')) return { value: JSON.stringify(TMUX) }
    const m = /\.conductor\/sessions\/([\w.-]+)\.json$/.exec(e.path)
    if (terminal && m && STATUS[m[1]]) return { value: JSON.stringify(STATUS[m[1]]) }
    throw new Error('not found')
  })
  on('mcp.call', (_: any, e: any) => {
    if (terminal) throw new Error('no such server')
    if (e.tool === 'get_session') return { value: { content: [{ type: 'text', text: '{"sessionId":"local_conductor"}' }] } }
    if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text', text: JSON.stringify(SESSIONS) }] } }
    return { value: { content: [{ type: 'text', text: 'ok' }] } }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

/** Every Text node's text on a mounted pane. */
async function texts($: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface } as any)
  const out = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  await ui.unmount()
  return out
}

test('progress lists needs, working, waiting on other work, released, queued, then other states', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const all = (await texts($, surface)).filter(t => /-task/.test(t))
    const order = ['n-task', 'w-task', 'o-task', 'r-task', 'q-task', 'b-task'].map(name => all.findIndex(t => t.includes(name)))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  }
})

test('no config means English labels', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const all = await texts($, 'terminal')
  expect(all).toContain('Needs an answer (1)')
  expect(all).toContain('Queued (1)')
  expect(all.some(t => /[가-힣]/.test(t))).toBe(false)
})

test('board_language ko switches the labels', async ($, on) => {
  engine(on, { board_language: 'ko' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const all = await texts($, 'terminal')
  expect(all).toContain('예정 (1)')
  expect(all.some(t => t.includes('Needs an answer'))).toBe(false)
})

test('a registry task becomes a live working row with its progress line', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const all = await texts($, 'terminal')
  expect(all.some(t => t.includes('live-task'))).toBe(true)
  expect(all).toContain('done dev · left tests·G1·G2·commit')
})

test('the board command reports the live row count', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.command.run({ command: 'board' } as any)
  expect(String(r.text)).toContain('1 live rows from the session registry')
})

test('in a terminal, the tmux work sessions fill the session rows', async ($, on) => {
  engine(on, null, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const all = await texts($, 'terminal')
  expect(all).toContain('Running now (1)')
  expect(all.some(t => t.includes('t1 (working)'))).toBe(true)
  expect(all.some(t => t.includes('t2 (needs you in its window)'))).toBe(true)
  expect(all.some(t => t.includes('session list unavailable'))).toBe(false)
})
