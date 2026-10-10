import { describe, expect, test } from 'claude-code/testing'

import type { WatchedPr } from '../types'
import { classifyChecks, decide, handoffPrompt, isPushCommand, pushDir, summarize } from './lib'

const VIEW = {
  title: 'Number adults first',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN' as const,
  isDraft: false,
  headRefName: 'fli-1-adults',
  headRefOid: 'abc1234def',
  statusCheckRollup: [
    { __typename: 'CheckRun', workflowName: 'CI', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T10:00:00Z' },
    { __typename: 'CheckRun', workflowName: 'CI', name: 'unit / air', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/run/1', startedAt: '2026-10-09T10:00:00Z' },
    { __typename: 'CheckRun', workflowName: 'CI', name: 'integration', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-09T10:00:00Z' },
    { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
  ],
  comments: [
    { id: 'IC_1', author: { login: 'linear-code' }, createdAt: '2026-10-09T10:00:00Z', body: 'linkback' },
    { id: 'IC_2', author: { login: 'chatgpt-codex-connector' }, createdAt: '2026-10-09T10:01:00Z', body: '<!-- codex-pull-request-review-summary --> | ✅ **Completed** |' },
    { id: 'IC_3', author: { login: 'me' }, createdAt: '2026-10-09T10:02:00Z', body: 'my note' },
    { id: 'IC_4', author: { login: 'telphan' }, createdAt: '2026-10-09T10:05:00Z', body: 'Can we <b>rename</b> this?' },
  ],
  reviews: [
    { id: 'PRR_1', author: { login: 'chatgpt-codex-connector' }, state: 'COMMENTED', submittedAt: '2026-10-09T10:03:00Z', body: '### Codex Review' },
    { id: 'PRR_2', author: { login: 'george-duffel' }, state: 'APPROVED', submittedAt: '2026-10-09T10:06:00Z', body: '' },
    { id: 'PRR_3', author: { login: 'me' }, state: 'PENDING', submittedAt: null, body: 'draft' },
  ],
}
const INLINE = [
  JSON.stringify({ id: 11, u: 'chatgpt-codex-connector[bot]', t: '2026-10-09T10:03:00Z', p: 'lib/a.ex', l: 40, b: '**<sub><sub>![P2 Badge](x)</sub></sub> Handle nil infant**' }),
  JSON.stringify({ id: 12, u: 'me', t: '2026-10-09T10:04:00Z', p: 'lib/a.ex', l: 40, b: 'fixed' }),
].join('\n')

describe('classifyChecks', () => {
  test('counts passed, failed and pending across check runs and statuses', () => {
    expect(classifyChecks(VIEW.statusCheckRollup)).toEqual({ passed: 1, failed: [{ name: 'unit / air', url: 'https://x/run/1' }], pending: 2, total: 4 })
  })

  test('a green rerun replaces the red run of the same check', () => {
    const rerun = { __typename: 'CheckRun', workflowName: 'CI', name: 'unit / air', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T11:00:00Z' }
    expect(classifyChecks([...VIEW.statusCheckRollup, rerun])).toMatchObject({ passed: 2, failed: [], total: 4 })
  })
})

describe('summarize', () => {
  test('keeps other people and Codex inline comments, drops bots, me, bare approvals, pending reviews and the Codex summary', () => {
    const s = summarize(VIEW, INLINE, 'me')
    expect(s.codex).toBe('done')
    expect(s.comments).toEqual([
      { id: 'inline-11', author: 'chatgpt-codex-connector', at: '2026-10-09T10:03:00Z', kind: 'inline', path: 'lib/a.ex', line: 40, body: '[P2] Handle nil infant' },
      { id: 'IC_4', author: 'telphan', at: '2026-10-09T10:05:00Z', kind: 'comment', body: 'Can we rename this?' },
    ])
  })
})

function pr(overrides: Partial<WatchedPr>): WatchedPr {
  return { key: 'o/r#7', repo: 'o/r', number: 7, isAuto: false, seenIds: [], notifiedIds: [], handedIds: [], snapshot: summarize(VIEW, INLINE, 'me'), ...overrides }
}

describe('decide', () => {
  test('the first snapshot announces nothing but records it as announced', () => {
    const d = decide(pr({}), true)
    expect(d.notify).toEqual([])
    expect(d.patch.notifiedIds).toEqual(['inline-11', 'IC_4'])
  })

  test('later comments are announced once, by id, whatever their timestamps', () => {
    const d = decide(pr({ notifiedIds: ['inline-11'] }), false)
    expect(d.notify).toEqual(['#7: 1 new comment(s) from telphan'])
    expect(decide(pr({ notifiedIds: ['inline-11'], ...d.patch }), false).notify).toEqual([])
  })

  test('on auto, hands a failure off once per failing set, and again when another job fails on the same commit', () => {
    const d = decide(pr({ isAuto: true }), false)
    expect(d.handoff).toEqual([{ what: 'ci', ids: [] }, { what: 'comments', ids: ['inline-11', 'IC_4'] }])
    const after = pr({ isAuto: true, ...d.patch })
    expect(decide(after, false).handoff).toEqual([])
    const base = after.snapshot!
    const more = { ...after, snapshot: { ...base, checks: { ...base.checks, failed: [...base.checks.failed, { name: 'unit / web' }] } } }
    expect(decide(more, false).handoff).toEqual([{ what: 'ci', ids: [] }])
  })

  test('announces the CI verdict once all checks finish', () => {
    const base = pr({ seenIds: ['inline-11', 'IC_4'] })
    const done = { ...base, snapshot: { ...base.snapshot!, checks: { passed: 3, failed: [], pending: 0, total: 3 } } }
    expect(decide(done, false).notify).toEqual(['#7 checks passed'])
  })
})

describe('handoffPrompt', () => {
  test('lists failing checks with links and the instructions', () => {
    const text = handoffPrompt(pr({}), 'ci', 'Fix it.')
    expect(text).toContain('PR #7 "Number adults first" (https://github.com/o/r/pull/7, branch `fli-1-adults`) has failing checks on abc1234:')
    expect(text).toContain('- unit / air — https://x/run/1')
    expect(text.endsWith('Fix it.')).toBe(true)
  })

  test('lists the given comments with file and line for inline ones', () => {
    const text = handoffPrompt(pr({}), 'comments', 'Read it.', ['IC_4'])
    expect(text).toContain('- telphan: Can we rename this?\n\n')
    expect(text).not.toContain('Handle nil infant')
  })
})

describe('push detection', () => {
  test('finds pushes and the directory they run in', () => {
    expect(isPushCommand('git push -u origin HEAD')).toBe(true)
    expect(isPushCommand('cd /w/a && git push')).toBe(true)
    expect(isPushCommand('git commit -m "push later"')).toBe(false)
    expect(pushDir('cd "/w/my repo" && git push')).toBe('/w/my repo')
    expect(pushDir('cd /a && cd /b && git push')).toBe('/b')
    expect(pushDir('git -C /w/c push origin HEAD')).toBe('/w/c')
    expect(pushDir('git push')).toBeUndefined()
  })
})
