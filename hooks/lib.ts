import type { Checks, CommentItem, Snapshot, WatchedPr } from '../types'

/** Bots whose comments are noise on every PR (link-backs, coverage reports). */
export const IGNORED_AUTHORS = new Set(['github-actions', 'linear-code', 'linear'])

const CODEX = 'chatgpt-codex-connector'
const CODEX_SUMMARY = 'codex-pull-request-review-summary'

export const DEFAULT_INSTRUCTIONS = {
  ci: "Investigate and fix: find the cause in the logs, fix it on the PR's branch (find its worktree with `git worktree list`) and commit. If it isn't caused by this PR (flake, main is red, infra), say so instead of changing code. Don't push without asking me.",
  comments:
    "Read each comment and assess it: valid, partly valid or not, with a one-line reason and the fix you'd make. Don't change code, push, reply on GitHub or resolve threads until I say which to act on.",
} as const

export function prUrlRef(text: string): { repo: string; number: number } | undefined {
  const m = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(text)

  return m ? { repo: m[1] as string, number: Number(m[2]) } : undefined
}

export function login(raw: string): string {
  return raw.replace(/\[bot\]$/, '')
}

type RollupItem = {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string | null
  createdAt?: string | null
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

/** Keeps the latest run of each check, so a green rerun replaces the red run it repeats. */
function latestRuns(rollup: RollupItem[]): RollupItem[] {
  const byName = new Map<string, RollupItem>()
  for (const c of rollup) {
    const name = `${c.workflowName ?? ''}/${c.name ?? c.context ?? '?'}`
    const prev = byName.get(name)
    const at = c.startedAt ?? c.createdAt ?? ''
    if (prev === undefined || at >= (prev.startedAt ?? prev.createdAt ?? '')) byName.set(name, c)
  }

  return [...byName.values()]
}

export function classifyChecks(rollup: RollupItem[]): Checks {
  const runs = latestRuns(rollup)
  const checks: Checks = { passed: 0, failed: [], pending: 0, total: runs.length }
  for (const c of runs) {
    const name = c.name ?? c.context ?? '?'
    const url = c.detailsUrl ?? c.targetUrl
    if (c.__typename === 'StatusContext') {
      if (c.state === 'PENDING' || c.state === 'EXPECTED') checks.pending++
      else if (FAILED.has(c.state ?? '')) checks.failed.push(url ? { name, url } : { name })
      else checks.passed++
    } else if (c.status !== 'COMPLETED') checks.pending++
    else if (FAILED.has(c.conclusion ?? '')) checks.failed.push(url ? { name, url } : { name })
    else checks.passed++
  }
  checks.failed.sort((a, b) => a.name.localeCompare(b.name))

  return checks
}

type ViewJson = {
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  headRefName: string
  headRefOid: string
  statusCheckRollup: RollupItem[] | null
  comments: { id: string; author: { login: string } | null; createdAt: string; body: string }[]
  reviews: { id: string; author: { login: string } | null; state: string; submittedAt: string | null; body: string }[]
}

type InlineJson = { id: number; u: string; t: string; p?: string; l?: number | null; b: string }

function clip(body: string): string {
  const flat = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[(P\d) Badge\]\([^)]*\)/g, '[$1]')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length > 300 ? flat.slice(0, 299) + '…' : flat
}

/** Turns `gh pr view --json` and the inline-comment lines into what the band shows; drops `me`, ignored bots and Codex's own summary. */
export function summarize(view: ViewJson, inlineLines: string, me: string): Snapshot {
  const isOther = (who: string) => who !== me && !IGNORED_AUTHORS.has(who)
  const comments: CommentItem[] = []
  let codex: Snapshot['codex'] = 'none'

  for (const c of view.comments) {
    const who = login(c.author?.login ?? 'ghost')
    if (c.body.includes(CODEX_SUMMARY)) {
      codex = /\*\*Completed\*\*/.test(c.body) ? 'done' : 'reviewing'
      continue
    }
    if (isOther(who)) comments.push({ id: c.id, author: who, at: c.createdAt, kind: 'comment', body: clip(c.body) })
  }
  for (const r of view.reviews) {
    const who = login(r.author?.login ?? 'ghost')
    if (r.submittedAt === null || who === CODEX || !isOther(who)) continue
    if (r.body.trim() === '' && r.state !== 'CHANGES_REQUESTED') continue
    const verdict = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'requested changes' : ''
    comments.push({ id: r.id, author: who, at: r.submittedAt, kind: 'review', body: clip([verdict, r.body].filter(Boolean).join(': ')) })
  }
  for (const line of inlineLines.split('\n')) {
    if (line.trim() === '') continue
    const c = JSON.parse(line) as InlineJson
    const who = login(c.u)
    if (!isOther(who)) continue
    comments.push({
      id: `inline-${c.id}`,
      author: who,
      at: c.t,
      kind: 'inline',
      ...(c.p ? { path: c.p } : {}),
      ...(typeof c.l === 'number' ? { line: c.l } : {}),
      body: clip(c.b),
    })
  }
  comments.sort((a, b) => a.at.localeCompare(b.at))

  return {
    title: view.title,
    url: view.url,
    branch: view.headRefName,
    state: view.state,
    isDraft: view.isDraft,
    sha: view.headRefOid,
    checks: classifyChecks(view.statusCheckRollup ?? []),
    codex,
    comments,
  }
}

export function unseen(pr: WatchedPr): CommentItem[] {
  return (pr.snapshot?.comments ?? []).filter(c => !pr.seenIds.includes(c.id))
}

function ciKey(s: Snapshot): string {
  return `${s.sha}:${s.checks.failed.map(f => f.name).join(',')}`
}

export type Decision = {
  notify: string[]
  handoff: { what: 'ci' | 'comments'; ids: string[] }[]
  patch: Partial<WatchedPr>
}

/**
 * What a fresh snapshot calls for, given what was already announced and handed off.
 * `isFirst`: the PR's first snapshot records the present as announced, so adding a PR is quiet.
 */
export function decide(pr: WatchedPr, isFirst: boolean): Decision {
  const s = pr.snapshot
  const out: Decision = { notify: [], handoff: [], patch: {} }
  if (s === undefined || s.state !== 'OPEN') return out

  const { checks } = s
  const isDone = checks.total > 0 && checks.pending === 0
  const key = ciKey(s)
  if (isDone && pr.notifiedCiKey !== key) {
    if (!isFirst) {
      out.notify.push(
        checks.failed.length > 0 ? `#${pr.number} checks failed: ${checks.failed.map(f => f.name).join(', ')}` : `#${pr.number} checks passed`,
      )
    }
    out.patch.notifiedCiKey = key
  }
  if (pr.isAuto && checks.failed.length > 0 && pr.handedCiKey !== key) {
    out.handoff.push({ what: 'ci', ids: [] })
    out.patch.handedCiKey = key
  }

  const fresh = unseen(pr)
  const toNotify = fresh.filter(c => !pr.notifiedIds.includes(c.id))
  if (toNotify.length > 0) {
    if (!isFirst) {
      const who = [...new Set(toNotify.map(c => c.author))].join(', ')
      out.notify.push(`#${pr.number}: ${toNotify.length} new comment(s) from ${who}`)
    }
    out.patch.notifiedIds = [...pr.notifiedIds, ...toNotify.map(c => c.id)]
  }
  const toHand = fresh.filter(c => !pr.handedIds.includes(c.id))
  if (pr.isAuto && toHand.length > 0) {
    out.handoff.push({ what: 'comments', ids: toHand.map(c => c.id) })
    out.patch.handedIds = [...pr.handedIds, ...toHand.map(c => c.id)]
  }

  return out
}

/** The prompt Claude receives for a failing PR, or for the comments `ids` names (all unseen ones when absent). */
export function handoffPrompt(pr: WatchedPr, what: 'ci' | 'comments', instructions: string, ids?: string[]): string {
  const s = pr.snapshot
  if (s === undefined) return ''
  const head = `PR #${pr.number} "${s.title}" (${s.url}, branch \`${s.branch}\`)`

  if (what === 'ci') {
    const lines = s.checks.failed.map(f => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`)

    return [
      `${head} has failing checks on ${s.sha.slice(0, 7)}:`,
      ...lines,
      '',
      `Logs: \`gh run view --repo ${pr.repo} --log-failed <run-id>\` (the run id is in each link).`,
      '',
      instructions,
    ].join('\n')
  }

  const items = unseen(pr)
    .filter(c => ids === undefined || ids.includes(c.id))
    .map(c => {
      const where = c.kind === 'inline' ? ` on ${c.path ?? '?'}${c.line ? `:${c.line}` : ''}` : c.kind === 'review' ? ' (review)' : ''

      return `- ${c.author}${where}: ${c.body}`
    })

  return [
    `${head} has new review comments:`,
    ...items,
    '',
    `Full text: \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\` (inline) and \`gh pr view ${pr.number} --repo ${pr.repo} --comments\`.`,
    '',
    instructions,
  ].join('\n')
}

/** The directory a shell command pushes from: the last `cd` (quoted or not) or `git -C` before the push. */
export function pushDir(command: string): string | undefined {
  const at = command.search(/\bgit\b(?:\s+-C\s+\S+)?\s+push\b/)
  if (at < 0) return undefined
  const before = command.slice(0, at + 40)
  const gitC = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))\s+push\b/.exec(before)
  if (gitC) return gitC[2] ?? gitC[3] ?? gitC[4]
  let dir: string | undefined
  for (const m of command.slice(0, at).matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/g)) dir = m[2] ?? m[3] ?? m[4]

  return dir
}

export function isPushCommand(command: string): boolean {
  return /(?:^|&&|;|\|\||\n)\s*(?:cd\s+\S+\s*&&\s*)*git(?:\s+-C\s+\S+)?\s+push\b/.test(command)
}
