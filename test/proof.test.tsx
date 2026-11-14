import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { boxedArgv, bubblewrapArgs, cleanEnvironment, seatbeltProfile, slugOf, summaryOf } from '../hooks/proof'

const OWN = 'mcp__plugin_codebook_codebook__'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const DIR = '/Users/me/code/payments'
const TOKEN = 'tok_' + 'x'.repeat(40)
const REPORT = 'https://app.codebook.work/kanban/api/proof/report'

type World = {
  /** What each recipe line exits with and prints, by the folder it ran in ("head" or "baseline"). */
  results: Record<string, { exit: number; output: string }>
  dirty?: boolean
  origin?: string
  waiting?: boolean
  steps?: unknown[]
  system?: string
  lockfilesDiffer?: boolean
}

/** The engine, CodeBook and this computer, as one world; what ran, what was claimed and what was reported come back. */
function world(on: On, w: World) {
  const processes: string[][] = []
  const mcp: { tool: string; args: Record<string, unknown> }[] = []
  const reports: { url: string; auth: string; body: Record<string, unknown> }[] = []
  let now = 1_000_000
  mock.store(on)
  on('clock.now', () => ({ value: (now += 250) }))
  on('ui.status', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: ({ HOME: '/Users/me', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', GITHUB_TOKEN: 'ghp_secret' } as Record<string, string>)[(e as { name: string }).name] }) as never)
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:codebook:codebook' } }))
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    processes.push(argv)
    const joined = argv.join(' ')
    if (argv[0] === 'uname') return out(`${w.system ?? 'Darwin'}\n`) as never
    if (argv[0] === '/usr/bin/sandbox-exec' && argv.at(-1) === '/usr/bin/true') return out('') as never
    if (argv[0] === '/usr/bin/bwrap' && argv.at(-1) === '/bin/true') return out('') as never
    if (argv[0] === 'git') {
      if (joined.includes('rev-parse --show-toplevel')) return out(`${DIR}\n`) as never
      if (joined.includes('remote get-url origin')) return out(`${w.origin ?? 'git@github.com:acme/payments.git'}\n`) as never
      if (joined.includes('rev-parse HEAD')) return out(`${HEAD}\n`) as never
      if (joined.includes('status --porcelain')) return out(w.dirty ? ' M src/refund.js\n' : '') as never
      if (joined.includes('refs/remotes/origin/main')) return out(`${BASE}\n`) as never
      if (joined.includes('diff --quiet')) return out('', w.lockfilesDiffer ? 1 : 0) as never
      return out('') as never
    }
    if (argv[0] === 'test') return out('', argv[2]?.endsWith('node_modules') || argv[2]?.endsWith('.ssh') ? 0 : 1) as never
    // A recipe line, boxed: the shell's own argument names the folder it runs in.
    const shell = argv.at(-1) ?? ''
    if (argv.includes('/bin/sh')) {
      const where = shell.includes('/.codebook/proof/baseline/') ? 'baseline' : 'head'
      const line = /&& \{ ([^\n]+)\n\} 2>&1$/.exec(shell)?.[1] ?? ''
      const result = w.results[`${where}:${line}`] ?? { exit: 127, output: `no such line: ${line}` }
      return out(result.output, result.exit) as never
    }
    return out('') as never
  })
  const steps = w.steps ?? [{ run: 71, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: false }]
  const answer = (tool: string, args: Record<string, unknown>) =>
    tool === 'claim_proof'
      ? args.peek
        ? { waiting: w.waiting === false ? [] : [{ proof: 70, repository: 'acme/payments', default_branch: 'main', commands: ['test'], commit: null }] }
        : { proof: 70, token: TOKEN, report_url: REPORT, report_path: '/kanban/api/proof/report', repository: { id: 5, full_name: 'acme/payments', default_branch: 'main' }, expected_commit: null, recipe: { revision: 2, install: 'npm ci', network: 'loopback' }, steps }
      : tool === 'request_proof'
        ? { proof: 70, where: 'here', commands: [{ name: 'test', status: 'queued' }] }
        : { ok: true }
  on('mcp.call', (_, e) => {
    mcp.push({ tool: e.tool, args: e.args ?? {} })
    const data = answer(e.tool, e.args ?? {})
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } }
  })
  // The model's own call of the connector.
  on('tool.call', (_, e) => {
    const tool = String(e.tool).replace(OWN, '')
    const data = answer(tool, e as Record<string, unknown>)
    return { result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } as never, text: JSON.stringify(data) }
  })
  on('http.fetch', (_, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}')) as Record<string, unknown>
    reports.push({ url: e.url, auth: String(e.init?.headers?.authorization ?? ''), body })
    const failed = typeof body.exit_code === 'number' && body.exit_code !== 0
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: true, recorded: true, status: body.skipped ? 'cancelled' : failed ? 'failed' : 'passed', tests: body.skipped ? 0 : 3, new_failures: failed ? 1 : 0, remaining: 0 }) } }
  })
  return { processes, mcp, reports }
}

test('the Seatbelt profile: writes only in the checkout, no credential folders, no network but the computer itself', () => {
  const profile = seatbeltProfile({ dirs: [DIR, '/Users/me/.codebook/proof'], home: '/Users/me', network: 'loopback' })
  expect(profile).toContain('(deny file-write* (subpath "/"))')
  expect(profile).toContain(`(allow file-write* (subpath "${DIR}") (subpath "/Users/me/.codebook/proof")`)
  expect(profile).toContain('(subpath "/Users/me/.ssh")')
  expect(profile).toContain('(literal "/Users/me/.npmrc")')
  expect(profile).toContain('(deny network*)')
  expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))')
  // `(local ip …)` under network* also matches an outbound socket with no address yet: found on a real Mac.
  expect(profile).not.toContain('(allow network* (local ip')
  expect(seatbeltProfile({ dirs: [DIR], home: '/Users/me', network: 'full' })).not.toContain('(deny network*)')
  expect(seatbeltProfile({ dirs: ['/tmp/a "b"'], home: '/h', network: 'loopback' })).toContain('(subpath "/tmp/a \\"b\\"")')
})

test('bubblewrap: the system read-only, the checkout writable, credentials hidden, no network', () => {
  const args = bubblewrapArgs({ dirs: [DIR], hidden: ['/home/me/.ssh'], network: 'loopback' })
  expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
  expect(args.join(' ')).toContain(`--bind ${DIR} ${DIR}`)
  expect(args.join(' ')).toContain('--tmpfs /home/me/.ssh')
  expect(args).toContain('--unshare-net')
  expect(bubblewrapArgs({ dirs: [DIR], hidden: [], network: 'full' })).not.toContain('--unshare-net')
})

test('a command gets a few variables, never the session\'s environment', () => {
  const env = cleanEnvironment({ PATH: '/usr/bin', HOME: '/Users/me', LANG: undefined }, '/Users/me/.codebook/proof')
  expect(env).toContain('PATH=/usr/bin')
  expect(env).toContain('CI=1')
  expect(env.some(one => one.startsWith('LANG='))).toBe(false)
  const argv = boxedArgv({ sandbox: { kind: 'none', bin: null }, line: 'npm test', cwd: DIR, dirs: [DIR], home: '/Users/me', hidden: [], network: 'loopback', env })
  expect(argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
  expect(argv.at(-1)).toBe(`cd "${DIR}" && { npm test\n} 2>&1`)
})

test('a repository is named by the last two parts of any git address', () => {
  expect(slugOf('git@github.com:Acme/Payments.git')).toBe('acme/payments')
  expect(slugOf('https://git.acme.example:3000/acme/payments')).toBe('acme/payments')
  expect(slugOf('ssh://git@gitlab.example/group/sub/payments.git')).toBe('sub/payments')
  expect(slugOf('payments')).toBeNull()
})

test('the model cannot take a proof run: its token is the plugin\'s alone', async ($, on) => {
  const w = world(on, { results: {} })
  const refused = await $.tool.call({ tool: `${OWN}claim_proof`, proof: 70 } as never)
  expect(refused.deny).toContain('plugin\'s own call')
  expect(w.mcp.length).toBe(0)
  const check = await $.tool.check({ tool: `${OWN}claim_proof`, input: {} } as never)
  expect(check.decision).toBe('deny')
})

test('the model asks; the plugin runs the check boxed and reports it itself, and the model reads what CodeBook recorded', async ($, on) => {
  const w = world(on, { results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\nok 2 - b\nok 3 - c\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(asked.deny).toBe(undefined)
  // The plugin looked, then took it with the default branch as this git sees it.
  expect(w.mcp.map(one => [one.tool, one.args.peek === true])).toEqual([['claim_proof', true], ['claim_proof', false]])
  expect(w.mcp[1]?.args).toEqual({ proof: 70, base: { ref: 'main', commit: BASE } })
  // The line ran under the macOS sandbox, in the checkout, with a scrubbed environment.
  const boxed = w.processes.find(argv => argv[0] === '/usr/bin/sandbox-exec' && argv.at(-1)?.includes('npm test'))
  expect(boxed !== undefined).toBe(true)
  expect(boxed?.[2]).toContain(`(subpath "${DIR}")`)
  expect(boxed?.join(' ')).toContain('/usr/bin/env -i PATH=/usr/bin:/bin HOME=/Users/me')
  expect(boxed?.join(' ')).not.toContain('ghp_secret')
  // One report, to the address CodeBook named, with the token, the facts and a hash of the output.
  expect(w.reports.length).toBe(1)
  const sent = w.reports[0]
  expect([sent?.url, sent?.auth]).toEqual([REPORT, `Bearer ${TOKEN}`])
  expect([sent?.body.run, sent?.body.exit_code, sent?.body.commit, sent?.body.dirty, sent?.body.sandbox, sent?.body.base_commit]).toEqual([71, 0, HEAD, false, 'seatbelt', BASE])
  expect(sent?.body.output).toBe('ok 1 - a\nok 2 - b\nok 3 - c\n')
  expect(String(sent?.body.output_sha256)).toMatch(/^[0-9a-f]{64}$/)
  // What the model reads: CodeBook's record, never the token.
  const told = (asked.context ?? []).join('\n')
  expect(told).toContain('test: passed, 3 tests read at aaaaaaa')
  expect(told).toContain('boxed by the macOS sandbox')
  expect(told).not.toContain(TOKEN)
  expect(JSON.stringify(asked.result)).not.toContain(TOKEN)
})

test('a failing check is run again on the default branch, in a worktree of its own, and reported first', async ($, on) => {
  const steps = [
    { run: 71, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: false },
    { run: 72, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: true, for_run: 71, ref: 'main', commit: BASE },
  ]
  const w = world(on, { steps, results: { 'head:npm test': { exit: 1, output: 'ok 1 - a\nnot ok 2 - b\nnot ok 3 - c\n' }, 'baseline:npm test': { exit: 1, output: 'ok 1 - a\nnot ok 2 - b\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  const tree = '/Users/me/.codebook/proof/baseline/acme__payments'
  expect(w.processes.some(argv => argv.join(' ') === `git -C ${DIR} worktree add --detach --force ${tree} ${BASE}`)).toBe(true)
  // The same dependencies, linked, when both commits pin the same ones: nothing is installed again.
  expect(w.processes.some(argv => argv.join(' ') === `ln -s ${DIR}/node_modules ${tree}/node_modules`)).toBe(true)
  expect(w.processes.some(argv => argv.at(-1)?.includes('npm ci'))).toBe(false)
  // The worktree is removed afterwards; the person's checkout is never checked out, stashed or reset.
  expect(w.processes.filter(argv => argv.join(' ') === `git -C ${DIR} worktree remove --force ${tree}`).length).toBe(2)
  expect(w.processes.some(argv => argv[0] === 'git' && ['checkout', 'stash', 'reset', 'clean'].includes(argv[3] ?? ''))).toBe(false)
  expect(w.reports.map(one => [one.body.run, one.body.exit_code, one.body.commit, one.body.dirty])).toEqual([[72, 1, BASE, false], [71, 1, HEAD, false]])
  expect((asked.context ?? []).join('\n')).toContain('test: FAILED (exit 1), 3 tests read, 1 new failure at aaaaaaa')
})

test('a passing check needs no baseline: the step is reported as not run', async ($, on) => {
  const steps = [
    { run: 71, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: false },
    { run: 72, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: true, for_run: 71, ref: 'main', commit: BASE },
  ]
  const w = world(on, { steps, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(w.reports.map(one => [one.body.run, one.body.skipped === true])).toEqual([[72, true], [71, false]])
  expect(w.processes.some(argv => argv.includes('worktree'))).toBe(false)
})

test('uncommitted changes are said, to CodeBook and to the model', async ($, on) => {
  const w = world(on, { dirty: true, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(w.reports[0]?.body.dirty).toBe(true)
  expect((asked.context ?? []).join('\n')).toContain('ON UNCOMMITTED CHANGES, so it proves no commit')
})

test('code that is not on this computer is never run: nothing is taken, and the person is told where to open it', async ($, on) => {
  const w = world(on, { origin: 'git@github.com:someone/else.git', results: {} })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(w.mcp.filter(one => one.args.peek !== true).length).toBe(0)
  expect(w.reports.length).toBe(0)
  expect((asked.context ?? []).join('\n')).toContain('its code is not in this session\'s folder')
})

test('on Linux the line runs under bubblewrap, with the credential folders hidden', async ($, on) => {
  const w = world(on, { system: 'Linux', results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  const boxed = w.processes.find(argv => argv[0] === '/usr/bin/bwrap' && argv.at(-1)?.includes('npm test'))
  expect(boxed?.join(' ')).toContain('--tmpfs /Users/me/.ssh')
  expect(boxed).toContain('--unshare-net')
  expect(w.reports[0]?.body.sandbox).toBe('bubblewrap')
})

test('/factory prove runs what waits, and says so when nothing does', async ($, on) => {
  on('command.register', () => ({ value: { command: 'factory' } }))
  const typed = (args: string) => ({ command: 'factory', args, origin: { kind: 'human' } }) as never
  const none = world(on, { waiting: false, results: {} })
  expect((await $.command.run(typed('prove'))).text).toContain('No proof run is waiting for this computer')
  expect(none.reports.length).toBe(0)
})

test('the summary names what was not boxed', () => {
  const text = summaryOf('acme/payments', { kind: 'none', bin: null }, [{ name: 'lint', baseline: false, status: 'passed', exitCode: 0, tests: 0, newFailures: 0, isDirty: false, commit: HEAD }], [])
  expect(text).toContain('NOT boxed')
  expect(text).toContain('lint: passed at aaaaaaa')
})
