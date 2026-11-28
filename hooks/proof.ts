// Proof runs on this computer (CodeBook Wave I, track A1): the plugin runs the repository's checks itself and reports
// them itself. The model can ASK for a proof (the connector's request_proof); it never runs the commands and never
// writes a result. This module:
//
//   1. takes the person's waiting proof from CodeBook (claim_proof, a call only the plugin may make: register.tsx
//      refuses it to the model), which answers the command lines of the repository's recipe and a single-use token;
//   2. runs each line in the person's checkout, boxed by the system's own sandbox where there is one (Seatbelt on macOS,
//      bubblewrap on Linux): writes limited to the checkout, the proof cache and temporary folders; no reading of the
//      folders credentials live in; a scrubbed environment; and no network beyond the computer itself unless the
//      repository's recipe says its checks need it, or a list of allowed hosts names some (egress.ts: a filtering
//      proxy outside the box is then the only way out);
//   3. when a check fails, runs the same line on the default branch in a separate worktree, so CodeBook can tell a
//      failure that was already there from one this change made;
//   4. reports each step to CodeBook over HTTPS with the token: exit code, the output (CodeBook reads the tests from
//      it), a SHA-256 of that output, the commit that was checked out, and whether the tree had uncommitted changes.
//
// Nothing here is given to the model except the closing summary, which CodeBook's own answer is the source of.

import type { EngineInterface } from 'claude-code'

import type { CodebookCheckout, CodebookClaim } from '../types'
import { call } from './connector'
import { FORWARD_PORT, forwarderSource, parseHosts, proxyEnvironment, proxySource, ruleText } from './egress'
import type { HostRule } from './egress'

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

type CaseReport = { version: 1; directory: string; definition: number; revision: number; hash: string }
type BillingProduct = { product: string; repository: string; ref: string; commit: string; origin: string }
type BillingPlan = { fixture_profile: string; definition: string; path: string; products: BillingProduct[] }
export type ProofStep = { signed_in_billing?: BillingPlan; delegated_focused?: boolean; case_report?: CaseReport; run: number; name: string; line: string; timeout_seconds: number; baseline: boolean; for_run?: number; ref?: string; commit?: string }
export type ProofWork = {
  proof: number | null
  token?: string
  report_url?: string
  repository?: { id: number; full_name: string; default_branch: string }
  proof_scope?: string
  expected_commit?: string | null
  recipe?: { revision: number; install: string; network: string; hosts?: unknown } | null
  steps?: ProofStep[]
}
/**
 * A proof waiting for this computer, as `claim_proof { peek }` answers it. `commit` is the commit CodeBook wants proven
 * (today's CodeBook queues a model's request_proof with none). `run`, `branch` and `worktree` are what a newer CodeBook
 * may send of the run that asked (its declare_work); the plugin reads them when they are there.
 */
export type ProofWaiting = { signed_in_billing_version?: number; delegated_focused_version?: number; case_report_version?: number; proof: number; repository: string; commands: string[]; commit: string | null; default_branch?: string; run?: number | null; branch?: string | null; worktree?: string | null }
/** What this session knows of the run that asked for a proof: its worktree and branch (declare_work), the story's key and branch (its brief). */
export type ProofHint = { run: number | null; worktree?: string; branch?: string; key?: string }
export type Sandbox = { kind: 'seatbelt' | 'bubblewrap' | 'none'; bin: string | null }
/** Where a boxed command's way out is: the proxy's port on this computer (macOS), or its socket and the forwarder that reaches it (Linux). */
export type Egress = { kind: 'tcp'; port: number } | { kind: 'unix'; socket: string; node: string }
/** What a run may reach: the computer itself, it and the hosts on a list, or everything. */
export type Reach = { network: 'loopback' | 'hosts' | 'full'; rules: HostRule[]; refused: { entry: string; reason: string; from: string }[] }
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
 * A list of hosts ("hosts") is the same profile: Seatbelt cannot name a host, so the way to those hosts is the plugin's
 * filtering proxy on this computer (egress.ts), which the box reaches as it reaches anything on the computer itself.
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

/**
 * bubblewrap's arguments for one command: the whole system read-only, the checkout and cache writable, credentials
 * hidden, and a network of its own (only its own loopback) unless `network` is "full". With a list of hosts the box
 * keeps that network of its own; the proxy's socket is in the cache folder, which is bound in.
 */
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

/**
 * The whole argument vector of one boxed command: the sandbox, a clean environment, then the line through a shell.
 * With `egress` (a list of hosts) the command is told the proxy; in a Linux box the forwarder starts it.
 */
export function boxedArgv({ sandbox, line, cwd, dirs, home, hidden, network, env, egress, stdoutOnly = false }: { stdoutOnly?: boolean; sandbox: Sandbox; line: string; cwd: string; dirs: string[]; home: string; hidden: string[]; network: string; env: string[]; egress?: Egress | null }): string[] {
  // Both streams in the order they were written: CodeBook reads the tests from one text.
  const shell = ['/bin/sh', '-c', `cd ${quote(cwd)} && { ${line}\n}${stdoutOnly ? '' : ' 2>&1'}`]
  const way = network === 'hosts' && egress ? egress : null
  const told = way === null ? env : [...env, ...proxyEnvironment(way.kind === 'tcp' ? way.port : FORWARD_PORT)]
  const inner = way?.kind === 'unix' ? ['/usr/bin/env', '-i', ...told, way.node, '-e', forwarderSource(), '--', way.socket, ...shell] : ['/usr/bin/env', '-i', ...told, ...shell]
  if (sandbox.kind === 'seatbelt' && sandbox.bin) return [sandbox.bin, '-p', seatbeltProfile({ dirs, home, network }), ...inner]
  if (sandbox.kind === 'bubblewrap' && sandbox.bin) return [sandbox.bin, ...bubblewrapArgs({ dirs, hidden, network }), ...inner]
  return inner
}

/**
 * What a run may reach. The recipe decides whether the checks need the network: "full" is everything, as before. Else
 * the hosts the recipe lists (Factory settings → Proof runs, when CodeBook sends them) and the ones the person lists
 * on this computer (the plugin's `proof_hosts` option) are the only hosts beyond the computer itself; with neither,
 * the computer itself alone, as before. An entry that does not pass the checks of egress.ts is left out and said.
 */
export function reachOf(recipe: ProofWork['recipe'], personal: unknown): Reach {
  if (recipe?.network === 'full') return { network: 'full', rules: [], refused: [] }
  const station = parseHosts(Array.isArray(recipe?.hosts) || typeof recipe?.hosts === 'string' ? (recipe.hosts as string | unknown[]) : null)
  const mine = parseHosts(typeof personal === 'string' || Array.isArray(personal) ? (personal as string | unknown[]) : null)
  const both = parseHosts([...station.rules, ...mine.rules].map(ruleText))
  const refused = [...station.refused.map(one => ({ ...one, from: 'the recipe' })), ...mine.refused.map(one => ({ ...one, from: 'proof_hosts' })), ...both.refused.map(one => ({ ...one, from: 'the list' }))]
  return { network: both.rules.length > 0 ? 'hosts' : 'loopback', rules: both.rules, refused }
}

/** One line for the summary when the run had a list of hosts: what it could reach, and how that was enforced. */
export function reachLine(reach: Reach, sandbox: Sandbox, refusedHosts: string[] = []): string | null {
  if (reach.network !== 'hosts') return null
  const listed = reach.rules.map(ruleText).join(', ')
  const how = sandbox.kind === 'none' ? 'asked of programs through the proxy variables only, as nothing boxed the commands' : 'through the plugin\'s filtering proxy; the sandbox refused every other way out'
  const denied = refusedHosts.length ? ` Refused by the list: ${refusedHosts.slice(0, 10).join(', ')}${refusedHosts.length > 10 ? `, and ${refusedHosts.length - 10} more` : ''}.` : ''
  return `  Network: this computer and ${listed} (${how}).${denied}`
}

/**
 * Starts the filtering proxy for a run with a list (egress.ts) and answers where the box finds it, a way to stop it
 * and read what it refused, or why it could not start (then the run reaches the computer itself alone).
 */
export async function startEgress(
  $: EngineInterface,
  { rules, sandbox, cache, proof, lifetimeMs }: { rules: HostRule[]; sandbox: Sandbox; cache: string; proof: number; lifetimeMs: number },
): Promise<{ egress: Egress; stop: () => Promise<string[]> } | { error: string }> {
  const found = await quiet($, ['/bin/sh', '-c', 'command -v node'])
  const node = found.stdout.trim().split('\n')[0] ?? ''
  if (found.exitCode !== 0 || !node.startsWith('/')) return { error: 'the list of allowed hosts needs Node.js on this computer\'s PATH for its proxy, and there is none' }
  const log = `${cache}/egress-${proof}.log`
  const listen = sandbox.kind === 'bubblewrap' ? `${cache}/egress-${proof}.sock` : 'tcp'
  await quiet($, ['rm', '-f', log])
  let stream: ReturnType<EngineInterface['process']['spawn']>
  try {
    stream = $.process.spawn({ argv: [node, '-e', proxySource(), '--', JSON.stringify(rules), listen, log, String(lifetimeMs)] })
  } catch (error) {
    return { error: `its proxy could not start (${error instanceof Error ? error.message : String(error)})` }
  }
  let said = ''
  let ready: RegExpExecArray | null = null
  try {
    while (ready === null) {
      const piece = await stream.next()
      if (piece.done) break
      if (piece.value.stream === 'stdout') said += piece.value.text
      ready = /^ready (\S+) (\d+)$/m.exec(said)
    }
  } catch (error) {
    return { error: `its proxy could not start (${error instanceof Error ? error.message : String(error)})` }
  }
  const stop = async (): Promise<string[]> => {
    try { await stream.return(undefined as never) } catch { /* it has ended already */ }
    const noted = await quiet($, ['cat', log])
    await quiet($, ['rm', '-f', log, ...(listen === 'tcp' ? [] : [listen])])
    return noted.exitCode === 0 ? [...new Set(noted.stdout.split('\n').map(one => one.split(' ')[0] ?? '').filter(Boolean))] : []
  }
  if (ready === null) {
    await stop()
    return { error: 'its proxy ended before it was ready' }
  }
  const where = ready[1] ?? ''
  if (listen === 'tcp') {
    const port = Number(where)
    if (!Number.isInteger(port) || port < 1 || port > 65535) { await stop(); return { error: 'its proxy named no port' } }
    return { egress: { kind: 'tcp', port }, stop }
  }
  return { egress: { kind: 'unix', socket: listen, node }, stop }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function quiet($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 30000, complete = false): Promise<{ exitCode: number; stdout: string }> {
  try {
    const ran = await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs })
    return { exitCode: complete && ran.isStdoutTruncated ? 1 : ran.exitCode, stdout: ran.stdout }
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

async function runBoxed($: EngineInterface, argv: string[], cwd: string, timeoutSeconds: number, stdoutOnly = false): Promise<Ran> {
  const started = await $.clock.now()
  const timeoutMs = Math.min(MAX_COMMAND_MS, Math.max(10, timeoutSeconds) * 1000)
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs })
    return { exitCode: ran.exitCode, output: ran.stdout + (!stdoutOnly && ran.stderr ? `\n${ran.stderr}` : ''), isTruncated: ran.isStdoutTruncated || (!stdoutOnly && ran.isStderrTruncated), isTimedOut: false, error: null, ms: (await $.clock.now()) - started }
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

/**
 * The run a request_proof call is for, as this session holds it: the `run` the call named, else the run the calling
 * loop holds for that repository. Null when the session knows nothing of where that run works.
 */
export function hintOf(claims: CodebookClaim[], run: unknown, agentId: string | undefined, repository: string | null): ProofHint | null {
  const number = Number(run)
  const named = Number.isSafeInteger(number) && number > 0 ? claims.find(one => one.run === number) : undefined
  const wanted = repository ? slugOf(repository) : null
  const loop = agentId || undefined
  const held = named ?? claims.filter(one => (one.agentId || undefined) === loop).find(one => wanted === null || one.repos.length === 0 || one.repos.includes(wanted))
  if (!held || (!held.worktree && !held.branch && !held.key)) return null
  return { run: held.run, ...(held.worktree ? { worktree: held.worktree } : {}), ...(held.branch ? { branch: held.branch } : {}), ...(held.key ? { key: held.key } : {}) }
}

/** One working tree of a repository on this computer: its folder, the commit it has checked out and its branch. */
type Tree = { path: string; head: string; branch: string | null }

/** The working trees of the repository `top` belongs to (the main checkout and every linked worktree), as git lists them. */
async function treesOf($: EngineInterface, top: string): Promise<Tree[]> {
  const listed = await quiet($, ['git', '-C', top, 'worktree', 'list', '--porcelain'])
  const trees: (Tree & { gone: boolean })[] = []
  if (listed.exitCode === 0) {
    let at: (Tree & { gone: boolean }) | null = null
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('worktree ')) trees.push((at = { path: line.slice('worktree '.length).trim(), head: '', branch: null, gone: false }))
      else if (at && line.startsWith('HEAD ')) at.head = line.slice('HEAD '.length).trim().toLowerCase()
      else if (at && line.startsWith('branch ')) at.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      else if (at && (line === 'bare' || line.startsWith('prunable'))) at.gone = true
    }
  }
  const kept = trees.filter(one => !one.gone && /^[0-9a-f]{40,64}$/.test(one.head)).map(({ path, head, branch }) => ({ path, head, branch }))
  if (kept.some(one => one.path === top)) return kept
  // An older git, or a list that did not name this folder: the folder itself, as it stands.
  const head = (await quiet($, ['git', '-C', top, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase()
  const branch = (await quiet($, ['git', '-C', top, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(head) ? [...kept, { path: top, head, branch: branch || null }] : kept
}

const NOT_HERE = (repository: string) => `A proof run for ${repository} is waiting, and its code is not in this session's folder or in a folder CodeBook knows on this computer. Open Claude Code in its checkout, or save the folder (Factory settings → Your computer), then run /factory prove.`

/**
 * The folder a proof runs in (P1): the claiming run's own worktree at its pull request's head, never the person's
 * checkout on another branch.
 *
 *   - CodeBook named the commit (`commit`): the working tree of the repository that has it checked out (the run's own
 *     first), else nothing runs.
 *   - The session knows the run (`hint`: its declared worktree, its branch, the story's key): among the repository's
 *     working trees (the declared one, those on the run's branch, those whose branch carries the story's key), the one
 *     whose commit is its branch's tip on origin, the pull request's head. With none at the tip, only the run's own
 *     declared worktree runs (and the summary says what ran is not the head); the person's checkout never does.
 *   - Neither (/factory prove for "Try it", an older flow): the saved checkout, else this session's folder, as before.
 */
export async function proofFolder(
  $: EngineInterface,
  { repository, known, hint, commit, proof }: { repository: string; known: CodebookCheckout[]; hint: ProofHint | null; commit: string | null; proof: number },
): Promise<{ dir: string; notes: string[] } | { refused: string }> {
  const want = commit && /^[0-9a-f]{7,64}$/i.test(commit.trim()) ? commit.trim().toLowerCase() : null
  if (hint === null && want === null) {
    const dir = await checkoutFor($, repository, known)
    return dir === null ? { refused: NOT_HERE(repository) } : { dir, notes: [] }
  }
  const home = (await $.env.get('HOME')) ?? ''
  const expand = (path: string) => path.replace(/^~(?=\/|$)/, home)
  const wanted = repository.toLowerCase()
  const isOurs = async (dir: string): Promise<string | null> => {
    const top = await quiet($, ['git', '-C', dir, 'rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return null
    const origin = await quiet($, ['git', '-C', dir, 'remote', 'get-url', 'origin'])
    return origin.exitCode === 0 && slugOf(origin.stdout) === wanted ? top.stdout.trim() : null
  }
  const declared = hint?.worktree ? await isOurs(expand(hint.worktree)) : null
  const saved = known.filter(one => one.repository.toLowerCase() === wanted && one.checkoutPath !== null).map(one => expand(one.checkoutPath ?? ''))
  const tops: string[] = []
  for (const dir of [...(declared ? [declared] : []), ...saved, '.']) {
    const top = dir === declared ? declared : await isOurs(dir)
    if (top !== null && !tops.includes(top)) tops.push(top)
  }
  if (tops.length === 0) return { refused: NOT_HERE(repository) }
  // Every working tree of the repository on this computer, but the plugin's own baseline worktrees.
  const trees: Tree[] = []
  for (const top of tops) for (const tree of await treesOf($, top)) if (!trees.some(one => one.path === tree.path) && !tree.path.startsWith(`${home}/.codebook/proof/`)) trees.push(tree)
  const describe = (tree: Tree) => `${tree.path} (${tree.branch ?? 'no branch'} at ${tree.head.slice(0, 7)})`
  const checkouts = tops.filter(top => top !== declared).map(top => trees.find(one => one.path === top)).filter((one): one is Tree => one !== undefined)
  const keyed = hint?.key ? new RegExp(`(?:^|[^A-Za-z0-9])${hint.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i') : null
  const rank = (tree: Tree) => (declared !== null && tree.path === declared ? 0 : hint?.branch && tree.branch === hint.branch ? 1 : keyed && tree.branch && keyed.test(tree.branch) ? 2 : 3)
  const byRank = (a: Tree, b: Tree) => rank(a) - rank(b)

  if (want !== null) {
    const at = trees.filter(tree => tree.head.startsWith(want) || want.startsWith(tree.head)).sort(byRank)[0]
    if (at) return { dir: at.path, notes: [] }
    return { refused: `Proof ${proof} is for commit ${want.slice(0, 7)} of ${repository}, and no checkout or worktree of it on this computer has that commit checked out (${trees.slice(0, 4).map(describe).join('; ') || 'none found'}), so nothing ran. Check the commit out in the run's worktree, then run /factory prove ${proof}.` }
  }

  const matches = trees.filter(tree => rank(tree) < 3)
  const run = hint?.run ? `run ${hint.run}` : 'the run that asked'
  if (matches.length === 0) {
    const looked = [hint?.worktree ? `its worktree ${hint.worktree}${declared === null ? ' is not a checkout of it' : ''}` : null, hint?.branch ? `branch ${hint.branch}` : null, hint?.key ? `a branch naming ${hint.key}` : null].filter(Boolean).join(', ')
    const where = checkouts.map(describe).join('; ')
    return { refused: `Proof ${proof} is for ${run} of ${repository}, and no working tree of it on this computer is that run's (${looked}), so nothing ran. ${where ? `Your checkout ${where} is not the pull request's head, and the proof never runs there in its place.` : ''} Say the run's worktree with declare_work (worktree, branch), push its branch, then ask for the proof again (or /factory prove ${proof}).`.replace(/\s+/g, ' ').trim() }
  }
  // The pull request's head is its branch as origin has it: fetched now, once per branch.
  const tips = new Map<string, string | null>()
  for (const branch of [...new Set(matches.map(tree => tree.branch).filter((one): one is string => one !== null))]) {
    const where = matches.find(tree => tree.branch === branch)?.path ?? '.'
    await quiet($, ['git', '-C', where, 'fetch', '--quiet', 'origin', branch], undefined, 20000)
    const tip = (await quiet($, ['git', '-C', where, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).stdout.trim().toLowerCase()
    tips.set(branch, /^[0-9a-f]{40,64}$/.test(tip) ? tip : null)
  }
  const tipOf = (tree: Tree) => (tree.branch ? (tips.get(tree.branch) ?? null) : null)
  const pushed = matches.filter(tree => tipOf(tree) === tree.head).sort(byRank)
  if (pushed.length > 1 && rank(pushed[0] as Tree) === rank(pushed[1] as Tree)) {
    // Two of the same rank at their tips (the story's branches of two runs): the newest commit is the run's work.
    const when = new Map<string, number>()
    for (const tree of pushed) when.set(tree.path, Number((await quiet($, ['git', '-C', tree.path, 'log', '-1', '--format=%ct', 'HEAD'])).stdout.trim()) || 0)
    pushed.sort((a, b) => byRank(a, b) || (when.get(b.path) ?? 0) - (when.get(a.path) ?? 0))
  }
  const best = pushed[0]
  if (best) return { dir: best.path, notes: [] }
  // Nothing is at its pull request's head. The run's own declared worktree still runs, and says so; nothing else does.
  const own = matches.find(tree => declared !== null && tree.path === declared)
  const offHead = (tree: Tree) => {
    const tip = tipOf(tree)
    return tree.branch === null ? `${tree.path} has no branch checked out` : tip === null ? `${tree.branch} is not on origin yet` : `${tree.path} is at ${tree.head.slice(0, 7)} and origin/${tree.branch}, the pull request's head, at ${tip.slice(0, 7)}`
  }
  if (own) return { dir: own.path, notes: [`  Not the pull request's head: ${offHead(own)}, so this proves no pull request's head. Push, then ask for the proof again.`] }
  return { refused: `Proof ${proof} is for ${run} of ${repository}, and no working tree of it on this computer is at its pull request's head (${matches.slice(0, 3).map(offHead).join('; ')}), so nothing ran. Push the branch, then ask for the proof again (or /factory prove ${proof}).` }
}

const CASE_LINE = 'node --test --test-reporter=junit'
const CASE_DIRECTORY = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

// Git and the physical checkout must identify the same directory. Reject untracked
// discovery inputs (including ignored files), symlinks/submodules, partial listings or a changed HEAD.
async function caseDirectory($: EngineInterface, root: string, relative: string, sha: string): Promise<string | null> {
  if (!CASE_DIRECTORY.test(relative) || relative.length > 200 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return null
  const git = (...args: string[]) => quiet($, ['git', '-C', root, ...args], undefined, 30000, true)
  const head = await git('rev-parse', 'HEAD')
  const status = await git('status', '--porcelain')
  const extra = await git('ls-files', '--others', '--directory', '-z', '--', relative)
  if (head.exitCode || head.stdout.trim() !== sha || status.exitCode || status.stdout || extra.exitCode || extra.stdout) return null
  const tree = await git('ls-tree', '-rz', sha, '--', relative)
  if (tree.exitCode || tree.stdout.length > 65536 || !tree.stdout.endsWith('\0')) return null
  const entries = tree.stdout.slice(0, -1).split('\0')
  if (!entries.length || entries.some(entry => !/^100(?:644|755) blob [0-9a-f]+\t/.test(entry) || !entry.slice(entry.indexOf('\t') + 1).startsWith(relative + '/'))) return null
  const base = await quiet($, ['realpath', root])
  const cwd = root + '/' + relative
  const physical = await quiet($, ['realpath', cwd])
  return !base.exitCode && !physical.exitCode && physical.stdout.trimEnd() === base.stdout.trimEnd() + '/' + relative ? cwd : null
}

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// These commands come from the server's routine-check grammar. Execute individual arguments,
// never an arbitrary shell expression. A newer grammar needs a new negotiated capability.
function delegatedCommand(line: string): string[] | null {
  const argv = line.split(' ')
  const env = argv[0] === 'KANBAN_TEST_PG=throwaway' ? [argv.shift()!] : []
  const [program, ...args] = argv
  if (program === 'bash' && !env.length && args.length === 2 && args[0] === 'scripts/smoke.sh'
      && /^test\/smoke\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sh$/.test(args[1] ?? '')) return argv
  if (program !== 'node') return null
  const files = [...args]
  const tests = files[0] === '--test'
  if (tests) {
    files.shift()
    const flags = new Set(['--test-reporter=tap', '--test-force-exit'])
    while (flags.delete(files[0] ?? '')) files.shift()
  }
  if (!files.length || files.length > (tests ? 2 : 1) || files.some(path =>
    !/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:mjs|cjs|js)$/.test(path)
    || /(?:^|\/)(?:run[-_]?all|all[-_]?tests|full[-_]?suite)(?:\.|\/)/i.test(path))) return null
  return [...env, ...argv]
}

const RUNTIME_PATHS = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/share',
  '/lib', '/lib64', '/usr/local/bin', '/usr/local/lib', '/opt/homebrew/bin', '/opt/homebrew/opt', '/opt/homebrew/Cellar']
const TOOL_PATH = '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin'

// A delegated command receives a read-only checkout, fresh HOME/temp and system runtimes.
// The ordinary personal box may use saved host rules and shared caches; this one never starts that proxy.
function delegatedBox(sandbox: Sandbox, dir: string, scratch: string, args: string[], gitDirIsFolder: boolean, metadata: string[] = []): string[] | null {
  if (!sandbox.bin) return null
  const path = metadata.length && sandbox.kind === 'seatbelt' ? '/Applications/Xcode.app/Contents/Developer/usr/bin:/Library/Developer/CommandLineTools/usr/bin:' + TOOL_PATH : TOOL_PATH
  const inner = ['/usr/bin/env', '-i', 'PATH=' + path, 'HOME=' + scratch, 'TMPDIR=' + scratch,
    'CI=1', 'GIT_TERMINAL_PROMPT=0', ...args]
  if (sandbox.kind === 'bubblewrap') return [sandbox.bin, '--unshare-all', '--die-with-parent', '--new-session',
    ...RUNTIME_PATHS.flatMap(path => ['--ro-bind-try', path, path]), '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--ro-bind', dir, dir, ...metadata.flatMap(path => ['--ro-bind', path, path]),
    ...(metadata.length ? [] : gitDirIsFolder ? ['--tmpfs', dir+'/.git'] : ['--ro-bind', '/dev/null', dir+'/.git']),
    '--bind', scratch, scratch, '--chdir', dir, ...inner]
  if (sandbox.kind !== 'seatbelt') return null
  const readable = [...RUNTIME_PATHS, '/System', '/Library/Developer/CommandLineTools', '/usr/libexec', '/Applications/Xcode.app/Contents/Developer/usr', dir, scratch, ...metadata]
  const profile = ['(version 1)', '(allow default)', '(deny file-read* file-write* (subpath "/"))',
    '(allow file-read-metadata)', '(allow file-read* ' + readable.map(path => '(subpath ' + quote(path) + ')').join(' ')
      + ' (literal "/") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (regex #"^/dev/fd/"))',
    '(allow file-write* (subpath '+quote(scratch)+') (literal "/dev/null") (regex #"^/dev/fd/"))',
    ...(metadata.length ? [] : ['(deny file-read* (subpath '+quote(dir+'/.git')+'))']),
    '(deny mach-lookup)', '(deny network*)', ...(metadata.length ? [] : ['(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))'])].join('\n')
  return [sandbox.bin, '-p', profile, ...inner]
}

async function cleanPinned($: EngineInterface, sha: string, box: (argv: string[]) => string[] | null) {
  const git = async (...args: string[]) => {
    const argv = box(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args])
    return argv ? quiet($, argv, undefined, 30000, true) : {exitCode:1, stdout:''}
  }
  const head = await git('rev-parse', 'HEAD')
  // Ordinary cached entries have tag H. Refuse entries Git can omit from worktree checks.
  const index = await git('ls-files', '--cached', '-v', '-z')
  if (index.exitCode !== 0 || !index.stdout.endsWith('\0')
      || !index.stdout.slice(0, -1).split('\0').every(entry => entry.startsWith('H '))) return false
  const status = await git('status', '--porcelain')
  const extra = await git('ls-files', '--others', '--directory', '-z')
  return head.exitCode === 0 && head.stdout.trim() === sha && status.exitCode === 0 && !status.stdout
    && extra.exitCode === 0 && !extra.stdout
}

async function runDelegated($: EngineInterface, target: ProofWaiting, work: ProofWork, dir: string, sandbox: Sandbox) {
  const steps = work.steps ?? [], sha = work.expected_commit ?? ''
  const refused = 'Delegated proof requires a supported native sandbox, clean exact checkout and bounded loopback check without setup or baseline.'
  const valid = target.delegated_focused_version === 1 && target.commit === sha && FULL_COMMIT.test(sha) && !!sandbox.bin
    && work.proof_scope === 'focused' && work.repository?.full_name.toLowerCase() === target.repository.toLowerCase() && work.recipe?.network === 'loopback'
    && work.recipe.install === '' && (!work.recipe.hosts || (Array.isArray(work.recipe.hosts) && !work.recipe.hosts.length))
    && steps.length > 0 && steps.length === target.commands.length && steps.every(s => typeof s.line === 'string' && target.commands.includes(s.name) && s.delegated_focused === true && !s.case_report && s.baseline === false
      && s.for_run == null && Number.isSafeInteger(s.timeout_seconds) && s.timeout_seconds >= 10 && s.timeout_seconds <= 360
      && !!delegatedCommand(s.line))
  const outcomes: StepOutcome[] = [], notes: string[] = []
  for (const step of steps) {
    let ran: Ran = { exitCode:null, output:'', isTruncated:false, isTimedOut:false, error:refused, ms:0 }
    let pinned = false
    if (valid) {
      const temp = await quiet($, ['/usr/bin/mktemp', '-d', '/tmp/codebook-delegated-XXXXXXXX'])
      const scratch = temp.stdout.trim()
      if (!temp.exitCode && /^\/tmp\/codebook-delegated-[A-Za-z0-9]+$/.test(scratch)) {
        try {
          // Seatbelt matches physical paths; macOS /tmp is a symlink to /private/tmp.
          const physical = (await quiet($, ['realpath', scratch])).stdout.trim()
          const checkout = (await quiet($, ['realpath', dir])).stdout.trim()
          const gitDir = await quiet($, ['git', '-C', dir, 'rev-parse', '--absolute-git-dir'])
          const gitCommon = await quiet($, ['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
          const metadata = [...new Set([gitDir.stdout.trim(), gitCommon.stdout.trim()])]
          const standalone = gitDir.stdout.trim() === checkout+'/.git'
          if (checkout.startsWith('/') && checkout !== '/' && checkout !== await $.env.get('HOME') && !gitDir.exitCode && !gitCommon.exitCode
              && metadata.every(path => path.startsWith('/') && /\/\.git(?:\/worktrees\/[^/]+)?$/.test(path))
              && (physical === scratch || physical === '/private'+scratch)) {
            const validation = (args: string[]) => delegatedBox(sandbox, checkout, physical, ['git', '-C', checkout, ...args.slice(1)], standalone, metadata)
            const command = delegatedCommand(step.line)
            const argv = command ? delegatedBox(sandbox, checkout, physical, command, standalone) : null
            if (argv && await cleanPinned($, sha, validation)) {
              ran = await runBoxed($, argv, checkout, step.timeout_seconds)
              pinned = await cleanPinned($, sha, validation)
              if (!pinned) ran = { ...ran, exitCode:null, output:'', error:refused }
            }
          }
        } finally {
          await quiet($, ['/bin/rm', '-rf', scratch])
        }
      }
    }
    const output = ran.output.slice(-MAX_SENT_OUTPUT)
    const sent = await report($, work, {run:step.run, delegated_focused_version:1, network:'loopback',
      sandbox:sandbox.kind, exit_code:ran.exitCode, output, output_sha256:await sha256Hex(output),
      commit:pinned ? sha : null, dirty:!pinned, duration_ms:ran.ms, timed_out:ran.isTimedOut, ...(ran.error ? {error:ran.error} : {})})
    if (!sent.ok) notes.push('CodeBook did not record ' + step.name + ': ' + sent.message)
    outcomes.push({name:step.name, baseline:step.baseline, status:ran.error ? 'not run: '+ran.error : (sent.status ?? 'not recorded'),
      exitCode:ran.exitCode, tests:sent.tests ?? 0, newFailures:null, isDirty:!pinned, commit:pinned ? sha : null})
  }
  return {isRun:true, text:summaryOf(target.repository, sandbox, outcomes, notes, 'Network: local loopback only.')}
}

/** What is waiting for this person's computer, without taking any of it. */
export async function waitingProofs($: EngineInterface): Promise<{ ok: true; waiting: ProofWaiting[] } | { ok: false; message: string }> {
  let peeked = await call<{ waiting?: ProofWaiting[] }>($, 'claim_proof', { peek: true, signed_in_billing_version: 1 })
  if (!peeked.ok && /unknown|unexpected|unrecognized/i.test(peeked.message)) {
    peeked = await call<{ waiting?: ProofWaiting[] }>($, 'claim_proof', { peek: true })
  }
  if (!peeked.ok) return { ok: false, message: peeked.message }
  return { ok: true, waiting: peeked.data.waiting ?? [] }
}

/** One line per step, for the person and for the model: what CodeBook recorded, in its words. */
export function summaryOf(repository: string, sandbox: Sandbox, outcomes: StepOutcome[], notes: string[], network: string | null = null): string {
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
  return [`CodeBook proof run for ${repository} (run by the plugin on this computer, ${boxed}; recorded as verified evidence):`, ...lines, ...(network ? [network] : []), ...notes].join('\n')
}

/**
 * Take one proof and run it. `proof` names it; without it the oldest one waiting is taken. `known` are the checkouts
 * CodeBook last told this session; `hosts` the person's own list of allowed hosts (the `proof_hosts` option). → the
 * summary, or why nothing ran.
 */
export async function runProof($: EngineInterface, { proof = null, known = [], hosts = null, hint = null, expected, authorized }: { proof?: number | null; expected?: { repository: string; commit: string }; authorized?: () => Promise<boolean>; known?: CodebookCheckout[]; hosts?: unknown; hint?: ProofHint | null }): Promise<{ isRun: boolean; text: string }> {
  const peeked = await waitingProofs($)
  if (!peeked.ok) return { isRun: false, text: peeked.message }
  const target = proof === null ? peeked.waiting[0] : peeked.waiting.find(one => one.proof === proof)
  if (!target) return { isRun: false, text: proof === null ? 'No proof run is waiting for this computer.' : `Proof run ${proof} is not waiting for this computer (it may already have been run, or it was asked for someone else's).` }

  if (expected && (target.repository !== expected.repository || target.commit !== expected.commit || target.commands.length !== 1 || target.commands[0] !== 'test')) {
    return {isRun:false, text:`Proof ${proof} is waiting for a matching own-test, repository and exact commit.`}
  }
  if (target.signed_in_billing_version !== undefined) {
    if (expected || target.signed_in_billing_version !== 1 || target.commands.length !== 1 ||
        target.commands[0] !== 'signed_in_billing' || !FULL_COMMIT.test(target.commit ?? '')) {
      return {isRun:false, text:'The signed-in billing proof requires its supported native profile.'}
    }
    if (authorized && !await authorized()) return {isRun:false,text:'The proof route changed before the browser claim.'}
    const claimed = await call<ProofWork>($, 'claim_proof', {proof:target.proof, signed_in_billing_version:1})
    if (!claimed.ok) return {isRun:false,text:claimed.message}
    const work = claimed.data
    const step = work.steps?.[0]
    const plan = step?.signed_in_billing
    if (work.proof !== target.proof || work.proof_scope !== 'signed_in_billing_v1' || !work.token || !work.report_url ||
        work.steps?.length !== 1 || step?.name !== 'signed_in_billing' || !plan || !Array.isArray(plan.products) ||
        plan.products.length !== 2 || work.repository?.full_name !== target.repository || work.expected_commit !== target.commit ||
        !plan.products.some(p => p.repository === target.repository && p.commit === target.commit)) {
      return {isRun:false,text:'The signed-in billing claim no longer matches its approved source.'}
    }
    let result: Record<string, unknown> = {fixture_profile:plan.fixture_profile,definition:plan.definition,unavailable:'fixture_unavailable'}
    if (plan.fixture_profile === 'synthetic_billing_v1') {
      const directories = await Promise.all(plan.products.map(p => checkoutFor($, p.repository, known)))
      try {
        const child = $.process.spawn({argv:['/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
          'node', `${$.plugin.root}/scripts/signed-billing.mjs`, JSON.stringify({plan,directories})]})
        let output = ''
        for await (const chunk of child) {
          if (chunk.stream === 'stdout') output += chunk.text
          if (output.length > 16384) throw Error('Oversized receipt')
        }
        result = JSON.parse(output)
      } catch { result.unavailable = 'capture_failed' }
    }
    const sent = await report($,work,{...result,run:step.run})
    return {isRun:true,text:sent.ok ? `Signed-in billing proof ${target.proof}: ${sent.status}.` : 'The billing receipt could not be recorded.'}
  }
  const delegated = target.delegated_focused_version !== undefined
  const delegatedSandbox = delegated ? await findSandbox($) : null
  if (delegated && (target.delegated_focused_version !== 1 || !delegatedSandbox?.bin || !FULL_COMMIT.test(target.commit ?? ''))) {
    return { isRun:false, text:'The waiting delegated proof requires protocol version 1, a native sandbox and a full commit.' }
  }

  // Where the run that asked works (P1): what CodeBook says of it first, then what this session holds.
  const sent = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const fromServer = { worktree: sent(target.worktree), branch: sent(target.branch) }
  const asked: ProofHint | null = hint || fromServer.worktree || fromServer.branch
    ? { ...hint, run: typeof target.run === 'number' ? target.run : (hint?.run ?? null), ...(fromServer.worktree ? { worktree: fromServer.worktree } : {}), ...(fromServer.branch ? { branch: fromServer.branch } : {}) }
    : null
  const placed = await proofFolder($, { repository: target.repository, known, hint: asked, commit: target.commit, proof: target.proof })
  if ('refused' in placed) return { isRun: false, text: placed.refused }
  const dir = placed.dir

  // The commit that is checked out, whether anything is uncommitted, and the default branch as this git knows it.
  if (delegated && delegatedSandbox) {
    if (authorized && !await authorized()) return {isRun:false, text:"The recovery route changed before the proof claim."}
    const claimed = await call<ProofWork>($, 'claim_proof', {proof:target.proof, delegated_focused_version:1})
    if (!claimed.ok) return {isRun:false, text:claimed.message}
    const work = claimed.data
    if (work.proof !== target.proof || !work.token || !work.report_url || !work.steps) return {isRun:false, text:'The delegated proof was unavailable.'}
    return runDelegated($, target, work, dir, delegatedSandbox)
  }

  const head = (await quiet($, ['git', '-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
  const status = await quiet($, ['git', '-C', dir, 'status', '--porcelain'])
  const isDirty = status.exitCode !== 0 || status.stdout.trim() !== ''
  const branch = target.default_branch ?? 'main'
  await quiet($, ['git', '-C', dir, 'fetch', '--quiet', 'origin', branch], undefined, 20000)
  const base = (await quiet($, ['git', '-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).stdout.trim()

  if (expected && (head !== expected.commit || isDirty || (authorized && !await authorized()))) {
    return {isRun:false, text:"The recovery proof requires a clean checkout at its authorized commit and a current route."}
  }
  const claimed = await call<ProofWork>($, 'claim_proof', { proof: target.proof, ...(target.case_report_version === 1 ? {case_report_version:1} : {}), ...(/^[0-9a-f]{40,64}$/.test(base) ? { base: { ref: branch, commit: base } } : {}) })
  if (!claimed.ok) return { isRun: false, text: claimed.message }
  const work = claimed.data
  if (work.proof === null || !work.token || !work.report_url || !work.steps) return { isRun: false, text: 'The proof run was taken by another session first.' }

  if (expected && (work.proof !== target.proof || work.expected_commit !== expected.commit
      || work.repository?.full_name !== expected.repository || !work.steps.some(s => !s.baseline && s.name === 'test')
      || work.steps.some(s => !s.baseline && s.name !== 'test'))) {
    return {isRun:false, text:"The proof claim no longer matches the recovery target."}
  }
  if (work.steps.some(step => step.delegated_focused !== undefined && step.delegated_focused !== false)) {
    return runDelegated($, target, work, dir, {kind:'none', bin:null})
  }

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
  const outcomes: StepOutcome[] = []
  const notes: string[] = [...placed.notes]
  const reach = reachOf(work.recipe, hosts)
  for (const one of reach.refused.slice(0, 10)) notes.push(`  Left out of the allowed hosts (${one.from}): ${one.entry}, as ${one.reason}.`)
  // A list of hosts needs the proxy; without it the run reaches the computer itself alone, never more.
  let egress: Egress | null = null
  let stopEgress: (() => Promise<string[]>) | null = null
  if (reach.network === 'hosts') {
    const lifetimeMs = Math.min(4 * 60 * 60 * 1000, (work.steps ?? []).reduce((sum, step) => sum + Math.min(MAX_COMMAND_MS, Math.max(10, step.timeout_seconds) * 1000), 0) + 10 * 60 * 1000)
    const started = await startEgress($, { rules: reach.rules, sandbox, cache, proof: work.proof, lifetimeMs })
    if ('error' in started) {
      notes.push(`  The allowed hosts were not reachable: ${started.error}, so the checks reached this computer only.`)
      reach.network = 'loopback'
      reach.rules = []
    } else {
      egress = started.egress
      stopEgress = started.stop
    }
  }
  const network = reach.network
  const box = (line: string, cwd: string, dirs: string[], wanted: string = network, stdoutOnly = false) => boxedArgv({stdoutOnly, sandbox, line, cwd, dirs, home, hidden, network: wanted, env: environment, egress })
  const send = async (step: ProofStep, ran: Ran | null, commit: string | null, dirty: boolean): Promise<void> => {
    const complete = Boolean(step.case_report && ran && !ran.isTruncated && ran.output && ran.output.length <= 60000 && new TextEncoder().encode(ran.output).length <= 60000)
    const output = step.case_report ? (complete ? ran!.output : '') : ran?.output.slice(-MAX_SENT_OUTPUT) ?? ''
    const answered = await report($, work, ran === null
      ? { run: step.run, skipped: true }
      : { run: step.run, ...(step.case_report ? {case_report:step.case_report, case_checkout:dir, complete} : {}), exit_code: ran.exitCode, output, output_sha256: await sha256Hex(output), commit, dirty, duration_ms: ran.ms, sandbox: sandbox.kind, ...(network === 'hosts' && !step.case_report ? { network, hosts: reach.rules.map(ruleText) } : {}), timed_out: ran.isTimedOut, ...(ran.error ? { error: ran.error } : {}), ...(/^[0-9a-f]{40,64}$/.test(base) ? { base_commit: base } : {}) })
    if (!answered.ok) notes.push(`  ${step.name}${step.baseline ? ' (default branch)' : ''}: CodeBook did not record it — ${answered.message}`)
    outcomes.push({ name: step.name, baseline: step.baseline, status: answered.status ?? (ran === null ? 'not run' : 'not recorded'), exitCode: ran?.exitCode ?? null, tests: answered.tests ?? 0, newFailures: answered.newFailures ?? null, isDirty: dirty, commit })
  }

  const steps = work.steps
  // A proof whose every step is the default branch (a dry run of the recipe) runs in the checkout as it stands.
  const isAllBaseline = steps.every(step => step.baseline)
  let refusedHosts: string[] = []
  try {
    for (const step of steps.filter(one => isAllBaseline || !one.baseline)) {
      await $.ui.status(`CodeBook proof: ${step.name}…`)
      if (step.case_report) {
        const descriptor = step.case_report, sha = work.expected_commit ?? ''
        const valid = descriptor.version === 1 && step.line === CASE_LINE && !step.baseline
          && sandbox.kind !== 'none' && Number.isSafeInteger(descriptor.definition) && Number.isSafeInteger(descriptor.revision)
          && /^[0-9a-f]{64}$/.test(descriptor.hash)
        const cwd = valid ? await caseDirectory($, dir, descriptor.directory, sha) : null
        const refused: Ran = { exitCode:null, output:'', isTruncated:false, isTimedOut:false, error:'The approved case directory or clean pinned checkout could not be verified.', ms:0 }
        if (!cwd) { await send(step, refused, null, true); continue }
        const ran = await runBoxed($, box(CASE_LINE, cwd, [cache], 'loopback', true), cwd, step.timeout_seconds, true)
        const unchanged = Boolean(await caseDirectory($, dir, descriptor.directory, sha))
        await send(step, unchanged ? ran : refused, unchanged ? sha : null, !unchanged)
        continue
      }
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
  } finally {
    if (stopEgress) refusedHosts = await stopEgress()
  }
  await $.ui.status(undefined)
  if (isDirty) notes.push('  The checkout had uncommitted changes, so these results are evidence of no commit: commit, then ask for the proof again.')
  if (work.expected_commit && head && !head.startsWith(work.expected_commit) && !work.expected_commit.startsWith(head)) notes.push(`  CodeBook asked about commit ${work.expected_commit.slice(0, 7)}; the checkout is at ${head.slice(0, 7)}, which is what ran.`)
  return { isRun: true, text: summaryOf(target.repository, sandbox, outcomes, notes, reachLine(reach, sandbox, refusedHosts)) }
}

/** The failed check again, on the default branch, in a worktree of its own. Nothing of the person's checkout is touched. */
async function runBaseline(
  $: EngineInterface,
  { dir, cache, baseline, work, box }: { dir: string; cache: string; baseline: ProofStep; work: ProofWork; box: (line: string, cwd: string, dirs: string[], wanted?: string) => string[] },
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
