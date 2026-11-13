// Proof runs on this computer (CodeBook Wave I, track A1): the plugin runs the repository's checks itself and reports
// them itself. The model can ASK for a proof (the connector's request_proof); it never runs the commands and never
// writes a result. This module:
//
//   1. takes the person's waiting proof from CodeBook (claim_proof, a call only the plugin may make: register.tsx
//      refuses it to the model), which answers the command lines of the repository's recipe and a single-use token;
//   2. runs each line in the person's checkout, boxed by the system's own sandbox where there is one (Seatbelt on macOS,
//      bubblewrap on Linux): writes limited to the checkout, the proof cache and temporary folders; no reading of the
//      folders credentials live in; a scrubbed environment; and no network beyond the computer itself unless the
//      repository's recipe says its checks need it;
//   3. when a check fails, runs the same line on the default branch in a separate worktree, so CodeBook can tell a
//      failure that was already there from one this change made;
//   4. reports each step to CodeBook over HTTPS with the token: exit code, the output (CodeBook reads the tests from
//      it), a SHA-256 of that output, the commit that was checked out, and whether the tree had uncommitted changes.
//
// Nothing here is given to the model except the closing summary, which CodeBook's own answer is the source of.

import type { EngineInterface } from 'claude-code'

import type { CodebookCheckout } from '../types'
import { call } from './connector'

/** A command on this computer may run this long: the engine's limit for one process. */
export const MAX_COMMAND_MS = 10 * 60 * 1000
/** What is sent of a command's output: its last million characters. */
export const MAX_SENT_OUTPUT = 1_000_000
/** Folders a repository's dependencies live in: linked into the baseline worktree instead of installed again. */
export const DEPENDENCY_FOLDERS = ['node_modules', '.venv', 'venv', 'vendor', 'target']
/** Files that pin dependencies: when the default branch's differ, the baseline is installed afresh. */
export const LOCK_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'uv.lock', 'requirements.txt', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']
/** Folders under the home folder that hold credentials: a boxed command cannot read them. */
export const SECRET_FOLDERS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.config/gcloud', '.azure', '.claude']
export const SECRET_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials']

export type ProofStep = { run: number; name: string; line: string; timeout_seconds: number; baseline: boolean; for_run?: number; ref?: string; commit?: string }
export type ProofWork = {
  proof: number | null
  token?: string
  report_url?: string
  repository?: { id: number; full_name: string; default_branch: string }
  expected_commit?: string | null
  recipe?: { revision: number; install: string; network: string } | null
  steps?: ProofStep[]
}
export type ProofWaiting = { proof: number; repository: string; commands: string[]; commit: string | null; default_branch?: string }
export type Sandbox = { kind: 'seatbelt' | 'bubblewrap' | 'none'; bin: string | null }
type Ran = { exitCode: number | null; output: string; isTruncated: boolean; isTimedOut: boolean; error: string | null; ms: number }
export type StepOutcome = { name: string; baseline: boolean; status: string; exitCode: number | null; tests: number; newFailures: number | null; isDirty: boolean; commit: string | null }

/** `owner/name` of any git address (https, ssh, a host with a port), lower case; null when it has no two last parts. */
export function slugOf(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  const match = /[:/]([^/:\s]+)\/([^/:\s]+)$/.exec(cleaned) ?? /^([^/:\s]+)\/([^/:\s]+)$/.exec(cleaned)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

const quote = (path: string) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The Seatbelt profile one command runs under. Everything is allowed, then:
 *   - no write anywhere but the checkout (`dirs`), the proof cache and the temporary folders;
 *   - no read of the folders and files credentials live in;
 *   - no network but the computer itself (a test may start a server and call it), unless `network` is "full".
 * `(local ip …)` is never allowed for network*: it also matches an outbound socket that has no address yet.
 */
export function seatbeltProfile({ dirs, home, network }: { dirs: string[]; home: string; network: string }): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${dirs.map(dir => `(subpath ${quote(dir)})`).join(' ')} (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/tmp") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${SECRET_FOLDERS.map(name => `(subpath ${quote(`${home}/${name}`)})`).join(' ')} ${SECRET_FILES.map(name => `(literal ${quote(`${home}/${name}`)})`).join(' ')})`,
  ]
  if (network !== 'full') {
    lines.push(
      '(deny network*)',
      '(allow network* (remote unix-socket))',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
    )
  }
  return lines.join('\n')
}

/** bubblewrap's arguments for one command: the whole system read-only, the checkout and cache writable, credentials hidden. */
export function bubblewrapArgs({ dirs, hidden, network }: { dirs: string[]; hidden: string[]; network: string }): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...dirs.flatMap(dir => ['--bind', dir, dir]),
    ...hidden.flatMap(path => ['--tmpfs', path]),
    ...(network === 'full' ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--new-session',
  ]
}

/** The few variables a command is given: never this session's whole environment, which may hold keys. */
export function cleanEnvironment(base: Record<string, string | undefined>, cache: string): string[] {
  const kept = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME']
  const out: string[] = []
  for (const name of kept) if (base[name] !== undefined) out.push(`${name}=${base[name]}`)
  return [...out, 'CI=1', `npm_config_cache=${cache}/npm`, `YARN_CACHE_FOLDER=${cache}/yarn`, `PIP_CACHE_DIR=${cache}/pip`, 'GIT_TERMINAL_PROMPT=0']
}

/** The whole argument vector of one boxed command: the sandbox, a clean environment, then the line through a shell. */
export function boxedArgv({ sandbox, line, cwd, dirs, home, hidden, network, env }: { sandbox: Sandbox; line: string; cwd: string; dirs: string[]; home: string; hidden: string[]; network: string; env: string[] }): string[] {
  // Both streams in the order they were written: CodeBook reads the tests from one text.
  const inner = ['/usr/bin/env', '-i', ...env, '/bin/sh', '-c', `cd ${quote(cwd)} && { ${line}\n} 2>&1`]
  if (sandbox.kind === 'seatbelt' && sandbox.bin) return [sandbox.bin, '-p', seatbeltProfile({ dirs, home, network }), ...inner]
  if (sandbox.kind === 'bubblewrap' && sandbox.bin) return [sandbox.bin, ...bubblewrapArgs({ dirs, hidden, network }), ...inner]
  return inner
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function quiet($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 30000): Promise<{ exitCode: number; stdout: string }> {
  try {
    const ran = await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs })
    return { exitCode: ran.exitCode, stdout: ran.stdout }
  } catch {
    return { exitCode: 127, stdout: '' }
  }
}

/** The sandbox this computer has: Seatbelt on macOS, bubblewrap on Linux, else none. Looked for once per proof. */
export async function findSandbox($: EngineInterface): Promise<Sandbox> {
  const system = (await quiet($, ['uname', '-s'])).stdout.trim()
  if (system === 'Darwin') {
    const probe = await quiet($, ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'])
    return probe.exitCode === 0 ? { kind: 'seatbelt', bin: '/usr/bin/sandbox-exec' } : { kind: 'none', bin: null }
  }
  if (system === 'Linux') {
    for (const bin of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
      const probe = await quiet($, [bin, '--ro-bind', '/', '/', '/bin/true'])
      if (probe.exitCode === 0) return { kind: 'bubblewrap', bin }
    }
  }
  return { kind: 'none', bin: null }
}

async function runBoxed($: EngineInterface, argv: string[], cwd: string, timeoutSeconds: number): Promise<Ran> {
  const started = await $.clock.now()
  const timeoutMs = Math.min(MAX_COMMAND_MS, Math.max(10, timeoutSeconds) * 1000)
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs })
    return { exitCode: ran.exitCode, output: ran.stdout + (ran.stderr ? `\n${ran.stderr}` : ''), isTruncated: ran.isStdoutTruncated, isTimedOut: false, error: null, ms: (await $.clock.now()) - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ms = (await $.clock.now()) - started
    // The engine rejects a command still running at its time limit, and one that could not start.
    const isTimedOut = ms >= timeoutMs - 500 || /time(d)? ?out|still running/i.test(message)
    return { exitCode: null, output: '', isTruncated: false, isTimedOut, error: isTimedOut ? null : message.slice(0, 500), ms }
  }
}

async function report($: EngineInterface, work: ProofWork, body: Record<string, unknown>): Promise<{ ok: boolean; status?: string; tests?: number; newFailures?: number | null; message?: string }> {
  try {
    const answered = await $.http.fetch(work.report_url ?? '', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${work.token ?? ''}` },
      body: JSON.stringify(body),
    })
    const parsed = JSON.parse(answered.text || '{}') as { data?: boolean; status?: string; tests?: number; new_failures?: number | null; error?: string }
    if (!answered.ok || parsed.data !== true) return { ok: false, message: parsed.error ?? `CodeBook answered ${answered.status}.` }
    return { ok: true, status: parsed.status, tests: parsed.tests, newFailures: parsed.new_failures ?? null }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** The folder on this computer that holds `repository`: the one CodeBook was told, else this session's own, when its origin is that repository. */
export async function checkoutFor($: EngineInterface, repository: string, known: CodebookCheckout[]): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const wanted = repository.toLowerCase()
  const candidates = [...known.filter(one => one.repository.toLowerCase() === wanted && one.checkoutPath !== null).map(one => (one.checkoutPath ?? '').replace(/^~(?=\/|$)/, home)), '.']
  for (const dir of candidates) {
    const top = await quiet($, ['git', '-C', dir, 'rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) continue
    const origin = await quiet($, ['git', '-C', dir, 'remote', 'get-url', 'origin'])
    if (origin.exitCode === 0 && slugOf(origin.stdout) === wanted) return top.stdout.trim()
  }
  return null
}

/** What is waiting for this person's computer, without taking any of it. */
export async function waitingProofs($: EngineInterface): Promise<{ ok: true; waiting: ProofWaiting[] } | { ok: false; message: string }> {
  const peeked = await call<{ waiting?: ProofWaiting[] }>($, 'claim_proof', { peek: true })
  if (!peeked.ok) return { ok: false, message: peeked.message }
  return { ok: true, waiting: peeked.data.waiting ?? [] }
}

/** One line per step, for the person and for the model: what CodeBook recorded, in its words. */
export function summaryOf(repository: string, sandbox: Sandbox, outcomes: StepOutcome[], notes: string[]): string {
  const boxed = sandbox.kind === 'seatbelt' ? 'boxed by the macOS sandbox' : sandbox.kind === 'bubblewrap' ? 'boxed by bubblewrap' : 'NOT boxed: this computer has no sandbox the plugin can use'
  const lines = outcomes
    .filter(one => !one.baseline)
    .map(one => {
      const verdict = one.status === 'passed' ? 'passed' : one.status === 'failed' ? `FAILED (exit ${one.exitCode ?? '?'})` : one.status
      const tests = one.tests > 0 ? `, ${one.tests} tests read` : ''
      const compared = one.status === 'failed' ? (one.newFailures === null ? ', not compared with the default branch' : `, ${one.newFailures} new ${one.newFailures === 1 ? 'failure' : 'failures'}`) : ''
      const at = one.commit ? ` at ${one.commit.slice(0, 7)}` : ''
      return `  ${one.name}: ${verdict}${tests}${compared}${at}${one.isDirty ? ' — ON UNCOMMITTED CHANGES, so it proves no commit' : ''}`
    })
  return [`CodeBook proof run for ${repository} (run by the plugin on this computer, ${boxed}; recorded as verified evidence):`, ...lines, ...notes].join('\n')
}

/**
 * Take one proof and run it. `proof` names it; without it the oldest one waiting is taken. `known` are the checkouts
 * CodeBook last told this session. → the summary, or why nothing ran.
 */
export async function runProof($: EngineInterface, { proof = null, known = [] }: { proof?: number | null; known?: CodebookCheckout[] }): Promise<{ isRun: boolean; text: string }> {
  const peeked = await waitingProofs($)
  if (!peeked.ok) return { isRun: false, text: peeked.message }
  const target = proof === null ? peeked.waiting[0] : peeked.waiting.find(one => one.proof === proof)
  if (!target) return { isRun: false, text: proof === null ? 'No proof run is waiting for this computer.' : `Proof run ${proof} is not waiting for this computer (it may already have been run, or it was asked for someone else's).` }

  const dir = await checkoutFor($, target.repository, known)
  if (dir === null) {
    return { isRun: false, text: `A proof run for ${target.repository} is waiting, and its code is not in this session's folder or in a folder CodeBook knows on this computer. Open Claude Code in its checkout, or save the folder (Factory settings → Your computer), then run /factory prove.` }
  }

  // The commit that is checked out, whether anything is uncommitted, and the default branch as this git knows it.
  const head = (await quiet($, ['git', '-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
  const status = await quiet($, ['git', '-C', dir, 'status', '--porcelain'])
  const isDirty = status.exitCode !== 0 || status.stdout.trim() !== ''
  const branch = target.default_branch ?? 'main'
  await quiet($, ['git', '-C', dir, 'fetch', '--quiet', 'origin', branch], undefined, 20000)
  const base = (await quiet($, ['git', '-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).stdout.trim()

  const claimed = await call<ProofWork>($, 'claim_proof', { proof: target.proof, ...(/^[0-9a-f]{40,64}$/.test(base) ? { base: { ref: branch, commit: base } } : {}) })
  if (!claimed.ok) return { isRun: false, text: claimed.message }
  const work = claimed.data
  if (work.proof === null || !work.token || !work.report_url || !work.steps) return { isRun: false, text: 'The proof run was taken by another session first.' }

  const home = (await $.env.get('HOME')) ?? ''
  const cache = `${home}/.codebook/proof`
  await quiet($, ['mkdir', '-p', `${cache}/npm`, `${cache}/baseline`])
  const sandbox = await findSandbox($)
  const environment = cleanEnvironment(
    { PATH: await $.env.get('PATH'), HOME: home, LANG: await $.env.get('LANG'), LC_ALL: await $.env.get('LC_ALL'), TERM: await $.env.get('TERM'), TMPDIR: await $.env.get('TMPDIR'), SHELL: await $.env.get('SHELL'), USER: await $.env.get('USER'), LOGNAME: await $.env.get('LOGNAME') },
    cache,
  )
  // bubblewrap hides a folder by mounting an empty one over it, which needs the folder to exist.
  const hidden: string[] = []
  if (sandbox.kind === 'bubblewrap') for (const name of SECRET_FOLDERS) if ((await quiet($, ['test', '-d', `${home}/${name}`])).exitCode === 0) hidden.push(`${home}/${name}`)
  const network = work.recipe?.network === 'full' ? 'full' : 'loopback'
  const box = (line: string, cwd: string, dirs: string[], reach = network) => boxedArgv({ sandbox, line, cwd, dirs, home, hidden, network: reach, env: environment })

  const outcomes: StepOutcome[] = []
  const notes: string[] = []
  const send = async (step: ProofStep, ran: Ran | null, commit: string | null, dirty: boolean): Promise<void> => {
    const output = ran ? (ran.output.length > MAX_SENT_OUTPUT ? ran.output.slice(-MAX_SENT_OUTPUT) : ran.output) : ''
    const answered = await report($, work, ran === null
      ? { run: step.run, skipped: true }
      : { run: step.run, exit_code: ran.exitCode, output, output_sha256: await sha256Hex(output), commit, dirty, duration_ms: ran.ms, sandbox: sandbox.kind, timed_out: ran.isTimedOut, ...(ran.error ? { error: ran.error } : {}), ...(/^[0-9a-f]{40,64}$/.test(base) ? { base_commit: base } : {}) })
    if (!answered.ok) notes.push(`  ${step.name}${step.baseline ? ' (default branch)' : ''}: CodeBook did not record it — ${answered.message}`)
    outcomes.push({ name: step.name, baseline: step.baseline, status: answered.status ?? (ran === null ? 'not run' : 'not recorded'), exitCode: ran?.exitCode ?? null, tests: answered.tests ?? 0, newFailures: answered.newFailures ?? null, isDirty: dirty, commit })
  }

  const steps = work.steps
  // A proof whose every step is the default branch (a dry run of the recipe) runs in the checkout as it stands.
  const isAllBaseline = steps.every(step => step.baseline)
  for (const step of steps.filter(one => isAllBaseline || !one.baseline)) {
    await $.ui.status(`CodeBook proof: ${step.name}…`)
    const ran = await runBoxed($, box(step.line, dir, [dir, cache]), dir, step.timeout_seconds)
    const failed = ran.exitCode !== 0 && !ran.isTimedOut && ran.error === null
    const baseline = isAllBaseline ? undefined : steps.find(one => one.baseline && one.for_run === step.run)
    // The same check on the default branch first, so CodeBook can compare when the head's result arrives.
    if (baseline) {
      if (failed && baseline.commit) {
        await $.ui.status(`CodeBook proof: ${step.name} on ${baseline.ref ?? branch}…`)
        const compared = await runBaseline($, { dir, cache, baseline, work, box })
        if (compared.note) notes.push(compared.note)
        await send(baseline, compared.ran, baseline.commit, false)
      } else await send(baseline, null, null, false)
    }
    await send(step, ran, head || null, isDirty)
  }
  await $.ui.status(undefined)
  if (isDirty) notes.push('  The checkout had uncommitted changes, so these results are evidence of no commit: commit, then ask for the proof again.')
  if (work.expected_commit && head && !head.startsWith(work.expected_commit) && !work.expected_commit.startsWith(head)) notes.push(`  CodeBook asked about commit ${work.expected_commit.slice(0, 7)}; the checkout is at ${head.slice(0, 7)}, which is what ran.`)
  return { isRun: true, text: summaryOf(target.repository, sandbox, outcomes, notes) }
}

/** The failed check again, on the default branch, in a worktree of its own. Nothing of the person's checkout is touched. */
async function runBaseline(
  $: EngineInterface,
  { dir, cache, baseline, work, box }: { dir: string; cache: string; baseline: ProofStep; work: ProofWork; box: (line: string, cwd: string, dirs: string[], reach?: string) => string[] },
): Promise<{ ran: Ran | null; note: string | null }> {
  const tree = `${cache}/baseline/${(work.repository?.full_name ?? 'repository').replace(/[^A-Za-z0-9._-]+/g, '__')}`
  await quiet($, ['git', '-C', dir, 'worktree', 'remove', '--force', tree])
  await quiet($, ['rm', '-rf', tree])
  const added = await quiet($, ['git', '-C', dir, 'worktree', 'add', '--detach', '--force', tree, baseline.commit ?? ''], undefined, 120000)
  if (added.exitCode !== 0) return { ran: null, note: `  ${baseline.name}: the default branch could not be checked out beside your checkout, so the failure was not compared with it.` }
  try {
    // The same dependencies when both commits pin the same ones; otherwise the recipe's install, which may reach the registries.
    const same = (await quiet($, ['git', '-C', dir, 'diff', '--quiet', baseline.commit ?? '', 'HEAD', '--', ...LOCK_FILES])).exitCode === 0
    if (same) {
      for (const folder of DEPENDENCY_FOLDERS) if ((await quiet($, ['test', '-e', `${dir}/${folder}`])).exitCode === 0) await quiet($, ['ln', '-s', `${dir}/${folder}`, `${tree}/${folder}`])
    } else if (work.recipe?.install) {
      const installed = await runBoxed($, box(work.recipe.install, tree, [tree, cache], 'full'), tree, 600)
      if (installed.exitCode !== 0) return { ran: null, note: `  ${baseline.name}: the default branch's dependencies could not be installed (${work.recipe.install} exited ${installed.exitCode ?? '?'}), so the failure was not compared with it.` }
    }
    return { ran: await runBoxed($, box(baseline.line, tree, [tree, cache]), tree, baseline.timeout_seconds), note: null }
  } finally {
    await quiet($, ['git', '-C', dir, 'worktree', 'remove', '--force', tree])
    await quiet($, ['rm', '-rf', tree])
  }
}
