import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const VIEW = {
  title: 'Number adults first',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: true,
  headRefName: 'fli-1-adults',
  headRefOid: 'abc1234def',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'unit / air', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/run/1' },
    { __typename: 'CheckRun', name: 'integration', status: 'IN_PROGRESS', conclusion: null },
  ],
  comments: [],
  reviews: [],
}
const INLINE = JSON.stringify({ id: 11, u: 'chatgpt-codex-connector[bot]', t: '2099-01-01T00:00:00Z', p: 'lib/a.ex', l: 4, b: 'Handle nil' })

const BAND = {
  plugin: 'pr-watch',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } },
} as never

let failView = false
let abortView = false
const opened: string[] = []

let clock: ReturnType<typeof mock.clock>

function fakeEngine(on: On, submitted: string[]) {
  failView = false
  abortView = false
  opened.length = 0
  clock = mock.clock(on)
  mock.store(on)
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'open') {
      opened.push(e.argv[1] ?? '')

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(1).join(' ')
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args === 'api user --jq .login') return out('me\n')
    if (args.startsWith('pr view 7 --repo o/r')) {
      if (abortView) return { deny: 'pr-watch: $.process.run(gh) aborted:' }
      if (failView) return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded', isStdoutTruncated: false, isStderrTruncated: false } }

      return out(JSON.stringify(VIEW))
    }
    if (args.startsWith('api repos/o/r/pulls/7/comments')) return out(INLINE + '\n')

    return out('')
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('session.start', async () => ({ cwd: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)

    return { text: e.text } as never
  })
}

test('a watched PR shows failures and Codex comments; auto hands both off once', async ($, on) => {
  const submitted: string[] = []
  fakeEngine(on, submitted)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'pr-watch', args: 'add https://github.com/o/r/pull/7' } as never)

  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)
  expect(await ui.find({ text: /❌ 1 unit \/ air/ })).toBeDefined()
  expect(await ui.find({ text: /⏳ 1/ })).toBeDefined()
  expect(await ui.find({ text: /💬 1 \(codex\)/ })).toBeDefined()
  expect(submitted).toEqual([])

  await ui.press({ key: 'o/r#7:auto' })
  await clock.advance(1000)
  expect(submitted).toHaveLength(2)
  expect(submitted[0]).toContain('has failing checks on abc1234:\n- unit / air — https://x/run/1')
  expect(submitted[0]).toContain('Investigate and fix')
  expect(submitted[1]).toContain('- chatgpt-codex-connector on lib/a.ex:4: Handle nil')
  expect(submitted[1]).toContain("Don't change code")

  await $.command.run({ command: 'pr-watch', args: 'refresh' } as never)
  expect(submitted).toHaveLength(2)

  await ui.press({ key: 'o/r#7:seen' })
  expect(await ui.find({ text: /💬/ })).toBeUndefined()
  await ui.press({ key: 'o/r#7:rm' })
  const status = await $.command.run({ command: 'pr-watch', args: 'status' } as never)
  expect(status).toMatchObject({ text: expect.stringContaining('Not watching any PRs') })
})

test('pressing fix records the hand-off, so turning auto on does not repeat it; gh errors show on the row', async ($, on) => {
  const submitted: string[] = []
  fakeEngine(on, submitted)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'pr-watch', args: 'add https://github.com/o/r/pull/7' } as never)
  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  await ui.press({ key: 'o/r#7:ci' })
  expect(submitted).toHaveLength(1)
  await ui.press({ key: 'o/r#7:auto' })
  await clock.advance(1000)
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toContain('has new review comments')

  failView = true
  await $.command.run({ command: 'pr-watch', args: 'refresh' } as never)
  expect(await ui.find({ text: /⚠ HTTP 403: API rate limit exceeded/ })).toBeDefined()
  expect(await ui.find({ text: /❌ 1 unit \/ air/ })).toBeDefined()
})

test('↗ opens the PR in the browser', async ($, on) => {
  const submitted: string[] = []
  fakeEngine(on, submitted)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'pr-watch', args: 'add https://github.com/o/r/pull/7' } as never)
  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  await ui.press({ key: 'o/r#7:open' })
  expect(opened).toEqual(['https://github.com/o/r/pull/7'])
})

test('an aborted gh call leaves the row as it was, with no error', async ($, on) => {
  const submitted: string[] = []
  fakeEngine(on, submitted)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'pr-watch', args: 'add https://github.com/o/r/pull/7' } as never)
  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  abortView = true
  await $.command.run({ command: 'pr-watch', args: 'refresh' } as never)
  expect(await ui.find({ text: /⚠/ })).toBeUndefined()
  expect(await ui.find({ text: /❌ 1 unit \/ air/ })).toBeDefined()
})

test('the footer carries the summary; the list above the prompt fits its content', async ($, on) => {
  const submitted: string[] = []
  fakeEngine(on, submitted)
  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`${e.props.hint} ${e.props.tail ?? ''}`}</Text>
  })
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'pr-watch', args: 'add https://github.com/o/r/pull/7' } as never)

  const hint = await $.ui.mount({ plugin: 'pr-watch', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
  expect(await hint.find({ text: '? for shortcuts PRs ❌ 1 💬 1 · ctrl+x ctrl+a' })).toBeDefined()

  const band = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)
  expect(await band.find({ text: /Number adults first/ })).toBeDefined()
  const panel = ((await band.drawn()) as { children: { props: { width: number } }[] }).children[0]
  expect(panel?.props.width).toBeLessThan(120)
  expect(panel?.props.width).toBeGreaterThan(40)
})
