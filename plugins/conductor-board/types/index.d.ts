// task_id ties a BOARD.json row to its session registry task (the row's text may say "(task_id)" instead).
// The *_l fields are optional display text in the board language.
export type Need = { n: number; task: string; ask: string; task_l?: string; ask_l?: string; session?: string; task_id?: string }
// One thing a waiting_on task waits on; session is '' when it is the user or has no chat.
export type WaitsOn = { task: string; session?: string; task_l?: string }
export type Task = {
  task: string
  state: string
  last: string
  task_l?: string
  last_l?: string
  state_l?: string
  session?: string
  task_id?: string
  waits_on?: WaitsOn[]
  // Set on rows the pane built from the session registry; note is the conductor's last line for it.
  live?: boolean
  note?: string
}
export type Live = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: string
  link: string
  startedBy: string
}
export type BoardView = {
  needs: Need[]
  tasks: Task[]
  live: Live[]
  boardUpdated: string
  polledAt: string
  error: string
  self: string
  ran: string[]
  ranSince: string
  busy: string[]
  releaseManager: string
  // Short SHAs of the integration lane and the fetched deploy ref, '' when unreadable.
  integrationHead: string
  deployHead: string
  deployBranch: string
  lang: 'en' | 'ko'
}

declare module 'claude-code' {
  interface PluginState {
    'conductor-board': { view: BoardView }
  }
}
