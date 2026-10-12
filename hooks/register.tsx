import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WatchedPr } from '../types'
import { DEFAULT_INSTRUCTIONS, decide, handoffPrompt, isPushCommand, prUrlRef, pushDir, summarize, unseen } from './lib'
import type { Decision } from './lib'

const POLL_MS = 60_000
const INSTRUCTIONS_KEY = { ci: 'instructions.ci', comments: 'instructions.comments' } as const

const prs = atom({ plugin: 'pr-watch', key: 'prs' } as const, [])

type $ = EngineInterface

type GhResult = { ok: boolean; out: string; err: string; isAborted?: true }

async function gh($: $, argv: string[], cwd?: string): Promise<GhResult> {
  try {
    const r = await $.process.run(['gh', ...argv], { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 })

    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr.trim() }
  } catch (error) {
    const err = String(error)

    return /aborted/i.test(err) ? { ok: false, out: '', err, isAborted: true } : { ok: false, out: '', err }
  }
}

let me: string | undefined
let poller: Timer | undefined
let drainer: Timer | undefined

// Work that outlives a hook's dispatch is queued here and run by a timer started in
// session.start, since a call made on a hook's own $ is aborted once that dispatch ends.
type Job = { kind: 'watch'; ref: string; cwd: string } | { kind: 'refresh'; key: string }
const jobs: Job[] = []

async function drain($: $): Promise<void> {
  for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
    if (job.kind === 'watch') await watch($, job.ref, job.cwd).catch(() => undefined)
    else await refresh($, job.key).catch(() => undefined)
  }
}
const inflight = new Map<string, Promise<void>>()

/** The person's GitHub login; null when the lookup was aborted, undefined when gh is not logged in. */
async function whoami($: $): Promise<string | undefined | null> {
  if (me === undefined) {
    const r = await gh($, ['api', 'user', '--jq', '.login'])
    if (r.isAborted) return null
    if (r.ok && r.out.trim() !== '') me = r.out.trim()
  }

  return me
}

async function instructions($: $, what: 'ci' | 'comments'): Promise<string> {
  const saved = await $.store.get(INSTRUCTIONS_KEY[what])

  return typeof saved === 'string' && saved !== '' ? saved : DEFAULT_INSTRUCTIONS[what]
}

async function setError($: $, key: string, error: string): Promise<void> {
  await update($, prs, list => list.map(p => (p.key === key ? { ...p, error } : p)))
}

/** Resolves a URL, a number or nothing (the current branch's PR) to a repo and number. */
async function resolve($: $, ref: string, cwd: string): Promise<{ repo: string; number: number } | string> {
  const fromUrl = prUrlRef(ref)
  if (fromUrl) return fromUrl
  const argv = ['pr', 'view', ...(ref.trim() === '' ? [] : [ref.trim().replace(/^#/, '')]), '--json', 'url', '--jq', '.url']
  const r = await gh($, argv, cwd)
  const found = r.ok ? prUrlRef(r.out) : undefined

  return found ?? (r.err || `No PR found for "${ref || 'this branch'}"`)
}

/** One refresh per PR at a time: a second caller waits for the one running. */
function refresh($: $, key: string): Promise<void> {
  const running = inflight.get(key)
  if (running) return running
  const run = doRefresh($, key).finally(() => inflight.delete(key))
  inflight.set(key, run)

  return run
}

async function doRefresh($: $, key: string): Promise<void> {
  const pr = (await read($, prs)).find(p => p.key === key)
  if (pr === undefined) return
  const login = await whoami($)
  if (login === null) return
  if (login === undefined) return setError($, key, 'gh is not logged in (gh auth status)')

  const fields = 'title,url,state,isDraft,headRefName,headRefOid,statusCheckRollup,comments,reviews'
  const view = await gh($, ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', fields])
  if (view.isAborted) return
  if (!view.ok) return setError($, key, view.err || 'gh pr view failed')
  const inline = await gh($, [
    'api',
    `repos/${pr.repo}/pulls/${pr.number}/comments`,
    '--paginate',
    '--jq',
    '.[]|{id,u:.user.login,t:.created_at,p:.path,l:(.line // .original_line),b:.body}',
  ])

  if (inline.isAborted) return
  let snapshot: ReturnType<typeof summarize>
  try {
    snapshot = summarize(JSON.parse(view.out), inline.ok ? inline.out : '', login)
  } catch (error) {
    return setError($, key, `could not read gh output: ${String(error)}`)
  }
  const error = inline.ok ? undefined : `inline comments unavailable: ${inline.err}`

  let decision: Decision = { notify: [], handoff: [], patch: {} }
  let current: WatchedPr | undefined
  await update($, prs, list =>
    list.map(p => {
      if (p.key !== key) return p
      const isFirst = p.snapshot === undefined
      const prior = p.snapshot?.comments.filter(c => c.kind === 'inline') ?? []
      const comments = inline.ok ? snapshot.comments : [...snapshot.comments, ...prior]
      const { error: _old, ...rest } = p
      const next: WatchedPr = { ...rest, snapshot: { ...snapshot, comments }, ...(error ? { error } : {}) }
      decision = decide(next, isFirst)
      current = { ...next, ...decision.patch }

      return current
    }),
  )

  for (const text of decision.notify) {
    $.ui.toast(text)
    void $.ui.notify(text, { title: 'PR watch' })
  }
  for (const h of decision.handoff) {
    if (current === undefined) break
    await $.prompt.submit({ text: handoffPrompt(current, h.what, await instructions($, h.what), h.ids) })
  }
}

async function pollAll($: $): Promise<void> {
  for (const pr of await read($, prs)) {
    if (pr.snapshot !== undefined && pr.snapshot.state !== 'OPEN') continue
    try {
      await refresh($, pr.key)
    } catch (error) {
      await setError($, pr.key, String(error))
    }
  }
}

async function watch($: $, ref: string, cwd: string): Promise<string> {
  const target = await resolve($, ref, cwd)
  if (typeof target === 'string') return target
  const key = `${target.repo}#${target.number}`
  await update($, prs, list =>
    list.some(p => p.key === key)
      ? list
      : [...list, { key, repo: target.repo, number: target.number, isAuto: false, seenIds: [], notifiedIds: [], handedIds: [] }],
  )
  await refresh($, key)

  return `Watching ${key}`
}

async function setAuto($: $, which: string, isOn: boolean): Promise<void> {
  const match = (p: WatchedPr) => which === 'all' || p.key === which || String(p.number) === which.replace(/^#/, '')
  await update($, prs, list => list.map(p => (match(p) ? { ...p, isAuto: isOn } : p)))
  if (isOn) for (const p of (await read($, prs)).filter(match)) jobs.push({ kind: 'refresh', key: p.key })
}

async function handOff($: $, key: string, what: 'ci' | 'comments'): Promise<void> {
  const pr = (await read($, prs)).find(p => p.key === key)
  const s = pr?.snapshot
  if (pr === undefined || s === undefined) return
  const ids = unseen(pr).map(c => c.id)
  await $.prompt.submit({ text: handoffPrompt(pr, what, await instructions($, what), what === 'comments' ? ids : undefined) })
  await update($, prs, list =>
    list.map(p => {
      if (p.key !== key) return p
      if (what === 'ci') return { ...p, handedCiKey: `${s.sha}:${s.checks.failed.map(f => f.name).join(',')}` }

      return { ...p, handedIds: [...new Set([...p.handedIds, ...ids])], seenIds: [...new Set([...p.seenIds, ...ids])] }
    }),
  )
}

async function markSeen($: $, key: string): Promise<void> {
  await update($, prs, list =>
    list.map(p => (p.key === key ? { ...p, seenIds: [...new Set([...p.seenIds, ...(p.snapshot?.comments ?? []).map(c => c.id)])] } : p)),
  )
}

function fit(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

async function openUrl($: $, url: string): Promise<void> {
  const opened = await $.process.run(['open', url]).catch(() => undefined)
  if (opened?.exitCode !== 0) await $.process.run(['xdg-open', url]).catch(() => undefined)
}

const EMOJI = /[❌⏳✅💬📨🔧🔍👍]/gu

/** Terminal cells a line takes: the emoji the panel draws are two cells wide. */
function cells(text: string): number {
  return [...text].length + (text.match(EMOJI)?.length ?? 0)
}

/** The widest line a PR's two rows want, so the panel can fit its content. */
function rowCells(pr: WatchedPr): number {
  const s = pr.snapshot
  const title = cells(`#${pr.number}${s?.isDraft ? ' draft' : ''} ${s?.title ?? pr.error ?? 'loading…'} ×`)
  if (s === undefined) return title
  const c = s.checks
  const fresh = unseen(pr)
  const isOpen = s.state === 'OPEN'
  const parts = [
    !isOpen && s.state.toLowerCase(),
    isOpen && c.failed.length > 0 && `❌ ${c.failed.length} ${c.failed.map(f => f.name).join(', ')}`,
    isOpen && c.failed.length > 0 && ' 🔧 fix ',
    isOpen && c.pending > 0 && `⏳ ${c.pending}`,
    isOpen && c.failed.length === 0 && c.pending === 0 && c.total > 0 && `✅ ${c.passed}`,
    isOpen && c.total === 0 && 'no checks',
    fresh.length > 0 && `💬 ${fresh.length} (${[...new Set(fresh.map(x => x.author.replace('chatgpt-codex-connector', 'codex')))].join(', ')})`,
    fresh.length > 0 && ' 📨 assess ',
    fresh.length > 0 && 'dismiss',
    s.codex === 'reviewing' && '🔍 codex',
    s.codex === 'done' && fresh.length === 0 && 'codex 👍',
    pr.error && `⚠ ${pr.error}`,
    isOpen && 'auto off',
  ].filter((x): x is string => typeof x === 'string')

  return Math.max(title, parts.reduce((n, x) => n + cells(x), 0) + 2 * parts.length)
}

function summaryText(list: WatchedPr[]): string | undefined {
  if (list.length === 0) return undefined
  const open = list.filter(p => p.snapshot?.state === 'OPEN')
  const count = (fn: (c: WatchedPr['snapshot'] & object) => boolean) => open.filter(p => p.snapshot !== undefined && fn(p.snapshot)).length
  const failing = count(s => s.checks.failed.length > 0)
  const running = count(s => s.checks.failed.length === 0 && s.checks.pending > 0)
  const passing = count(s => s.checks.failed.length === 0 && s.checks.pending === 0 && s.checks.total > 0)
  const comments = list.reduce((n, p) => n + unseen(p).length, 0)
  const parts = [failing > 0 && `❌ ${failing}`, running > 0 && `⏳ ${running}`, comments > 0 && `💬 ${comments}`, passing > 0 && `✅ ${passing}`].filter(Boolean)

  return `PRs ${parts.join(' ')}`
}

async function unwatch($: $, which: string): Promise<void> {
  await update($, prs, list => list.filter(p => p.key !== which && String(p.number) !== which.replace(/^#/, '')))
}

function statusText(list: WatchedPr[]): string {
  if (list.length === 0) return 'Not watching any PRs. /pr-watch add <url|number>, or open one with gh pr create.'

  return list
    .map(p => {
      const s = p.snapshot
      if (s === undefined) return `#${p.number} ${p.error ?? 'loading'}`
      const c = s.checks
      const error = p.error ? ` · ${p.error}` : ''

      return `#${p.number} ${s.title} · ${c.failed.length} failed, ${c.pending} running, ${c.passed} passed · ${unseen(p).length} new comments${p.isAuto ? ' · auto' : ''}${error}`
    })
    .join('\n')
}

const HELP = '/pr-watch [add <url|number> | rm <number> | auto <number|all> on|off | prompt ci|comments [text|default] | refresh]'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pr-watch', description: 'Watch PR checks and review comments in a band', argumentHint: HELP })
    await $.tool.register({
      name: 'watch_pr',
      description:
        "Add a pull request to the user's PR watch band, which tracks its CI checks and review comments (Codex included) and can hand failures back. Use after opening or pushing a PR the user will want to follow. pr: a PR URL, a number, or empty for the current branch's PR in cwd.",
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'string', description: 'PR URL or number; empty for the current branch.' },
          cwd: { type: 'string', description: 'Repository or worktree directory for a number or empty pr.' },
        },
      },
      isDeferred: false,
    })
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => void pollAll($))
    drainer?.cancel()
    drainer = $.clock.every(1000, () => void drain($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = undefined
    drainer?.cancel()
    drainer = undefined
    jobs.length = 0
    if (e.reason === 'clear') await update($, prs, () => [])

    return next(e)
  })

  on('command.run', { command: 'pr-watch' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(t => t !== '')
    const cwd = await $.session.cwd()

    if (verb === '' || verb === 'status') return { text: statusText(await read($, prs)) }
    if (verb === 'add') return { text: await watch($, rest.join(' '), cwd) }
    if (verb === 'rm' && rest[0]) {
      await unwatch($, rest[0])

      return { text: `Stopped watching ${rest[0]}` }
    }
    if (verb === 'auto' && rest[0] && (rest[1] === 'on' || rest[1] === 'off')) {
      await setAuto($, rest[0], rest[1] === 'on')

      return { text: `Auto hand-off ${rest[1]} for ${rest[0]}` }
    }
    if (verb === 'prompt') {
      const what = rest[0]
      if (what !== 'ci' && what !== 'comments') {
        return {
          text: `Failing checks:\n${await instructions($, 'ci')}\n\nComments:\n${await instructions($, 'comments')}\n\nChange with /pr-watch prompt ci|comments <text|default>`,
        }
      }
      const text = rest.slice(1).join(' ')
      if (text !== '') await $.store.set(INSTRUCTIONS_KEY[what], text === 'default' ? '' : text)

      return { text: `Hand-off instructions for ${what === 'ci' ? 'failing checks' : 'comments'}:\n${await instructions($, what)}` }
    }
    if (verb === 'refresh') {
      await pollAll($)

      return { text: statusText(await read($, prs)) }
    }

    return { text: HELP }
  })

  on('tool.call', { tool: 'mcp__pr-watch__watch_pr' }, async ($, e) => {
    const ref = typeof e.pr === 'string' ? e.pr : ''
    const cwd = typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : await $.session.cwd()

    return { result: await watch($, ref, cwd) }
  }).catch(() => ({ result: 'pr-watch could not add the PR; the user can run /pr-watch add <url>.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = e.command
    const isCreate = /\bgh pr create\b/.test(command)
    const isPush = isPushCommand(command)
    if (ran.deny !== undefined || e.run_in_background === true || (!isCreate && !isPush)) return ran

    const out = ran.result as { stdout?: string; stderr?: string } | undefined
    const created = isCreate ? prUrlRef(`${out?.stdout ?? ''}\n${out?.stderr ?? ''}`) : undefined
    if (isCreate && created === undefined && !isPush) return ran
    const cwd = pushDir(command) ?? (await $.session.cwd())
    const ref = created ? `https://github.com/${created.repo}/pull/${created.number}` : ''
    // Watching runs gh several times; a timer keeps that off the tool result the model waits on.
    jobs.push({ kind: 'watch', ref, cwd })

    return ran
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const summary = summaryText(await read($, prs))
    if (summary === undefined) return next(e)
    const tail = [e.props.tail, `${summary} · ctrl+x ctrl+a`].filter(Boolean).join('  ')

    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The panel fits its widest row; the band's own [-] (ctrl+x ctrl+a) collapses it.
    const boxWidth = Math.min(e.props.bodyColumns, Math.max(...list.map(rowCells)) + 4)
    const width = boxWidth - 4

    return (
      <Box flexDirection="column" alignItems="flex-start">
        <Box flexDirection="column" width={boxWidth} borderStyle="round" borderDimColor paddingX={1}>
          {list.map((pr, index) => {
            const s = pr.snapshot
            const fresh = unseen(pr)
            const c = s?.checks
            const isOpen = s?.state === 'OPEN'
            const authors = [...new Set(fresh.map(x => x.author.replace('chatgpt-codex-connector', 'codex')))].join(', ')

            return (
              <Box key={pr.key} flexDirection="column">
                {index > 0 && <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>}
                <Box flexDirection="row" gap={1}>
                  <Box flexShrink={1} flexGrow={1}>
                    {s === undefined ? (
                      <Text wrap="truncate-end">
                        <Text bold>#{pr.number}</Text> <Text dimColor>{pr.error ?? 'loading…'}</Text>
                      </Text>
                    ) : (
                      <Button key={`${pr.key}:open`} plain onPress={() => openUrl($, s.url)}>
                        <Text bold hover={{ color: 'suggestion' }}>
                          #{pr.number}
                        </Text>
                        {s.isDraft ? <Text dimColor> draft</Text> : ''}
                        <Text hover={{ color: 'suggestion' }}>{` ${fit(s.title, width - 10 - String(pr.number).length - (s.isDraft ? 6 : 0))}`}</Text>
                      </Button>
                    )}
                  </Box>
                  <Button key={`${pr.key}:rm`} plain onPress={() => unwatch($, pr.key)}>
                    <Text dimColor hover={{ color: 'text', dimColor: false }}>
                      ×
                    </Text>
                  </Button>
                </Box>
                {s !== undefined && c !== undefined && (
                  <Box flexDirection="row" gap={2}>
                    {!isOpen && <Text color={s.state === 'MERGED' ? 'merged' : 'inactive'}>{s.state.toLowerCase()}</Text>}
                    {isOpen && c.failed.length > 0 && (
                      <Box flexShrink={1}>
                        <Text color="error" wrap="truncate-end">
                          ❌ {c.failed.length} {c.failed.map(f => f.name).join(', ')}
                        </Text>
                      </Box>
                    )}
                    {isOpen && c.failed.length > 0 && (
                      <Button key={`${pr.key}:ci`} plain onPress={() => handOff($, pr.key, 'ci')}>
                        <Text backgroundColor="diffRemoved" hover={{ backgroundColor: 'error', color: 'inverseText' }}>
                          {' 🔧 fix '}
                        </Text>
                      </Button>
                    )}
                    {isOpen && c.pending > 0 && <Text color="warning">⏳ {c.pending}</Text>}
                    {isOpen && c.failed.length === 0 && c.pending === 0 && c.total > 0 && <Text color="success">✅ {c.passed}</Text>}
                    {isOpen && c.total === 0 && <Text dimColor>no checks</Text>}
                    {fresh.length > 0 && (
                      <Box flexShrink={1}>
                        <Text color="claude" wrap="truncate-end">
                          💬 {fresh.length} ({authors})
                        </Text>
                      </Box>
                    )}
                    {fresh.length > 0 && (
                      <Button key={`${pr.key}:cm`} plain onPress={() => handOff($, pr.key, 'comments')}>
                        <Text backgroundColor="suggestion" color="inverseText" hover={{ backgroundColor: 'claude' }}>
                          {' 📨 assess '}
                        </Text>
                      </Button>
                    )}
                    {fresh.length > 0 && (
                      <Button key={`${pr.key}:seen`} plain onPress={() => markSeen($, pr.key)}>
                        <Text dimColor underline hover={{ color: 'text', dimColor: false }}>
                          dismiss
                        </Text>
                      </Button>
                    )}
                    {s.codex === 'reviewing' && <Text dimColor>🔍 codex</Text>}
                    {s.codex === 'done' && fresh.length === 0 && <Text dimColor>codex 👍</Text>}
                    {pr.error && (
                      <Box flexShrink={1}>
                        <Text color="warning" wrap="truncate-end">
                          ⚠ {pr.error}
                        </Text>
                      </Box>
                    )}
                    <Box flexGrow={1} />
                    {isOpen && (
                      <Button key={`${pr.key}:auto`} plain onPress={() => setAuto($, pr.key, !pr.isAuto)}>
                        {pr.isAuto ? (
                          <Text backgroundColor="diffAdded" hover={{ backgroundColor: 'success', color: 'inverseText' }}>
                            {' auto on '}
                          </Text>
                        ) : (
                          <Text dimColor underline hover={{ color: 'text', dimColor: false }}>
                            auto off
                          </Text>
                        )}
                      </Button>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
