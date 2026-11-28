import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { boxedArgv, bubblewrapArgs, cleanEnvironment, reachOf, seatbeltProfile, slugOf, summaryOf } from '../hooks/proof'

const OWN = 'mcp__plugin_codebook_codebook__'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const DIR = '/Users/me/code/payments'
const TOKEN = 'tok_' + 'x'.repeat(40)
const REPORT = 'https://app.codebook.work/kanban/api/proof/report'

type World = {
  /** What each recipe line exits with and prints, by the folder it ran in ("head" or "baseline"). */
  results: Record<string, { exit: number; output: string }>
  collector?: { tree?: string; physical?: string; untracked?: string }
  witness?: { platform?: string; hostReady?: boolean; output?: string; legacy?: boolean }
  indexListing?: string
  delegated?: boolean
  claimedHead?: string
  dirty?: boolean
  origin?: string
  waiting?: boolean
  steps?: unknown[]
  system?: string
  lockfilesDiffer?: boolean
  /** The recipe CodeBook answers (network, hosts); loopback and no hosts when left out. */
  recipe?: Record<string, unknown>
  /** Where `command -v node` finds Node; none when null. */
  node?: string | null
  /** What the proxy notes it refused, one `host:port reason` per line. */
  refusedLog?: string
  /** What the proxy prints before it ends: `ready …` by default. */
  proxySays?: string
  /**
   * The repository's working trees on this computer, by folder (P1): the commit and branch each has checked out. With
   * them, git answers by the folder it is asked in, and `worktree list` names them all; `.` is the session's folder.
   */
  folders?: Record<string, { head: string; branch: string | null; origin?: string; time?: number }>
  /** The session's folder when `folders` is given. */
  session?: string
  /** Each branch's tip on origin (`refs/remotes/origin/<branch>`); a branch left out is not on origin. */
  tips?: Record<string, string>
  /** The commit CodeBook names for the waiting proof (null, as today's CodeBook queues a model's request). */
  commit?: string | null
  /** What claim_work answers as the run's brief. */
  brief?: unknown
}

/** The engine, CodeBook and this computer, as one world; what ran, what was claimed and what was reported come back. */
function world(on: On, w: World) {
  const processes: string[][] = []
  const mcp: { tool: string; args: Record<string, unknown> }[] = []
  const reports: { url: string; auth: string; body: Record<string, unknown> }[] = []
  const spawned: string[][] = []
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
    if (w.witness && argv[0] === '/usr/bin/python3') {
      if (argv.at(-1)==='probe') return out(w.witness.hostReady===false ? '' : 'ready') as never
      return out(w.witness.output ?? '') as never
    }
    if (w.delegated && argv[0] === '/usr/bin/mktemp') return out('/tmp/codebook-delegated-fixture\n') as never
    if (w.delegated && argv[0] === 'realpath') return out(argv[1]+'\n') as never
    if (w.delegated && argv[0] === 'git' && (argv.includes('--absolute-git-dir') || argv.includes('--git-common-dir'))) return out(DIR+'/.git\n') as never
    if (w.delegated && argv.includes('/usr/bin/env') && argv.includes('git')) {
      if (argv.includes('HEAD')) return out(HEAD+'\n') as never
      if (argv.includes('--cached')) return out(w.indexListing ?? 'H test/local.mjs\0') as never
      if (argv.includes('status')) return out(w.dirty ? ' M file\n' : '') as never
      return out('') as never
    }
    if (w.delegated && argv.includes('/usr/bin/env') && argv.includes('node')) return out('ok 1 - exact delegated file\n') as never
    if (w.collector && argv[0] === 'realpath') return out((argv[1] === DIR ? DIR : (w.collector.physical ?? argv[1])) + '\n') as never
    if (w.collector && argv.includes('ls-tree')) return out(w.collector.tree ?? ('100644 blob ' + HEAD + '\tproof/whiteboard/editing.test.mjs\0')) as never
    if (w.collector && argv.includes('ls-files')) return out(w.collector.untracked ?? '') as never
    if (argv[0] === 'uname') return out(`${w.system ?? 'Darwin'}\n`) as never
    if (argv[0] === '/bin/sh' && argv[2] === 'command -v node') return (w.node === null ? out('', 1) : out(`${w.node ?? '/opt/homebrew/bin/node'}\n`)) as never
    if (argv[0] === 'cat' && argv[1]?.includes('/.codebook/proof/egress-')) return out(w.refusedLog ?? '', w.refusedLog === undefined ? 1 : 0) as never
    if (argv[0] === '/usr/bin/sandbox-exec' && argv.at(-1) === '/usr/bin/true') return out('') as never
    if (argv[0] === '/usr/bin/bwrap' && argv.at(-1) === '/bin/true') return out('') as never
    if (argv[0] === 'git' && w.folders && argv[1] === '-C') {
      const asked = argv[2] === '.' ? (w.session ?? '/work/session') : String(argv[2])
      const folder = w.folders[asked]
      const rest = argv.slice(3).join(' ')
      if (rest.startsWith('worktree add') || rest.startsWith('worktree remove')) return out('') as never
      if (rest.startsWith('rev-parse --verify --quiet refs/remotes/origin/')) {
        const branch = rest.slice('rev-parse --verify --quiet refs/remotes/origin/'.length)
        const tip = branch === 'main' ? BASE : w.tips?.[branch]
        return (tip ? out(`${tip}\n`) : out('', 1)) as never
      }
      if (rest.startsWith('fetch')) return out('') as never
      if (!folder) return out('', 128) as never
      if (rest === 'rev-parse --show-toplevel') return out(`${asked}\n`) as never
      if (rest === 'remote get-url origin') return out(`${folder.origin ?? 'git@github.com:acme/payments.git'}\n`) as never
      if (rest === 'rev-parse HEAD') return out(`${folder.head}\n`) as never
      if (rest === 'status --porcelain') return out(w.dirty ? ' M src/refund.js\n' : '') as never
      if (rest === 'symbolic-ref --short -q HEAD') return (folder.branch ? out(`${folder.branch}\n`) : out('', 1)) as never
      if (rest === 'log -1 --format=%ct HEAD') return out(`${folder.time ?? 0}\n`) as never
      if (rest === 'worktree list --porcelain') {
        // Every folder of the same origin is one repository's working tree.
        const same = Object.entries(w.folders).filter(([, one]) => (one.origin ?? '') === (folder.origin ?? ''))
        return out(same.map(([path, one]) => `worktree ${path}\nHEAD ${one.head}\n${one.branch ? `branch refs/heads/${one.branch}` : 'detached'}\n`).join('\n')) as never
      }
      if (rest.startsWith('diff --quiet')) return out('', w.lockfilesDiffer ? 1 : 0) as never
      return out('') as never
    }
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
      const line = /&& \{ ([^\n]+)\n\}(?: 2>&1)?$/.exec(shell)?.[1] ?? ''
      const result = w.results[`${where}:${line}`] ?? { exit: 127, output: `no such line: ${line}` }
      return out(result.output, result.exit) as never
    }
    return out('') as never
  })
  // The proxy: it says where it listens, then lives until the plugin closes its stream.
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    const where = e.argv.at(-3) === 'tcp' ? '18601' : String(e.argv.at(-3))
    yield { stream: 'stdout' as const, text: w.proxySays ?? `ready ${where} 4242\n` }
    return { value: { code: 0, signal: null } } as never
  })
  const steps = w.steps ?? [{ run: 71, name: 'test', line: 'npm test', timeout_seconds: 900, baseline: false }]
  const answer = (tool: string, args: Record<string, unknown>) =>
    tool === 'claim_proof'
      ? args.peek
        ? { waiting: w.waiting === false ? [] : [{ proof: 70, ...(w.witness&&!w.witness.legacy ? {witness_executor:'locked-dependencies-v1-'+(w.witness.platform??'darwin')} : {}), ...(w.collector ? {case_report_version:1} : {}), ...(w.delegated ? {delegated_focused_version:1} : {}), repository: 'acme/payments', default_branch: 'main', commands: w.delegated ? steps.map(step => (step as {name:string}).name) : ['test'], commit: w.commit ?? null }] }
        : { proof: 70, token: TOKEN, report_url: REPORT, report_path: '/kanban/api/proof/report', repository: { id: 5, full_name: 'acme/payments', default_branch: 'main' }, proof_scope: w.delegated || (w.witness && !w.witness.legacy) ? 'focused' : 'repository_recipe', expected_commit: w.claimedHead ?? (w.collector || w.delegated || w.witness ? HEAD : null), recipe: { revision: 2, install: 'npm ci', network: 'loopback', ...(w.recipe ?? {}) }, steps }
      : tool === 'request_proof'
        ? { proof: 70, where: 'here', repository: 'acme/payments', commands: [{ name: 'test', status: 'queued' }] }
        : tool === 'claim_work'
          ? { run: args.run, where: 'here', lease: { fence: 1 }, brief: w.brief ?? null }
          : tool === 'declare_work'
            ? { run: args.run, recorded: { repository: args.repository ?? null, branch: args.branch ?? null, worktree: args.worktree ?? null, files: [] }, overlaps: [] }
            : { ok: true }
  on('mcp.call', (_, e) => {
    mcp.push({ tool: e.tool, args: e.args ?? {} })
    if (w.witness?.legacy && e.args?.peek && e.args?.native_witness) return {value:{
      content:[],structuredContent:{error:{code:'INVALID_INPUT',message:'unknown native_witness'}},isError:true}} as never
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
  return { processes, mcp, reports, spawned }
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

test('delegated local proof requires a clean pinned sandbox and strict loopback', { options: { proof_hosts: 'packages.example.test' } }, async ($, on) => {
  const step = {run:71, name:'focused', line:'node --test test/local.mjs', timeout_seconds:90, baseline:false, delegated_focused:true}
  const steps = [step]
  const state: World = {delegated:true, commit:HEAD, steps, recipe:{install:'', network:'loopback'}, results:{}}
  const w = world(on, state)
  const run = () => $.tool.call({tool:OWN+'request_proof', story:'story'} as never)
  const executions = () => w.processes.filter(argv => argv.includes('node') && argv.at(-1) === 'test/local.mjs')
  await run()
  expect(w.mcp[1]?.args).toEqual({proof:70, delegated_focused_version:1})
  expect(executions().length).toBe(1)
  const args = executions()[0]!
  expect(args[0]).toBe('/usr/bin/sandbox-exec')
  expect(args).toContain('-i')
  expect(args).toContain('HOME=/tmp/codebook-delegated-fixture')
  expect(args.join(' ')).not.toContain('ghp_secret')
  expect(args.join(' ')).not.toContain('HTTP_PROXY')
  expect(args[2]).toContain('(deny network*)')
  expect(args[2]).not.toContain('(remote unix-socket)')
  expect(w.spawned.length).toBe(0)
  expect(w.reports[0]?.body.network).toBe('loopback')
  expect(w.reports[0]?.body.delegated_focused_version).toBe(1)
  expect(w.reports[0]?.body.commit).toBe(HEAD)
  expect(w.processes.some(argv => argv.includes('fetch'))).toBe(false)

  for (const tag of ['h', 'S']) {
    state.indexListing = tag + ' test/local.mjs\0'
    await run()
  }
  state.indexListing = undefined
  state.dirty = true
  await run()
  state.dirty = false
  state.claimedHead = BASE
  await run()
  state.claimedHead = HEAD
  state.recipe = {install:'npm ci', network:'loopback'}
  await run()
  state.recipe = {install:'', network:'full'}
  await run()
  state.recipe = {install:'', network:'loopback'}
  steps.push({...step, run:72, baseline:true})
  await run()
  steps.pop()
  expect(w.reports.slice(1).every(reply => reply.body.exit_code === null && reply.body.error && reply.body.commit === null)).toBe(true)
  const previousClaims = w.mcp.filter(call => !call.args.peek).length
  state.system = 'unsupported'
  await run()
  expect(w.mcp.filter(call => !call.args.peek).length).toBe(previousClaims)
  expect(executions().length).toBe(1)
})

test('the approved case directory runs its fixed command separately from the suite and sends complete scoped stdout', async ($, on) => {
  const line = 'node --test --test-reporter=junit', directory = 'proof/whiteboard'
  const descriptor = { version:1, directory, definition:9, revision:1, hash:'a'.repeat(64) }
  const steps = [{run:71,name:'test',line:'npm test',timeout_seconds:90,baseline:false},
    {run:72,name:'case-report',line,timeout_seconds:90,baseline:false,case_report:descriptor}]
  const w = world(on,{collector:{},steps,results:{'head:npm test':{exit:1,output:'not ok 1 - unrelated'},
    ['head:'+line]:{exit:0,output:'<testsuites/>\n'}}})
  await $.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  expect(w.mcp[1]?.args.case_report_version).toBe(1)
  expect(w.processes.find(argv=>argv[0]==='/usr/bin/sandbox-exec' && argv.at(-1)?.includes(line))?.at(-1)).toContain(DIR+'/'+directory)
  expect(w.reports.map(r=>r.body.exit_code)).toEqual([1,0])
  expect(w.reports[1]?.body.case_report).toEqual(descriptor)
  expect(w.reports[1]?.body.complete).toBe(true)
  expect(w.reports[1]?.body.output).toBe('<testsuites/>\n')
})

test('a physical symlink escape cannot launch an approved case command', async ($, on) => {
  const line = 'node --test --test-reporter=junit'
  const step = { run:72,name:'case-report',line,timeout_seconds:30,baseline:false,case_report:{version:1,directory:'proof/whiteboard',definition:9,revision:1,hash:'a'.repeat(64)} }
  const w = world(on,{collector:{physical:'/external/whiteboard'},steps:[step],results:{}})
  await $.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  expect(w.processes.some(argv=>argv[0]==='/usr/bin/sandbox-exec' && argv.at(-1)?.includes(line))).toBe(false)
  expect(w.reports[0]?.body.complete).toBe(false)
  expect(w.reports[0]?.body.error).toContain('approved case directory')
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

// ── A list of allowed hosts (C27) ────────────────────────────────────────────────────────────────────────────────────

const boxedLine = (w: { processes: string[][] }) => w.processes.find(argv => argv.includes('/bin/sh') && argv.at(-1)?.includes('npm test'))

test('with no list nothing changes: no proxy, no proxy variables, the box allows the computer itself alone', async ($, on) => {
  const w = world(on, { results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(w.spawned.length).toBe(0)
  expect(w.processes.some(argv => argv[2] === 'command -v node')).toBe(false)
  const boxed = boxedLine(w)
  expect(boxed?.[2]).toBe(seatbeltProfile({ dirs: [DIR, '/Users/me/.codebook/proof'], home: '/Users/me', network: 'loopback' }))
  expect(boxed?.some(one => /_PROXY=/i.test(one))).toBe(false)
  expect([w.reports[0]?.body.network, w.reports[0]?.body.hosts]).toEqual([undefined, undefined])
  expect((asked.context ?? []).join('\n')).not.toContain('Network:')
})

test('the recipe\'s hosts: the proxy is started with them, the box stays shut, the command is told the proxy', async ($, on) => {
  const w = world(on, { recipe: { hosts: ['registry.npmjs.org', '*.example.com:8443'] }, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  // One proxy, Node from this computer's PATH, the validated rules as JSON, on 127.0.0.1 (macOS).
  expect(w.spawned.length).toBe(1)
  const proxy = w.spawned[0] ?? []
  expect(proxy.slice(0, 2)).toEqual(['/opt/homebrew/bin/node', '-e'])
  expect(JSON.parse(proxy.at(-4) ?? '[]')).toEqual([{ host: 'registry.npmjs.org', port: null, suffix: false, isPrivate: false }, { host: 'example.com', port: 8443, suffix: true, isPrivate: false }])
  expect(proxy.at(-3)).toBe('tcp')
  expect(proxy.at(-2)).toBe('/Users/me/.codebook/proof/egress-70.log')
  // The Seatbelt profile is exactly the one with no network: the proxy on the computer itself is the only way out.
  const boxed = boxedLine(w)
  expect(boxed?.[2]).toBe(seatbeltProfile({ dirs: [DIR, '/Users/me/.codebook/proof'], home: '/Users/me', network: 'loopback' }))
  expect(boxed?.[2]).toContain('(deny network*)')
  expect(boxed).toContain('HTTPS_PROXY=http://127.0.0.1:18601')
  expect(boxed).toContain('NO_PROXY=localhost,127.0.0.1,::1,.localhost')
  // CodeBook is told the list the run had; the model reads it too.
  expect([w.reports[0]?.body.network, w.reports[0]?.body.hosts]).toEqual(['hosts', ['registry.npmjs.org', '*.example.com:8443']])
  expect((asked.context ?? []).join('\n')).toContain('Network: this computer and registry.npmjs.org, *.example.com:8443 (through the plugin\'s filtering proxy; the sandbox refused every other way out).')
  // The proxy's notes are read and removed afterwards.
  expect(w.processes.some(argv => argv[0] === 'rm' && argv.includes('/Users/me/.codebook/proof/egress-70.log'))).toBe(true)
})

test('a host the proxy refused is named in the summary; a refused entry is left out and said', async ($, on) => {
  const w = world(on, {
    recipe: { hosts: ['registry.npmjs.org', '*', '10.0.0.0/8'] },
    refusedLog: 'example.org:443 not on this run\'s list of allowed hosts\nexample.org:443 not on this run\'s list of allowed hosts\nregistry.npmjs.org:22 not on this run\'s list of allowed hosts\n',
    results: { 'head:npm test': { exit: 1, output: 'not ok 1 - fetch\n' } },
  })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(JSON.parse(w.spawned[0]?.at(-4) ?? '[]').map((one: { host: string }) => one.host)).toEqual(['registry.npmjs.org'])
  const told = (asked.context ?? []).join('\n')
  expect(told).toContain('Refused by the list: example.org:443, registry.npmjs.org:22.')
  expect(told).toContain('Left out of the allowed hosts (the recipe): *, as a wildcard that matches every host would be the whole network.')
  expect(told).toContain('Left out of the allowed hosts (the recipe): 10.0.0.0/8, as an address range or a path cannot be enforced; list each host.')
})

test('the person\'s own list (the proof_hosts option) is used, and a recipe that needs the whole network still has it', { options: { proof_hosts: 'pypi.org, files.pythonhosted.org' } }, async ($, on) => {
  const w = world(on, { results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(JSON.parse(w.spawned[0]?.at(-4) ?? '[]').map((one: { host: string }) => one.host)).toEqual(['pypi.org', 'files.pythonhosted.org'])
  expect(w.reports[0]?.body.hosts).toEqual(['pypi.org', 'files.pythonhosted.org'])
  // "full" is as before: no proxy, no deny.
  expect(reachOf({ revision: 1, install: '', network: 'full' }, 'pypi.org')).toEqual({ network: 'full', rules: [], refused: [] })
  expect(reachOf({ revision: 1, install: '', network: 'loopback' }, '').network).toBe('loopback')
  expect(reachOf({ revision: 1, install: '', network: 'loopback', hosts: 'pypi.org' }, 'pypi.org').rules.length).toBe(1)
})

test('with no Node for the proxy the run reaches the computer itself only, and says so', async ($, on) => {
  const w = world(on, { node: null, recipe: { hosts: ['registry.npmjs.org'] }, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(w.spawned.length).toBe(0)
  expect(boxedLine(w)?.some(one => /_PROXY=/i.test(one))).toBe(false)
  expect(boxedLine(w)?.[2]).toContain('(deny network*)')
  expect(w.reports[0]?.body.network).toBe(undefined)
  expect((asked.context ?? []).join('\n')).toContain('The allowed hosts were not reachable: the list of allowed hosts needs Node.js')
})

test('a proxy that ends before it is ready leaves the run on the computer itself', async ($, on) => {
  const w = world(on, { proxySays: 'Error: listen EPERM\n', recipe: { hosts: ['registry.npmjs.org'] }, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  expect(boxedLine(w)?.some(one => /_PROXY=/i.test(one))).toBe(false)
  expect((asked.context ?? []).join('\n')).toContain('its proxy ended before it was ready')
})

test('on Linux the box keeps its own network; the proxy is a socket in the cache and a forwarder inside starts the line', async ($, on) => {
  const w = world(on, { system: 'Linux', node: '/usr/bin/node', recipe: { hosts: ['registry.npmjs.org'] }, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN' } as never)
  const socket = '/Users/me/.codebook/proof/egress-70.sock'
  expect(w.spawned[0]?.at(-3)).toBe(socket)
  const boxed = w.processes.find(argv => argv[0] === '/usr/bin/bwrap' && argv.at(-1)?.includes('npm test')) ?? []
  expect(boxed).toContain('--unshare-net')
  expect(boxed.join(' ')).toContain('--bind /Users/me/.codebook/proof /Users/me/.codebook/proof')
  const node = boxed.indexOf('/usr/bin/node')
  expect(boxed.slice(node + 1, node + 2)).toEqual(['-e'])
  expect(boxed.slice(node + 3, node + 8)).toEqual(['--', socket, '/bin/sh', '-c', `cd "${DIR}" && { npm test\n} 2>&1`])
  expect(boxed).toContain('HTTPS_PROXY=http://127.0.0.1:3128')
  expect(w.processes.some(argv => argv[0] === 'rm' && argv.includes(socket))).toBe(true)
})

test('boxedArgv: a list without a proxy tells the command nothing; "full" never gets the proxy', () => {
  const env = ['PATH=/usr/bin']
  const base = { sandbox: { kind: 'seatbelt' as const, bin: '/usr/bin/sandbox-exec' }, line: 'npm test', cwd: DIR, dirs: [DIR], home: '/Users/me', hidden: [], env }
  expect(boxedArgv({ ...base, network: 'hosts', egress: null })).toEqual(boxedArgv({ ...base, network: 'loopback' }))
  expect(boxedArgv({ ...base, network: 'full', egress: { kind: 'tcp', port: 18601 } }).some(one => one.startsWith('HTTPS_PROXY='))).toBe(false)
  expect(boxedArgv({ ...base, network: 'hosts', egress: { kind: 'tcp', port: 18601 } })).toContain('HTTPS_PROXY=http://127.0.0.1:18601')
  expect(bubblewrapArgs({ dirs: [DIR], hidden: [], network: 'hosts' })).toContain('--unshare-net')
})

// ── Where a proof runs: the run's worktree at its pull request's head (P1) ─────────────────────────────────────────────

const OWNER = '/Users/me/code/payments'
const TREE = '/Users/me/code/payments-29'
const BRANCH = 'codebook/VF-29-run-731'
const PR_HEAD = 'c'.repeat(40)
/** The brief of run 731 (Vibeforce WO-29's shape): the owner's checkout saved for the repository, the story's key and branch. */
const BRIEF_731 = { run_here: { repository: { name: 'acme/payments', url: 'https://github.com/acme/payments', local: { path: '~/code', mode: 'existing', checkout_path: '~/code/payments' } }, card_reference: { key: 'VF-29', branch: BRANCH } } }
/** The owner's checkout on main, and the worker's worktree beside it on the run's branch, pushed. */
const SEEN_731 = { [OWNER]: { head: BASE, branch: 'main' }, [TREE]: { head: PR_HEAD, branch: BRANCH } }
const ranIn = (w: { processes: string[][] }) => w.processes.filter(argv => argv.includes('/bin/sh') && argv.at(-1)?.includes('npm test')).map(argv => /^cd "([^"]+)"/.exec(argv.at(-1) ?? '')?.[1])

test('P1: a worker\'s proof runs in its declared worktree at the pull request\'s head, not in the owner\'s checkout on main', async ($, on) => {
  const w = world(on, { folders: SEEN_731, tips: { [BRANCH]: PR_HEAD }, brief: BRIEF_731, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  // The worker is a sub-agent: it claims, says its worktree, commits and pushes, then asks.
  await $.tool.call({ tool: `${OWN}claim_work`, run: 731, agentId: 'worker-1' } as never)
  await $.tool.call({ tool: `${OWN}declare_work`, run: 731, fence: 1, repository: 'acme/payments', branch: BRANCH, worktree: '~/code/payments-29', files: ['src/'], agentId: 'worker-1' } as never)
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', run: 731, agentId: 'worker-1' } as never)
  expect(ranIn(w)).toEqual([TREE])
  expect(w.reports.map(one => [one.body.run, one.body.commit])).toEqual([[71, PR_HEAD]])
  // The pull request's head was read from origin, the branch fetched first.
  expect(w.processes.some(argv => argv.join(' ') === `git -C ${TREE} fetch --quiet origin ${BRANCH}`)).toBe(true)
  const told = (asked.context ?? []).join('\n')
  expect(told).toContain('test: passed, 3 tests read at ccccccc')
  expect(told).not.toContain('Not the pull request\'s head')
})

test('P1: with no declared worktree (a QA run), the worktree whose branch carries the story\'s key is found at its head', async ($, on) => {
  // QA's own brief names its own run's branch, which no folder has; the developer's worktree is on run 731's branch.
  const qa = { run_here: { ...BRIEF_731.run_here, card_reference: { key: 'VF-29', branch: 'codebook/VF-29-run-735' } } }
  const folders = { ...SEEN_731, '/Users/me/code/payments-2': { head: 'd'.repeat(40), branch: 'codebook/VF-2-run-600' } }
  const w = world(on, { folders, tips: { [BRANCH]: PR_HEAD, 'codebook/VF-2-run-600': 'd'.repeat(40) }, brief: qa, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}claim_work`, run: 735, agentId: 'qa-1' } as never)
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', run: 735, agentId: 'qa-1' } as never)
  // VF-2's worktree is not VF-29's: the key is matched whole.
  expect(ranIn(w)).toEqual([TREE])
  expect(w.reports[0]?.body.commit).toBe(PR_HEAD)
})

test('P1: a worker that names no run is placed by the run its own loop holds', async ($, on) => {
  const w = world(on, { folders: SEEN_731, tips: { [BRANCH]: PR_HEAD }, brief: BRIEF_731, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}claim_work`, run: 731, agentId: 'worker-1' } as never)
  await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', agentId: 'worker-1' } as never)
  expect(ranIn(w)).toEqual([TREE])
})

test('P1: when no worktree of the run is on this computer, nothing runs in the owner\'s checkout and the proof stays waiting', async ($, on) => {
  const w = world(on, { folders: { [OWNER]: { head: BASE, branch: 'main' } }, brief: BRIEF_731, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}claim_work`, run: 731, agentId: 'worker-1' } as never)
  const asked = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', run: 731, agentId: 'worker-1' } as never)
  expect(ranIn(w)).toEqual([])
  // Not taken: claim_proof was only peeked, so the proof is still waiting for a later /factory prove.
  expect(w.mcp.filter(one => one.tool === 'claim_proof' && one.args.peek !== true).length).toBe(0)
  expect(w.reports.length).toBe(0)
  const told = (asked.context ?? []).join('\n')
  expect(told).toContain('nothing ran')
  expect(told).toContain(`${OWNER} (main at bbbbbbb) is not the pull request's head`)
})

test('P1: a worktree on the run\'s branch that is not at its pushed head runs only when it is the run\'s own, and says so', async ($, on) => {
  const local = 'e'.repeat(40)
  const w = world(on, { folders: { [OWNER]: { head: BASE, branch: 'main' }, [TREE]: { head: local, branch: BRANCH } }, tips: { [BRANCH]: PR_HEAD }, brief: BRIEF_731, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  await $.tool.call({ tool: `${OWN}claim_work`, run: 731, agentId: 'worker-1' } as never)
  // Without a declaration the worktree is not known to be the run's: refused.
  const before = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', run: 731, agentId: 'worker-1' } as never)
  expect(ranIn(w)).toEqual([])
  expect((before.context ?? []).join('\n')).toContain(`is at eeeeeee and origin/${BRANCH}, the pull request's head, at ccccccc`)
  // Declared, it runs there, and the summary says it proves no pull request's head.
  await $.tool.call({ tool: `${OWN}declare_work`, run: 731, fence: 1, branch: BRANCH, worktree: TREE, files: [], agentId: 'worker-1' } as never)
  const after = await $.tool.call({ tool: `${OWN}request_proof`, story: '6KjN', run: 731, agentId: 'worker-1' } as never)
  expect(ranIn(w)).toEqual([TREE])
  expect((after.context ?? []).join('\n')).toContain('Not the pull request\'s head')
})

test('P1: a commit CodeBook names is run where it is checked out, even from /factory prove', async ($, on) => {
  on('command.register', () => ({ value: { command: 'factory' } }))
  const w = world(on, { folders: SEEN_731, session: OWNER, commit: PR_HEAD, results: { 'head:npm test': { exit: 0, output: 'ok 1 - a\n' } } })
  const done = await $.command.run({ command: 'factory', args: 'prove 70', origin: { kind: 'human' } } as never)
  expect(ranIn(w)).toEqual([TREE])
  expect(String(done.text)).toContain('at ccccccc')
})

test('P1: a commit CodeBook names that no folder has checked out is never run in the owner\'s checkout', async ($, on) => {
  on('command.register', () => ({ value: { command: 'factory' } }))
  const none = world(on, { folders: { [OWNER]: { head: BASE, branch: 'main' } }, session: OWNER, commit: PR_HEAD, results: {} })
  const refused = await $.command.run({ command: 'factory', args: 'prove 70', origin: { kind: 'human' } } as never)
  expect(ranIn(none)).toEqual([])
  expect(String(refused.text)).toContain('no checkout or worktree of it on this computer has that commit checked out')
  expect(none.reports.length).toBe(0)
})

const fixedSelection = {fixture:'locked-dependencies',version:1,producer:'codebook-native-locked-dependencies',producer_version:1,
  platform:'darwin',sandbox:'seatbelt',proof:70,run:70,repository_id:5,commit:HEAD,definition:12,revision:1,selection:'e'.repeat(64)}
const fixedStep = {run:70,name:'test',timeout_seconds:120,baseline:false,native_witness:fixedSelection}
const fixedWorld = ():World=>({commit:HEAD,recipe:{install:'',network:'loopback'},steps:[fixedStep],results:{},
  witness:{output:JSON.stringify({verified_offline_dependency:'passed',parked_dependency_proof:'passed'})}})

test('typed witness dispatch keeps the real report token outside the fixture process', async ($, on)=>{
  const testbed = world(on,fixedWorld())
  await $.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  expect(testbed.mcp.filter(c=>c.tool==='claim_proof').at(-1)?.args).toEqual({proof:70,native_witness:{version:1,platform:'darwin',sandbox:'seatbelt'}})
  const actual=testbed.processes.filter(argv=>argv[0]==='/usr/bin/python3' && argv.at(-1)!=='probe')
  expect(actual.length).toBe(1)
  expect(actual[0].includes(TOKEN)).toBe(false)
  expect(testbed.reports[0].auth).toBe('Bearer '+TOKEN)
  expect(testbed.reports[0].body.native_witness).toEqual({selection:fixedSelection,cases:[
    {id:'verified_offline_dependency',status:'passed'},{id:'parked_dependency_proof',status:'passed'}]})
})

test('incomplete observations and changed selections cannot report witness cases', async ($, on)=>{
  const spec=fixedWorld()
  spec.witness!.output='{"verified_offline_dependency":"passed"}'
  const testbed=world(on,spec)
  const run=()=>$.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  await run()
  expect(testbed.reports[0].body.native_witness).toBeUndefined()
  expect(testbed.reports[0].body.error).toContain('did not complete')
  spec.steps![0]={...fixedStep,native_witness:{...fixedSelection,commit:BASE}}
  await run()
  spec.steps![0]={...fixedStep,line:'node unexpected.mjs'}
  await run()
  expect(testbed.processes.filter(argv=>argv[0]==='/usr/bin/python3'&&argv.at(-1)!=='probe').length).toBe(1)
  expect(testbed.reports.length).toBe(1)
})

test('an unavailable witness host leaves its selection queued',async ($,on)=>{
  const spec=fixedWorld();spec.witness!.hostReady=false
  const testbed=world(on,spec)
  await $.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  expect(testbed.mcp.filter(c=>c.tool==='claim_proof'&&!c.args.peek).length).toBe(0)
  expect(testbed.reports.length).toBe(0)
})

test('older proof servers use their ordinary read-only queue after a capability refusal',async ($,on)=>{
  const testbed=world(on,{witness:{legacy:true},results:{'head:npm test':{exit:0,output:'PASS ordinary'}}})
  await $.tool.call({tool:OWN+'request_proof',story:'story'} as never)
  expect(testbed.mcp.filter(c=>c.tool==='claim_proof'&&c.args.peek).at(-1)?.args).toEqual({peek:true})
  expect(testbed.reports.length).toBe(1)
  expect(testbed.reports[0].body.native_witness).toBeUndefined()
})
