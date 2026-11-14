import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { On } from 'claude-code'

import { contextText, forgetCheckouts, remoteOf } from '../hooks/checkout'
import { readCommand } from '../hooks/guard'
import { forgetShell } from '../hooks/resolve'

const OWN = 'mcp__plugin_codebook_codebook__'
const INSTRUCTIONS = 'This is a checkout of acme/shop, which the CodeBook factory "Shop" works on (workflow "Delivery").\n\nWhat to do here:\n- A request that changes code becomes a story first.'

type Answer = Record<string, unknown>
const factoryAnswer = (extra: Answer = {}): Answer => ({
  repository: { name: 'acme/shop', host: 'github.com' },
  factory_work: true,
  outside: false,
  factories: [{ name: 'Shop', outside: false, local: { checkout_path: '~/code/shop' } }],
  instructions: INSTRUCTIONS,
  message: 'acme/shop is worked by the CodeBook factory "Shop".',
  ...extra,
})
const noFactory = (name: string): Answer => ({ repository: { name, host: 'github.com' }, factory_work: false, outside: false, factories: [], instructions: null, message: `No CodeBook factory of yours works on ${name}. Work as usual.` })

/** The folders of this world: a factory's checkout (its origin holds a token, as some do), another repository, and a folder with no git. */
const ORIGINS: Record<string, string> = {
  '/work/shop': 'https://x-access-token:ghp_secret123@github.com/Acme/Shop.git',
  '/work/shop/src': 'https://x-access-token:ghp_secret123@github.com/Acme/Shop.git',
  '/work/other': 'git@github.com:someone/elsewhere.git',
}
const TOPS: Record<string, string> = { '/work/shop/src': '/work/shop' }

type World = {
  cwd: string
  session: string
  answers: (args: Answer) => Answer | Promise<Answer>
  connected: boolean
  asked: Answer[]
  gitRuns: string[][]
  ran: string[]
  clock: ReturnType<typeof mock.clock>
  below: 'allow' | 'ask' | 'deny'
}

function world(on: On, start: Partial<World> = {}): World {
  forgetCheckouts()
  forgetShell()
  const w = { cwd: '/work/shop', session: 'session-a', answers: (args: Answer) => (String(args.repository).toLowerCase() === 'acme/shop' ? factoryAnswer() : noFactory(String(args.repository))), connected: true, asked: [], gitRuns: [], ran: [], below: 'allow', ...start } as World
  mock.store(on)
  w.clock = mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: w.session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('command.run', () => ({ text: '' }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/Users/me' : undefined }) as never)
  on('process.run', (_, e) => {
    const argv = e.argv as string[]
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (argv[0] === 'git' && argv[1] === '-C') {
      w.gitRuns.push(argv)
      const dir = argv[2] ?? ''
      const origin = ORIGINS[dir]
      if (origin === undefined) return out('', 128)
      if (argv[3] === 'remote' && argv[4] === 'get-url') return out(`${origin}\n`)
      if (argv[3] === 'rev-parse' && argv[4] === '--show-toplevel') return out(`${TOPS[dir] ?? dir}\n`)
      if (argv[3] === 'rev-parse') return out(`${dir}\n`)
      if (argv[3] === 'remote') return out('origin\n')
      return out('', 1)
    }
    if (argv[0] === 'perl') return out('\n')
    return out('', 1)
  })
  on('mcp.connect', () => ({ value: w.connected ? { isConnected: true, server: 'plugin:codebook:codebook' } : { isConnected: false, reason: 'auth', message: 'needs sign-in' } }) as never)
  on('mcp.call', async (_, e) => {
    if (e.tool !== 'checkout_factory') return { value: { content: [{ type: 'text', text: '{}' }], structuredContent: {}, isError: false } } as never
    w.asked.push(e.args as Answer)
    const data = await w.answers(e.args as Answer)
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } } as never
  })
  on('tool.check', () => ({ decision: w.below, reason: 'the engine' }))
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Bash') {
      w.ran.push(String((e as { command?: unknown }).command))
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    }
    const data = tool === OWN + 'claim_work' ? { run: 811, where: 'here', lease: { fence: 1 }, brief: { run_here: { repository: { name: 'acme/shop' } } } }
      : tool === OWN + 'checkout_factory' ? factoryAnswer()
        : tool === OWN + 'work_outside_factory' ? { repository: 'acme/shop', outside: true }
          : { recorded: true, run: 811 }
    return { result: { structuredContent: data } as never, text: JSON.stringify(data) }
  })
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }) as never)
  return w
}

const blockOf = async ($: Engine) => (await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })).blocks.find((b: { name: string }) => b.name === 'codebookFactory')?.text ?? null
const noteOf = async ($: Engine, text = 'add a refund button') => ((await $.prompt.submit({ text } as never)) as { context?: string[] }).context ?? []
const check = async ($: Engine, command: string) => $.tool.check({ tool: 'Bash', input: { command } } as never)

test('an origin is read as a host and a name, whatever its spelling, and never keeps a user name or a token', async () => {
  expect(remoteOf('https://github.com/Acme/Shop.git')).toEqual({ host: 'github.com', name: 'Acme/Shop' })
  expect(remoteOf('https://x-access-token:ghp_secret123@github.com/Acme/Shop.git')).toEqual({ host: 'github.com', name: 'Acme/Shop' })
  expect(remoteOf('git@github.com:acme/shop.git')).toEqual({ host: 'github.com', name: 'acme/shop' })
  expect(remoteOf('ssh://git@git.example.com:2222/group/sub/project')).toEqual({ host: 'git.example.com', name: 'group/sub/project' })
  expect(remoteOf('git@ssh.github.com:acme/shop.git')).toEqual({ host: 'github.com', name: 'acme/shop' })
  for (const bad of ['/Users/me/code/shop', '../shop', 'file:///tmp/shop/x', 'origin', '']) expect(remoteOf(bad)).toBeNull()
})

test('gh pr merge is read like a push and a pull request: where it runs and the repository it names', async () => {
  expect(readCommand('gh pr merge 12 --squash')?.merges).toEqual([{ cwd: null, repo: null }])
  expect(readCommand('cd /work/shop && gh pr merge 12 -R acme/shop')?.merges).toEqual([{ cwd: '/work/shop', repo: 'acme/shop' }])
  expect(readCommand('git push origin main')?.merges).toEqual([])
  expect(readCommand('git merge main && npm test')?.merges).toEqual([])
  expect(readCommand('sh -c "gh pr merge 12"')).toBeNull()
})

test('in a factory\'s checkout the conversation is given the manager\'s instructions as CodeBook words them, and CodeBook is told only the host and the name', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/shop' } as never)
  const text = await blockOf($)
  expect(text).toContain('this folder (/work/shop) is a checkout of acme/shop, which the CodeBook factory "Shop" works on')
  expect(text).toContain('use the codebook:factory-manager skill')
  expect(text).toContain(INSTRUCTIONS)
  expect(text).toContain('/factory outside')
  // Asked once, by host and name: not the address git holds (it carries a token here) and not the folder.
  expect(w.asked).toEqual([{ repository: 'Acme/Shop', host: 'github.com' }])
  expect(JSON.stringify(w.asked)).not.toContain('ghp_secret123')
  expect(JSON.stringify(w.asked)).not.toContain('/work')
  // The first prompt carries nothing more, and nothing is asked again: the answer is kept.
  expect(await noteOf($)).toEqual([])
  expect(await noteOf($, 'and a test for it')).toEqual([])
  expect(w.asked.length).toBe(1)
})

test('a folder inside the checkout is the same checkout', async ($, on) => {
  const w = world(on, { cwd: '/work/shop/src' })
  expect(await blockOf($)).toContain('this folder (/work/shop) is a checkout of acme/shop')
  expect(w.asked.length).toBe(1)
})

test('in any other folder nothing is added and nothing is asked of the person: another repository, and a folder with no git at all', async ($, on) => {
  const w = world(on, { cwd: '/work/other', answers: () => noFactory('someone/elsewhere') })
  await $.session.start({ cwd: '/work/other' } as never)
  expect(await blockOf($)).toBeNull()
  expect(await noteOf($)).toEqual([])
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect((await check($, 'gh pr merge 3')).decision).toBe('allow')
  expect(w.asked).toEqual([{ repository: 'someone/elsewhere', host: 'github.com' }])

  w.cwd = '/tmp/notes'
  w.asked.length = 0
  expect(await blockOf($)).toBeNull()
  expect(await noteOf($)).toEqual([])
  expect((await check($, 'git push')).decision).toBe('allow')
  expect(w.asked).toEqual([])   // not a checkout: CodeBook is not asked at all
})

test('signed out, nothing is added, nothing fails, and CodeBook is not tried again on every prompt', async ($, on) => {
  const w = world(on, { connected: false })
  await $.session.start({ cwd: '/work/shop' } as never)
  expect(await blockOf($)).toBeNull()
  expect(await noteOf($)).toEqual([])
  expect(await noteOf($, 'again')).toEqual([])
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect(w.asked).toEqual([])
  // Signed in later: after a few minutes the next prompt learns it and carries the note.
  w.connected = true
  await w.clock.advance(6 * 60 * 1000)
  const late = await noteOf($, 'now signed in')
  expect(late.length).toBe(1)
  expect(late[0]).toContain(INSTRUCTIONS)
})

test('offline, a prompt waits two seconds at most, once, and goes on with nothing added', async ($, on) => {
  let release: (answer: Answer) => void = () => {}
  const w = world(on, { answers: () => new Promise<Answer>(resolve => { release = resolve }) })
  const waiting = noteOf($)
  await w.clock.advance(2000)
  expect(await waiting).toEqual([])
  // The answer arrives after all: the next prompt carries the note, once.
  release(factoryAnswer())
  await w.clock.advance(1)
  const next = await noteOf($, 'second prompt')
  expect(next.length).toBe(1)
  expect(next[0]).toContain('codebook:factory-manager')
  expect(await noteOf($, 'third prompt')).toEqual([])
  expect(w.asked.length).toBe(1)
})

test('moving to another folder says the factory\'s rules no longer apply, once; coming back gives the note again', async ($, on) => {
  const w = world(on, { answers: args => (args.repository === 'Acme/Shop' ? factoryAnswer() : noFactory(String(args.repository))) })
  expect(await blockOf($)).toContain('acme/shop')
  w.cwd = '/work/other'
  const left = await noteOf($, 'now this one')
  expect(left).toEqual(['CodeBook: this session is no longer working in the factory\'s checkout of acme/shop (another folder, or the person works outside the factory there now). The factory manager\'s instructions do not apply here: work as usual.'])
  expect(await noteOf($, 'still here')).toEqual([])
  w.cwd = '/work/shop'
  await w.clock.advance(61 * 1000)
  const back = await noteOf($, 'back again')
  expect(back.length).toBe(1)
  expect(back[0]).toContain(INSTRUCTIONS)
})

test('outside a station\'s run, a push, a pull request and a merge in the checkout are put to the person; everything else runs as the engine decides', async ($, on) => {
  const w = world(on)
  await blockOf($)
  for (const command of ['git push origin main', 'git push', 'gh pr create --draft --title x', 'gh pr merge 12 --squash', 'git add -A && git commit -m x && git push -u origin fix/a', 'cd /work/shop && gh pr merge 4']) {
    const verdict = await check($, command)
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('acme/shop is worked by the factory "Shop"')
    expect(verdict.reason).toContain('Allow it to do this yourself, this once')
    expect(verdict.reason).toContain('/factory outside')
  }
  expect((await check($, 'gh pr merge 12')).reason).toContain('this gh pr merge does not come from one of its stations\' runs')
  for (const command of ['git status', 'npm test', 'git commit -m "push the button later"', 'git log --oneline', 'gh pr view 12', 'gh pr list', 'git -C /work/other push origin main', 'cd /work/other && gh pr create --title x']) {
    expect((await check($, command)).decision).toBe('allow')
  }
  // What cannot be read is asked about too, never guessed.
  expect((await check($, 'sh -c "git push origin main"')).decision).toBe('ask')
  // The engine's own refusal stands, and its own question becomes ours only where ours applies.
  w.below = 'deny'
  expect((await check($, 'git push origin main')).decision).toBe('deny')
  w.below = 'ask'
  expect((await check($, 'git status')).reason).toBe('the engine')
  expect((await check($, 'git push')).reason).toContain('worked by the factory')
})

test('from another folder, a push into the factory\'s checkout is asked about as well', async ($, on) => {
  world(on, { cwd: '/work/other', answers: args => (args.repository === 'Acme/Shop' ? factoryAnswer() : noFactory(String(args.repository))) })
  expect((await check($, 'git -C /work/shop push origin main')).decision).toBe('ask')
  expect((await check($, 'cd /work/shop && gh pr create --title x')).decision).toBe('ask')
  expect((await check($, 'git push origin main')).decision).toBe('allow')
})

test('while a station\'s run is held the question is not asked: its pushes are the station\'s own', async ($, on) => {
  world(on)
  await blockOf($)
  expect((await check($, 'git push origin codebook/57')).decision).toBe('ask')
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  expect((await check($, 'git push origin codebook/57')).decision).toBe('allow')
  expect((await check($, 'gh pr create --draft')).decision).toBe('allow')
  await $.tool.call({ tool: OWN + 'complete_work', run: 811, fence: 1, outcome: 'pass', summary: 'ok' } as never)
  expect((await check($, 'git push origin codebook/57')).decision).toBe('ask')
})

test('/factory outside turns the factory off for this session only, and /factory inside turns it back on', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/shop' } as never)
  await blockOf($)
  const off = await $.command.run({ command: 'factory', args: 'outside' } as never)
  expect(off.text).toContain('For this session you work outside the factory "Shop" in acme/shop')
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect((await noteOf($))[0]).toContain('no longer working in the factory\'s checkout of acme/shop')
  expect(await blockOf($)).toBeNull()
  // Another session in the same folder is still inside the factory.
  w.session = 'session-b'
  expect((await check($, 'git push origin main')).decision).toBe('ask')
  w.session = 'session-a'
  const on2 = await $.command.run({ command: 'factory', args: 'inside' } as never)
  expect(on2.text).toBe('This session works through the factory "Shop" in acme/shop again.')
  expect((await check($, 'git push origin main')).decision).toBe('ask')
  expect((await noteOf($, 'back inside'))[0]).toContain(INSTRUCTIONS)
  // In a folder no factory works on there is nothing to turn off.
  w.cwd = '/tmp/notes'
  expect((await $.command.run({ command: 'factory', args: 'outside' } as never)).text).toContain('not a git checkout with an origin')
})

test('the person\'s own "I work outside the factory here" is respected: nothing is added and nothing is asked', async ($, on) => {
  const w = world(on, { answers: () => factoryAnswer({ factory_work: false, outside: true, instructions: null, factories: [{ name: 'Shop', outside: true }] }) })
  expect(await blockOf($)).toBeNull()
  expect(await noteOf($)).toEqual([])
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect((await $.command.run({ command: 'factory', args: 'outside' } as never)).text).toContain('You already work outside the factory in acme/shop, in every assistant')
  expect(w.asked.length).toBe(1)
})

test('a switch flipped on the website is seen within a minute, and an answer that does not come leaves what was known', async ($, on) => {
  const w = world(on)
  expect(await blockOf($)).toContain('acme/shop')
  expect((await check($, 'git push origin main')).decision).toBe('ask')
  // The person turns "I work outside the factory here" on in CodeBook's settings. Within the minute nothing is asked again.
  w.answers = () => factoryAnswer({ factory_work: false, outside: true, instructions: null })
  await w.clock.advance(30 * 1000)
  expect((await check($, 'git push origin main')).decision).toBe('ask')
  expect(w.asked.length).toBe(1)
  await w.clock.advance(31 * 1000)
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect(w.asked.length).toBe(2)
  expect((await noteOf($, 'after the switch'))[0]).toContain('no longer working in the factory\'s checkout')
  // Back inside, but CodeBook does not answer: after a second the session goes on with what it knew (outside).
  w.answers = () => new Promise<Answer>(() => {})
  await w.clock.advance(61 * 1000)
  const waiting = check($, 'git push origin main')
  await w.clock.advance(1000)
  expect((await waiting).decision).toBe('allow')
})

test('a session that starts asks again at once, so a switch flipped a moment ago is known by its first prompt', async ($, on) => {
  const w = world(on)
  expect(await blockOf($)).toContain('acme/shop')
  // Seconds later the person steps outside on the website, and opens a new session in the same folder.
  w.answers = () => factoryAnswer({ factory_work: false, outside: true, instructions: null })
  await w.clock.advance(5000)
  w.session = 'session-b'
  await $.session.start({ cwd: '/work/shop' } as never)
  expect(await blockOf($)).toBeNull()
  expect((await check($, 'git push origin main')).decision).toBe('allow')
  expect(w.asked.length).toBe(2)
})

test('what the model itself asked CodeBook is kept, and a change of the person\'s switch is asked about again', async ($, on) => {
  const w = world(on)
  // The model called checkout_factory (as the connector's instructions tell every host to): no second question from the plugin.
  await $.tool.call({ tool: OWN + 'checkout_factory', repository: 'https://github.com/acme/shop.git' } as never)
  expect((await noteOf($))[0]).toContain(INSTRUCTIONS)
  expect(w.asked).toEqual([])
  // The person stepped outside through the model: the kept answer is dropped, and CodeBook now says "outside".
  w.answers = () => factoryAnswer({ factory_work: false, outside: true, instructions: null })
  await $.tool.call({ tool: OWN + 'work_outside_factory', repository: 'acme/shop', host: 'github.com', outside: true } as never)
  expect((await noteOf($, 'after stepping outside'))[0]).toContain('no longer working in the factory\'s checkout')
  expect(w.asked.length).toBe(1)
  expect((await check($, 'git push origin main')).decision).toBe('allow')
})

test('the note says what only Claude Code does, and falls back to the tool when CodeBook sent no text', async () => {
  const checkout = { top: '/work/shop', host: 'github.com', name: 'Acme/Shop', key: 'github.com/acme/shop' }
  const bare = contextText(checkout, { key: checkout.key, at: 1, repository: 'acme/shop', factoryWork: true, outside: false, factories: ['Shop', 'Billing'], instructions: null, saved: null })
  expect(bare).toContain('the CodeBook factory "Shop", "Billing" works on')
  expect(bare).toContain('Call the CodeBook connector\'s checkout_factory tool (repository "Acme/Shop", host "github.com")')
  expect(bare).toContain('A sub-agent working a station\'s run it claimed follows that run\'s brief, not this note.')
})
