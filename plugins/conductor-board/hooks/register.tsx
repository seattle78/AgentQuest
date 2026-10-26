import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardView, Live, Need, Task } from '../types'

// Live board for the conductor window. Session states come from the desktop session list and task
// progress from the conductor kit's own files every poll, so the rows cost no model call; what
// waits on the user needs judgment, so the conductor writes it to BOARD.json and the pane only
// reads it. The pane never writes a file.
const PANE = 'conductor-board'
// Relative to the session's working directory: the conductor window runs in the main checkout.
const BOARD = '.conductor/board/BOARD.json'
const CONFIG = '.conductor/config.json'
const REGISTRY = '.conductor/state/registry.json'
const WORKFLOW = '.conductor/state/workflow'
// Terminal mode: work sessions the kit started as tmux windows, and the state each one's hook records.
const TMUX_SESSIONS = '.conductor/state/tmux-sessions.json'
const SESSION_STATUS = '.conductor/sessions'
const POLL_MS = 20000
// How long a merged task stays under "released" before it leaves the board, and how many stay at most.
const RELEASED_MS = 24 * 60 * 60 * 1000
const RELEASED_MAX = 5

const LABELS = {
  en: {
    title: 'Board', needsYou: 'Waiting on you', working: 'Working', waitingOn: 'Waiting on other work',
    released: 'Released', queued: 'Queued', blocked: 'Blocked', ready: 'Ready to integrate',
    integrated: 'Integrated', promote: 'Awaiting release approval', parked: 'Parked',
    answered: '(answered?)', openChat: '↗ open chat', running: '● running', idle: 'idle',
    needsHeader: 'Needs an answer', check: 'Check: sessions not on the board', ranAfter: 'ran after the board update',
    runningNow: 'Running now', noneRunning: 'No session running', progress: 'Progress', note: 'note',
    waitsOn: 'Waits on:', recent: 'Recent activity', board: 'Board', polled: 'checked', every: 'refreshes every 20 s',
    lane: 'Integration lane', lastFetch: '(as of the last fetch)',
    dev: 'dev', tests: 'tests', commit: 'commit', done: 'done', left: 'left', fileWait: 'waiting for file owner',
    gatesPassed: 'gates passed, not integrated', integratedAt: 'integrated', verifyWait: 'awaiting combined verification',
    verified: 'verified', approvalWait: 'awaiting release approval', parkedAt: 'parked', releasedAt: 'released', status: 'status',
  },
  ko: {
    title: '현황판', needsYou: '내 응답 대기', working: '작업 중', waitingOn: '다른 작업 대기',
    released: '배포됨', queued: '예정', blocked: '막힘', ready: '통합 준비',
    integrated: '통합됨', promote: '배포 승인 대기', parked: '보류',
    answered: '(답변됨?)', openChat: '↗ 채팅 열기', running: '● 실행 중', idle: '쉬는 중',
    needsHeader: '답변이 필요한 것', check: '확인 필요: 보드에 없는 세션', ranAfter: '보드 갱신 뒤 실행됨',
    runningNow: '지금 실행 중', noneRunning: '실행 중인 세션 없음', progress: '진행 상황', note: '메모',
    waitsOn: '기다리는 작업:', recent: '최근 활동', board: '현황판', polled: '확인', every: '20초마다 갱신',
    lane: '통합 레인', lastFetch: '(마지막 fetch 기준)',
    dev: '개발', tests: '시험', commit: '커밋', done: '완료', left: '남음', fileWait: '파일 소유 대기',
    gatesPassed: 'Gate 통과, 통합 전', integratedAt: '통합', verifyWait: '통합 검증 대기',
    verified: '통합 검증 완료', approvalWait: '배포 승인 대기', parkedAt: '보류', releasedAt: '배포', status: '상태',
  },
} as const
type Lang = keyof typeof LABELS
const L = (lang: Lang) => LABELS[lang] ?? LABELS.en

const empty: BoardView = {
  needs: [],
  tasks: [],
  live: [],
  boardUpdated: '',
  polledAt: '',
  error: '',
  self: '',
  ran: [],
  ranSince: '',
  busy: [],
  releaseManager: '',
  integrationHead: '',
  deployHead: '',
  deployBranch: '',
  lang: 'en',
}
const view = atom({ plugin: 'conductor-board', key: 'view' } as const, empty)

// Progress groups, in reading order: what waits on the user first, queued work last.
const GROUPS = [
  { key: 'needsYou', color: 'warning', states: ['needs'] },
  { key: 'working', color: 'suggestion', states: ['working'] },
  { key: 'waitingOn', color: 'subtle', states: ['waiting_on'] },
  { key: 'released', color: 'success', states: ['released', 'done'] },
  { key: 'queued', color: 'subtle', states: ['queued', 'waiting'] },
] as const

/** Returns HH:MM (local) for an ISO time, or '' when absent. */
const hm = (iso: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '')

// Whether the pane can take the user to this session's chat on a surface. The desktop draws only
// https: links, so a press asks the app to show the chat instead, which it does only for a session
// the hosting session (`self`) started. Any other session gets no control rather than a dead one.
const reachable = (s: Live, surface: string, self: string) =>
  surface === 'terminal' ? s.link !== '' : surface === 'desktop' && self !== '' && s.startedBy === self

// No tool reports whether a session waits on the user, so the pane adds hints from what it saw:
// a session seen running since the board was written has probably moved on (answered?), and a
// session the conductor started that ran since then but is on no row may be waiting unseen (check).
/** Returns the session ids seen running since BOARD.json was written and the unlisted ones to check. */
function hints(v: BoardView) {
  const ran = new Set(v.ran)
  // The release manager runs on every integrate, so it counts as on the board even with no row.
  const onBoard = new Set([...v.needs, ...v.tasks].map(r => r.session).concat(v.releaseManager))
  const check = v.live.filter(
    s => v.self !== '' && s.startedBy === v.self && ran.has(s.id) && !s.isRunning && !onBoard.has(s.id),
  )
  return { ran, check }
}

/** The group label of a row's state, else its own label. */
const stateLabel = (t: Task, lang: Lang) => {
  const g = GROUPS.find(x => (x.states as readonly string[]).includes(t.state))
  return g ? L(lang)[g.key] : t.state_l ?? t.state
}

/**
 * The drawable items of a row's waits_on, each with the state of the other row it names: one whose
 * task or task_id is the item's task, or that task cut before " (" (the conductor adds notes so).
 */
function waits(t: Task, tasks: Task[], lang: Lang) {
  // A row written by hand can carry a malformed list; a throw here would blank the pane.
  if (!Array.isArray(t.waits_on)) return []
  return t.waits_on.flatMap(x => {
    if (!x || typeof x !== 'object') return []
    const name = String(x.task_l ?? x.task ?? '')
    if (name === '') return []
    const task = String(x.task ?? '')
    const keys = [task, task.split(' (')[0]].filter(k => k !== '')
    const named = tasks.find(o => o !== t && keys.some(k => k === o.task || k === o.task_id))
    return [{ session: x.session || undefined, text: named ? `${name} · ${stateLabel(named, lang)}` : name }]
  })
}

// ── Task rows from the session registry ──────────────────────────────────────

// Registry status to the board state; a status not listed is still shown under its own name.
const STATUS: Record<string, { state: string; label?: keyof (typeof LABELS)['en'] }> = {
  in_progress: { state: 'working' },
  queued: { state: 'queued' },
  integrated_pending_verification: { state: 'integrated', label: 'integrated' },
  ready_to_promote: { state: 'promote', label: 'promote' },
  parked: { state: 'parked', label: 'parked' },
  merged: { state: 'released' },
}
/** The board state of a registry status. */
const mapped = (status: string, lang: Lang) => {
  const m = STATUS[status]
  if (!m) return { state: status, state_l: status }
  return { state: m.state, state_l: m.label ? L(lang)[m.label] : undefined }
}

/** Returns MM-DD HH:MM (local) for an ISO time, or '' when absent. */
const mdhm = (iso: string) => {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`
}

/**
 * Whether a BOARD.json row names this registry task: its task_id when it has one; else "(task_id)"
 * in its text, or the task's integrated commit in its last line.
 */
const names = (r: { task: string; task_id?: string; last?: string; last_l?: string }, s: any) => {
  const id: string = s.task_id
  if (r.task_id !== undefined) return r.task_id === id
  const text = String(r.task ?? '')
  if (text.includes(`(${id})`)) return true
  const sha = String(s.integrated_commit ?? '').slice(0, 8)
  return sha.length === 8 && `${r.last ?? ''} ${r.last_l ?? ''}`.includes(sha)
}

/** The task's progress line, from its workflow-state file (gate source of truth) and its registry entry. */
function detail(s: any, w: any, lang: Lang) {
  const t = L(lang)
  const f = (k: string) => (w && k in w ? w[k] : s[k])
  if (s.status === 'in_progress') {
    const steps: [string, boolean][] = [
      [t.dev, f('dev_done') === true],
      [t.tests, f('tests_done') === true],
      ['G1', f('gate1') === 'approved'],
      ['G2', f('gate2') === 'approved'],
      [t.commit, s.committed === true],
    ]
    const done = steps.filter(x => x[1]).map(x => x[0])
    const left = steps.filter(x => !x[1]).map(x => x[0])
    return [done.length ? `${t.done} ${done.join('·')}` : '', left.length ? `${t.left} ${left.join('·')}` : ''].filter(Boolean).join(' · ')
  }
  if (s.status === 'queued') return t.fileWait
  if (s.status === 'integrated_pending_verification')
    return `${t.integratedAt} ${String(s.integrated_commit ?? '').slice(0, 8)} · ${t.verifyWait}`
  if (s.status === 'ready_to_promote')
    return `${t.verified} ${String(s.integration_verified_commit ?? s.integrated_commit ?? '').slice(0, 8)} · ${t.approvalWait}`
  if (s.status === 'parked') return `${t.parkedAt} ${mdhm(s.parked_at ?? '')}`
  if (s.status === 'merged') return `${t.releasedAt} ${mdhm(s.deployed_at ?? s.last_updated ?? '')}`
  return `${t.status} ${s.status} · ${mdhm(s.last_updated ?? '')}`
}

/**
 * One entry per task_id, the most recently created: `shown` holds every task not merged or
 * dropped, and the last RELEASED_MAX merged within RELEASED_MS; `gone` the rest.
 */
function current(registry: any, nowMs: number) {
  const latest = new Map<string, any>()
  for (const s of Object.values<any>(registry?.sessions ?? {})) {
    if (!s || typeof s.task_id !== 'string') continue
    const had = latest.get(s.task_id)
    if (!had || String(s.created ?? '') > String(had.created ?? '')) latest.set(s.task_id, s)
  }
  const at = (s: any) => String(s.deployed_at ?? s.last_updated ?? '')
  const open = [...latest.values()]
    .filter(s => s.status !== 'merged' && s.status !== 'dropped')
    .sort((a, b) => String(b.last_updated ?? '').localeCompare(String(a.last_updated ?? '')))
  const released = [...latest.values()]
    .filter(s => s.status === 'merged' && nowMs - Date.parse(at(s)) <= RELEASED_MS)
    .sort((a, b) => at(b).localeCompare(at(a)))
    .slice(0, RELEASED_MAX)
  const shown = [...open, ...released]
  return { shown, gone: [...latest.values()].filter(s => !shown.includes(s)) }
}

/**
 * Builds the progress rows: one live row per current registry task, with its chat, display name
 * and note from the BOARD.json row that names it, then the BOARD.json rows that name no registry
 * task, which keep the conductor's own state.
 */
function rows(entries: any[], gone: any[], workflow: Map<string, any>, needs: Need[], boardTasks: Task[], read: boolean, lang: Lang): Task[] {
  const used = new Set<Task>()
  const live = entries.map(s => {
    const free = boardTasks.filter(t => !used.has(t))
    const over = free.find(t => t.task === s.task_id) ?? free.find(t => names(t, s))
    if (over) used.add(over)
    const session = over?.session || undefined
    // A queued task the conductor marks waiting_on waits on other work, not only on its files.
    const waiting = over?.state === 'waiting_on' && s.status === 'queued'
    // Only a need moves a registry task: a conductor row's state is the part that goes stale.
    const asked = needs.some(n => names(n, s) || (!waiting && session !== undefined && n.session === session))
    const m = mapped(s.status, lang)
    const row: Task = {
      task: s.task_id,
      task_id: s.task_id,
      task_l: over?.task_l ?? over?.task ?? s.task_id,
      state: asked ? 'needs' : waiting ? 'waiting_on' : m.state,
      state_l: asked ? undefined : waiting ? over?.state_l : m.state_l,
      waits_on: waiting ? over?.waits_on : undefined,
      last: detail(s, workflow.get(s.task_id), lang),
      session,
      live: true,
      note: over?.last_l ?? over?.last,
    }
    return row
  })
  // A row naming a task the registry has finished with is stale, and only registry tasks
  // integrate, so a leftover integrated row is one the registry moved past.
  const stale = (t: Task) => read && (t.state === 'integrated' || gone.some(s => names(t, s)))
  return [...live, ...boardTasks.filter(t => !used.has(t) && !stale(t))]
}

/** Returns the commit a ref names, the loose ref file first since git writes it over packed-refs. */
async function ref($: any, name: string) {
  try {
    const loose = (await $.fs.read(`.git/${name}`)).trim()
    if (/^[0-9a-f]{40}$/.test(loose)) return loose
  } catch {}
  try {
    const line = (await $.fs.read('.git/packed-refs'))
      .split('\n')
      .find((l: string) => l.endsWith(` ${name}`) && /^[0-9a-f]{40} /.test(l))
    return line ? line.slice(0, 40) : ''
  } catch {
    return ''
  }
}

/**
 * The kit's tmux work sessions as session rows, for a surface without the desktop session list.
 * Running means the session's hook last saw it working; the title carries its state.
 */
async function tmuxSessions($: any): Promise<Live[]> {
  let reg: Record<string, any> = {}
  try {
    reg = JSON.parse(await $.fs.read(TMUX_SESSIONS))
  } catch {
    return []
  }
  const rows: Live[] = []
  for (const [name, s] of Object.entries<any>(reg ?? {})) {
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) continue
    let st: any = {}
    try {
      st = JSON.parse(await $.fs.read(`${SESSION_STATUS}/${name}.json`))
    } catch {}
    const state = String(st.state ?? 'unknown')
    rows.push({
      id: name,
      title: `${name} (${state === 'needs_you' ? 'needs you in its window' : state})`,
      isRunning: state === 'working',
      lastActivityAt: String(st.updated ?? s?.started_at ?? ''),
      link: '',
      startedBy: '',
    })
  }
  return rows.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

// The last registry that parsed: the session manager rewrites it while the pane polls, so one bad
// read keeps the rows rather than dropping them for 20 s.
let lastRegistry: any = null

/** Reads the config, BOARD.json, the registry, workflow state, git refs and the session list into the pane state. */
async function poll($: any) {
  const errors: string[] = []
  let config: any = {}
  try {
    config = JSON.parse(await $.fs.read(CONFIG))
  } catch {}
  const lang: Lang = config.board_language === 'ko' ? 'ko' : 'en'
  let board: any = null
  try {
    board = JSON.parse(await $.fs.read(BOARD))
  } catch {
    errors.push('BOARD.json unreadable')
  }
  let registry: any = lastRegistry
  try {
    const r = JSON.parse(await $.fs.read(REGISTRY))
    if (!r || typeof r.sessions !== 'object') throw new Error('no sessions')
    registry = lastRegistry = r
  } catch {
    errors.push('session registry unreadable')
  }
  const nowMs = await $.clock.now()
  const { shown: entries, gone } = registry ? current(registry, nowMs) : { shown: [] as any[], gone: [] as any[] }
  const workflow = new Map<string, any>()
  for (const s of entries) {
    // A task id names a file; anything that could leave the folder is not read.
    if (!/^[\w.-]+$/.test(s.task_id) || s.task_id.includes('..')) continue
    try {
      const w = JSON.parse(await $.fs.read(`${WORKFLOW}/${s.task_id}.json`))
      // A file left from an earlier run of the same task id would show that run's gates.
      if (!w.session_id || w.session_id === s.session_id) workflow.set(s.task_id, w)
    } catch {}
  }
  const integrationBranch = config.integration_branch ?? 'integration'
  const deployBranch = config.deploy_branch ?? 'main'
  const remote = config.remote ?? 'origin'
  const integrationHead = (await ref($, `refs/heads/${integrationBranch}`)).slice(0, 8)
  const deployHead = (await ref($, `refs/remotes/${remote}/${deployBranch}`)).slice(0, 8)
  let live: Live[] = []
  let listed = false
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 50 })
    const text = (r.content || []).map((b: any) => b.text || '').join('')
    live = JSON.parse(text).map((s: any) => ({
      id: s.sessionId ?? '',
      title: s.title,
      isRunning: !!s.isRunning,
      lastActivityAt: s.lastActivityAt,
      link: s.link ?? '',
      startedBy: s.startedBy ?? '',
    }))
    listed = true
  } catch {
    live = await tmuxSessions($)
    listed = live.length > 0
    if (!listed) errors.push('session list unavailable')
  }
  let self = ''
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    self = JSON.parse((r.content || []).map((b: any) => b.text || '').join('')).sessionId ?? ''
  } catch {
    errors.push('own session id unavailable')
  }
  const now = new Date(nowMs).toISOString()
  // Only a poll that sees isRunning counts as a run. The record restarts whenever the conductor
  // rewrites `updated`. Merged inside update so two overlapping polls cannot drop each other's ids.
  await update($, view, p => {
    const since = board ? (board.updated ?? '') : p.ranSince
    const fresh = since !== p.ranSince
    const running = listed ? live.filter(s => s.isRunning).map(s => s.id) : []
    // A turn already running when the board was rewritten began before it, so it counts only once
    // the pane has seen that session idle and running again.
    const busy = fresh ? running : listed ? p.busy.filter(id => running.includes(id)) : p.busy
    const seen = fresh ? [] : p.ran
    const ran = since === '' ? [] : [...new Set([...seen, ...running.filter(id => !busy.includes(id))])]
    return {
      needs: board?.needs ?? [],
      tasks: rows(entries, gone, workflow, board?.needs ?? [], board?.tasks ?? [], registry !== null, lang),
      live,
      boardUpdated: board?.updated ?? '',
      polledAt: now,
      error: errors.join('; '),
      self,
      ran,
      ranSince: since,
      busy,
      releaseManager: board ? (board.releaseManager ?? '') : p.releaseManager,
      integrationHead,
      deployHead,
      deployBranch,
      lang,
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Open the live conductor status board' })
    void poll($).then(async () => $.ui.open({ id: PANE, title: L((await read($, view)).lang).title }))
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await poll($)
    const v = await read($, view)
    await $.ui.open({ id: PANE, title: L(v.lang).title })
    const ids = new Set(v.live.filter(s => reachable(s, 'desktop', v.self)).map(s => s.id))
    const all = [...v.needs, ...v.tasks]
    const linked = all.filter(r => r.session && ids.has(r.session)).length
    const { ran, check } = hints(v)
    const asked = [...v.needs, ...v.tasks.filter(t => t.state === 'needs')]
    const answered = asked.filter(r => r.session && ran.has(r.session)).length
    const live = v.tasks.filter(t => t.live).length
    return {
      text: `Conductor board opened (${live} live rows from the session registry, chat links ${linked}/${all.length} rows, ${answered} answered?, ${check.length} to check, ${v.live.length} sessions${v.error ? `; ${v.error}` : ''}).`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const t = L(v.lang)
    const running = v.live.filter(s => s.isRunning)
    const byId = new Map(v.live.map(s => [s.id, s]))
    const { ran, check } = hints(v)
    // A hint, never a move: the row stays where BOARD.json put it until the conductor rebuilds.
    const answered = (session?: string) =>
      session !== undefined && ran.has(session) ? <Text color="subtle">{t.answered}</Text> : null
    // The app answers in text whether it showed the chat or why not, so every answer is toasted.
    const open = async (session: string) => {
      try {
        const r = await $.mcp.call('ccd_window', 'open_session_in', { session_id: session, target: 'focus' })
        const text = (r.content || []).map((b: any) => b.text || '').join('')
        if (text || r.isError) $.ui.toast(text || 'chat not opened')
      } catch (err) {
        $.ui.toast(`chat not opened: ${err}`)
      }
    }
    // A "go to chat" control: a Link on the terminal, a Button on the desktop, nothing when the
    // row names no session the list knows or the app cannot reach it. The key carries the session,
    // so a redraw between draw and press cannot aim it at another row's session.
    const go = (key: string, session?: string, label: string = t.openChat) => {
      const s = session ? byId.get(session) : undefined
      if (!s || !reachable(s, e.surface, v.self)) return null
      if (e.surface === 'desktop') return <Button key={`${key}-${s.id}`} label={label} onPress={() => open(s.id)} />
      return (
        <Text>
          <Link href={s.link} label={label} />
        </Text>
      )
    }
    const titled = (s: Live, key: string, dim = false) => go(key, s.id, s.title) ?? <Text dimColor={dim}>{s.title}</Text>
    const runs = (session?: string) => {
      const s = session ? byId.get(session) : undefined
      if (!s) return null
      return s.isRunning ? <Text color="success">{t.running}</Text> : <Text dimColor>{t.idle} {hm(s.lastActivityAt)}</Text>
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color="warning">
            {t.needsHeader} ({v.needs.length})
          </Text>
          {v.needs.map((n, i) => (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold>
                  {n.n}. {n.task_l ?? n.task}
                </Text>
                {answered(n.session)}
                {go(`need-${i}`, n.session)}
              </Box>
              <Text dimColor>{n.ask_l ?? n.ask}</Text>
            </Box>
          ))}
          {check.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="warning">
                {t.check} ({check.length})
              </Text>
              {check.map((s, i) => (
                <Box flexDirection="row" gap={1}>
                  {titled(s, `check-${i}`)}
                  <Text dimColor>{t.ranAfter}</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {t.runningNow} ({running.length})
          </Text>
          {running.length === 0 && <Text dimColor>{t.noneRunning}</Text>}
          {running.map((s, i) => (
            <Box flexDirection="row" gap={1}>
              <Text color="success">●</Text>
              {titled(s, `run-${i}`)}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{t.progress}</Text>
          {GROUPS.map(g => {
            const items = v.tasks.filter(x => (g.states as readonly string[]).includes(x.state))
            if (items.length === 0) return null
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={g.color}>
                  {t[g.key]} ({items.length})
                </Text>
                {items.map(x => {
                  const deps = x.state === 'waiting_on' ? waits(x, v.tasks, v.lang) : []
                  return (
                    <Box flexDirection="column" marginTop={1}>
                      <Box flexDirection="row" gap={1}>
                        <Text>
                          <Text color={g.color}>[{t[g.key]}]</Text> {x.task_l ?? x.task}
                        </Text>
                        {x.state === 'needs' && answered(x.session)}
                        {runs(x.session)}
                        {go(`task-${v.tasks.indexOf(x)}`, x.session)}
                      </Box>
                      <Text dimColor>{x.last_l ?? x.last}</Text>
                      {x.note && (
                        <Text dimColor>
                          {t.note} {hm(v.boardUpdated)}: {x.note}
                        </Text>
                      )}
                      {deps.length > 0 && (
                        <Box flexDirection="column">
                          <Text dimColor>{t.waitsOn}</Text>
                          {deps.map((d, j) => go(`wait-${v.tasks.indexOf(x)}-${j}`, d.session, d.text) ?? <Text>{d.text}</Text>)}
                        </Box>
                      )}
                    </Box>
                  )
                })}
              </Box>
            )
          })}
          {v.tasks
            .filter(x => !GROUPS.some(g => (g.states as readonly string[]).includes(x.state)))
            .map(x => (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>
                  [{x.state_l ?? x.state}] {x.task_l ?? x.task}
                  {(x.last_l ?? x.last) ? ` · ${x.last_l ?? x.last}` : ''}
                  {x.note ? ` · ${t.note} ${hm(v.boardUpdated)}: ${x.note}` : ''}
                </Text>
                {runs(x.session)}
                {go(`task-${v.tasks.indexOf(x)}`, x.session)}
              </Box>
            ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{t.recent}</Text>
          {v.live.slice(0, 8).map((s, i) => (
            <Box flexDirection="row" gap={1}>
              <Text dimColor={!s.isRunning}>
                {hm(s.lastActivityAt)} {s.isRunning ? t.running : t.idle}
              </Text>
              {titled(s, `recent-${i}`, !s.isRunning)}
            </Box>
          ))}
        </Box>
        <Text dimColor>
          {t.board} {hm(v.boardUpdated)} · {t.polled} {hm(v.polledAt)} · {t.every}
        </Text>
        {(v.integrationHead !== '' || v.deployHead !== '') && (
          <Text dimColor>
            {t.lane} {v.integrationHead || '?'}
            {v.deployBranch !== '' ? ` · ${v.deployBranch} ${v.deployHead || '?'}` : ''} {t.lastFetch}
          </Text>
        )}
        {v.error !== '' && <Text dimColor>({v.error})</Text>}
      </Box>
    )
  })
}
