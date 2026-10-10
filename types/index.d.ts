export type FailedCheck = { name: string; url?: string }

export type Checks = { passed: number; failed: FailedCheck[]; pending: number; total: number }

export type CommentItem = {
  id: string
  author: string
  at: string
  kind: 'inline' | 'review' | 'comment'
  path?: string
  line?: number
  body: string
}

export type Snapshot = {
  title: string
  url: string
  branch: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  sha: string
  checks: Checks
  codex: 'none' | 'reviewing' | 'done'
  comments: CommentItem[]
}

export type WatchedPr = {
  key: string
  repo: string
  number: number
  isAuto: boolean
  snapshot?: Snapshot
  error?: string
  /** Comment ids the person marked seen (or handed off from the band). */
  seenIds: string[]
  /** Comment ids already announced; the first snapshot announces nothing. */
  notifiedIds: string[]
  /** Comment ids already handed to Claude. */
  handedIds: string[]
  /** `sha:failed names` of the last CI hand-off and the last CI verdict announced. */
  handedCiKey?: string
  notifiedCiKey?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-watch': { prs: WatchedPr[] }
  }
}
