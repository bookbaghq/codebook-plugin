// Where a push or pull request really goes, and whether something that does not say "push" pushes anyway: the
// repository guard's lookups (register.tsx decides). guard.ts reads the command's words; this asks git, gh, the files
// and the session's shell what those words mean, the way git and gh themselves would resolve them:
//
//   git push (no remote)         branch.<name>.pushRemote, then remote.pushDefault, then branch.<name>.remote, then origin
//   git push <address>           url.<base>.pushInsteadOf, else url.<base>.insteadOf, applied to the address
//   git push <remote>            every push address of the remote (`git remote get-url --push --all`, which applies them)
//   gh pr create (no --repo)     GH_REPO, then `gh repo set-default` (remote.<name>.gh-resolved), then the only remote;
//                                several remotes and no default: refused (gh itself would ask which one)
//   git <alias>                  alias.<name>: refused when it runs a shell (`!…`) or reads as a push
//   gh <alias> / gh <extension>  an alias whose expansion opens a pull request, calls the API or runs a shell, and every
//                                extension (a program the guard cannot read): refused
//   a script                     its file, its package.json script (with its pre/post scripts), a Makefile: refused
//                                when its text reads as a push
//   the session's environment    GH_REPO counts as gh's; GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* refuse a push
//
// What cannot be looked up is refused: the guard only ever refuses, and never guesses where a push goes.

import type { EngineInterface } from 'claude-code'

import { HOME_PREFIX, isPushLike, isRiskyGitVar, readCommand, repoOf, scriptPushes } from './guard'
import type { Check, Target } from './guard'

/** A reason to refuse, as the person reads it after "CodeBook: ". */
export type Refusal = { deny: string }

/** The variables of the session's shell that can change where a push or pull request goes. */
export type ShellEnv = Map<string, string>

const WATCHED = ['GH_REPO', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']

/** A folder as the command sees it: absolute, with the home folder expanded and relative to the session's folder. */
export async function folderOf($: EngineInterface, cwd: string | null): Promise<string> {
  const base = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  return cwd === null ? base : cwd.replace(HOME_PREFIX, home).replace(/^(?!\/)/, `${base}/`)
}

async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  const got = await $.process.run(argv)
  return got.exitCode === 0 ? got.stdout : null
}

async function gitIn($: EngineInterface, dir: string, args: string[]): Promise<string | null> {
  return run($, ['git', '-C', dir, ...args])
}
const lines = (text: string | null): string[] => (text ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')

function keep(out: ShellEnv, name: string, value: string | undefined): void {
  if (typeof value === 'string' && value !== '') out.set(name, value)
}

/** What the session's shell defines that can change a command: its variables, its aliases, its function names. */
export type Shell = { env: ShellEnv; aliases: Map<string, string>; functions: Set<string>; ok: boolean; kind: string }

let cached: { at: number; shell: Shell } | null = null
const CACHE_MS = 10 * 60 * 1000

/**
 * The session shell as Claude Code's Bash sees it (it starts from the person's shell profile): the variables that can
 * change where a push goes (GH_REPO, GIT_*), its aliases and its function names. Asked of an interactive shell once
 * every ten minutes, for at most five seconds (perl's alarm: macOS has no `timeout`); `ok` false when it did not
 * answer, and the hooks' own environment is all there is. Only those names and the aliases are kept.
 */
export async function shellState($: EngineInterface): Promise<Shell> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.shell
  const env: ShellEnv = new Map()
  // The hooks' own environment first (each name literal: the runtime lists what a module reads).
  keep(env, 'GH_REPO', await $.env.get('GH_REPO'))
  keep(env, 'GIT_DIR', await $.env.get('GIT_DIR'))
  keep(env, 'GIT_WORK_TREE', await $.env.get('GIT_WORK_TREE'))
  keep(env, 'GIT_COMMON_DIR', await $.env.get('GIT_COMMON_DIR'))
  keep(env, 'GIT_NAMESPACE', await $.env.get('GIT_NAMESPACE'))
  keep(env, 'GIT_CONFIG', await $.env.get('GIT_CONFIG'))
  keep(env, 'GIT_CONFIG_GLOBAL', await $.env.get('GIT_CONFIG_GLOBAL'))
  keep(env, 'GIT_CONFIG_SYSTEM', await $.env.get('GIT_CONFIG_SYSTEM'))
  keep(env, 'GIT_CONFIG_COUNT', await $.env.get('GIT_CONFIG_COUNT'))
  keep(env, 'GIT_CONFIG_PARAMETERS', await $.env.get('GIT_CONFIG_PARAMETERS'))
  keep(env, 'GIT_INDEX_FILE', await $.env.get('GIT_INDEX_FILE'))
  keep(env, 'GIT_OBJECT_DIRECTORY', await $.env.get('GIT_OBJECT_DIRECTORY'))
  const shellPath = (await $.env.get('SHELL')) || '/bin/zsh'
  const kind = shellPath.replace(/^.*\//, '')
  const vars = WATCHED.map(name => `printf '@env %s=%s\n' ${name} "$${name}"`).join('; ')
  const listing = kind === 'zsh'
    ? `alias | sed 's/^/@alias /'; print -rl -- \${(k)functions} | sed 's/^/@fn /'`
    : kind === 'bash'
      ? `alias | sed 's/^alias /@alias /'; compgen -A function | sed 's/^/@fn /'`
      : ''
  const got = await $.process.run(['perl', '-e', 'alarm 5; exec @ARGV', shellPath, '-ic', `${vars}; ${listing}`])
  const aliases = new Map<string, string>()
  const functions = new Set<string>()
  const ok = got.exitCode === 0
  if (ok) {
    for (const line of lines(got.stdout)) {
      if (line.startsWith('@env ')) {
        const rest = line.slice(5)
        const at = rest.indexOf('=')
        const name = rest.slice(0, at)
        if (WATCHED.includes(name) && rest.slice(at + 1) !== '') env.set(name, rest.slice(at + 1))
      } else if (line.startsWith('@alias ')) {
        const m = /^([^=\s]+)=(.*)$/.exec(line.slice(7))
        if (m) aliases.set(m[1] ?? '', (m[2] ?? '').replace(/^'([\s\S]*)'$/, '$1').replace(/'\\''/g, "'"))
      } else if (line.startsWith('@fn ')) {
        functions.add(line.slice(4))
      }
    }
  }
  const shell: Shell = { env, aliases, functions, ok, kind }
  cached = { at: Date.now(), shell }
  return shell
}

/** For tests: forget the probed shell. */
export function forgetShell(): void {
  cached = null
}

/** A shell function's body, asked of the shell (zsh `whence -f`, bash `declare -f`), or null. */
async function functionBody($: EngineInterface, kind: string, name: string): Promise<string | null> {
  if (!/^[A-Za-z_][\w:-]*$/.test(name)) return null
  const shellPath = (await $.env.get('SHELL')) || '/bin/zsh'
  return run($, ['perl', '-e', 'alarm 5; exec @ARGV', shellPath, '-ic', kind === 'zsh' ? `whence -f ${name}` : `declare -f ${name}`])
}

const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '-R', '--repo'])

/** Whether a line hands git, gh or hub its command word from a variable (`git "$@"`, `gh $cmd`); option values aside. */
function expandsCommandWord(line: string): boolean {
  const words = line.trim().split(/\s+/)
  for (let at = 0; at < words.length; at++) {
    if (!/^(?:\S*\/)?(?:git|gh|hub)$/.test(words[at] ?? '')) continue
    let next = at + 1
    while (next < words.length && (words[next] ?? '').startsWith('-')) next += VALUE_OPTIONS.has(words[next] ?? '') ? 2 : 1
    if (/^["']?\$/.test(words[next] ?? '')) return true
  }
  return false
}

/** Whether a shell function's body (as the shell prints it) pushes, or runs git or gh in a way the guard cannot read. */
function functionPushes(body: string): boolean {
  if (scriptPushes(body)) return true
  const inner = body.split('\n').slice(1, -1).join('\n')
  const read = readCommand(inner)
  return read === null ? body.split('\n').some(expandsCommandWord) : read.targets.length > 0
}

/**
 * The words of the command that are the person's own shell aliases or functions (`gp` for `git push fork`): refused
 * when what they run mentions git or gh (the guard cannot follow it); null otherwise.
 */
export async function checkShellWords($: EngineInterface, words: string[], shell: Shell): Promise<Refusal | null> {
  for (const word of new Set(words)) {
    const alias = shell.aliases.get(word)
    if (alias !== undefined && /\b(?:git|gh|hub)\b/.test(alias)) return { deny: `${word} is a shell alias for "${alias.slice(0, 120)}", which the guard cannot follow. Run git or gh itself (git push <remote> <branch>, gh pr create --repo <owner/name>).` }
    if (shell.functions.has(word)) {
      const body = await functionBody($, shell.kind, word)
      // Refused when it pushes, or hands git or gh its command word from a variable (`git "$@"`); `git -C "$dir" fetch` is fine.
      if (body === null || functionPushes(body)) return { deny: `${word} is a shell function${body === null ? ' the guard could not read' : ' that runs git or gh'}, which the guard cannot follow. Run git or gh itself.` }
    }
  }
  return null
}

/** The session shell's variables, as `reaches` takes them (shellState's `env`). */
export async function shellEnv($: EngineInterface): Promise<ShellEnv> {
  return (await shellState($)).env
}

/** An address rewritten as git rewrites it for a push: the longest pushInsteadOf prefix, else the longest insteadOf. */
export async function rewritten($: EngineInterface, dir: string, address: string): Promise<string> {
  const rules = lines(await gitIn($, dir, ['config', '--get-regexp', '^url\\..*\\.(pushinsteadof|insteadof)$']))
    .map(line => {
      const space = line.indexOf(' ')
      const key = line.slice(0, space)
      const prefix = line.slice(space + 1)
      const isPush = /\.pushinsteadof$/i.test(key)
      return { base: key.replace(/^url\./i, '').replace(/\.(?:push)?insteadof$/i, ''), prefix, isPush }
    })
    .filter(rule => rule.prefix !== '' && address.startsWith(rule.prefix))
  const longest = (list: typeof rules) => list.sort((a, b) => b.prefix.length - a.prefix.length)[0]
  const rule = longest(rules.filter(one => one.isPush)) ?? longest(rules.filter(one => !one.isPush))
  return rule ? rule.base + address.slice(rule.prefix.length) : address
}

/** The remote a plain `git push` uses in `dir`, as git picks it; a configured value may itself be an address. */
export async function defaultRemote($: EngineInterface, dir: string): Promise<string> {
  const branch = lines(await gitIn($, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))[0] ?? null
  return (branch ? await configValue($, dir, `branch.${branch}.pushRemote`) : null) ?? (await configValue($, dir, 'remote.pushDefault')) ?? (branch ? await configValue($, dir, `branch.${branch}.remote`) : null) ?? 'origin'
}

async function configValue($: EngineInterface, dir: string, key: string): Promise<string | null> {
  return lines(await gitIn($, dir, ['config', '--get', key]))[0] ?? null
}

const isAddress = (remote: string): boolean => remote.includes('/') || remote.includes(':')

/** The repositories one remote or address reaches for a push, as `owner/name` (null for one that is not GitHub's). */
async function pushReaches($: EngineInterface, dir: string, remote: string): Promise<Array<string | null>> {
  if (isAddress(remote)) return [repoOf(await rewritten($, dir, remote))]
  const urls = lines(await gitIn($, dir, ['remote', 'get-url', '--push', '--all', remote]))
  return urls.length > 0 ? urls.map(url => repoOf(url)) : [null]
}

/**
 * The repositories a push or pull request reaches, as `owner/name` (null for one the guard cannot tell), or a refusal
 * when the way it is set up cannot be read with confidence.
 */
export async function reaches($: EngineInterface, target: Target, env: ShellEnv): Promise<Array<string | null> | Refusal> {
  const dir = await folderOf($, target.cwd)
  if (target.kind === 'push') {
    const risky = [...env.keys()].filter(name => name !== 'GH_REPO' && isRiskyGitVar(name))
    if (risky.length > 0) return { deny: `this session's shell sets ${risky.join(', ')}, so git may push from or to somewhere else than the folder says. Unset ${risky.length === 1 ? 'it' : 'them'} for this session, then push again.` }
    // push.recurseSubmodules=on-demand / only makes a push reach each submodule's remote too.
    const recurse = await configValue($, dir, 'push.recurseSubmodules')
    if (recurse !== null && /^(?:on-demand|only)$/i.test(recurse)) return { deny: 'this repository pushes its submodules too (push.recurseSubmodules), where the guard cannot follow. Push with --recurse-submodules=no.' }
    return pushReaches($, dir, target.remote ?? (await defaultRemote($, dir)))
  }
  if (target.repo) return [repoOf(target.repo)]
  const fromEnv = target.ghRepoUnset ? undefined : env.get('GH_REPO')
  if (fromEnv) return [repoOf(fromEnv)]
  // gh's default repository for this folder (`gh repo set-default`): the remote marked "base", or a repository named.
  for (const line of lines(await gitIn($, dir, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']))) {
    const [key = '', value = ''] = line.split(/\s+/)
    const name = key.replace(/^remote\./, '').replace(/\.gh-resolved$/, '')
    if (value === 'base') return fetchReaches($, dir, name)
    if (repoOf(value)) return [repoOf(value)]
  }
  const remotes = lines(await gitIn($, dir, ['remote']))
  if (remotes.length === 1) return fetchReaches($, dir, remotes[0] ?? 'origin')
  if (remotes.length === 0) return [null]
  return { deny: `gh pr create names no repository, and this folder has ${remotes.length} remotes (${remotes.join(', ')}) and no default, so gh would choose one itself. Open it with gh pr create --repo <owner/name>.` }
}

async function fetchReaches($: EngineInterface, dir: string, remote: string): Promise<Array<string | null>> {
  const urls = lines(await gitIn($, dir, ['remote', 'get-url', '--all', remote]))
  return urls.length > 0 ? urls.map(url => repoOf(url)) : [null]
}

/** A file's text, at most 200 KB, or null when it cannot be read. */
async function textOf($: EngineInterface, path: string): Promise<string | null> {
  return run($, ['head', '-c', '200000', path])
}

/** The scripts a package-manager verb runs: its pre/post scripts; `version` and `install` their lifecycle ones. */
const LIFECYCLE: Record<string, string[]> = {
  version: ['preversion', 'version', 'postversion'],
  install: ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'],
}

/** An npm-like script with its pre/post scripts, following `npm run <other>` inside it, at most 4 deep. */
function scriptText(scripts: Record<string, unknown>, name: string, depth = 0): string {
  if (depth > 3) return 'git push'
  const keys = LIFECYCLE[name] ?? ['pre' + name, name, 'post' + name]
  const own = keys.map(key => (typeof scripts[key] === 'string' ? String(scripts[key]) : '')).join('\n')
  const nested = [...own.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:_.-]+)/g)].map(m => m[1] ?? '').filter(other => other !== name && other in scripts)
  return [own, ...nested.map(other => scriptText(scripts, other, depth + 1))].join('\n')
}

/** Whether a script's text pushes: its git or gh lines, and, read as shell commands, any push or pull request in it. */
function textPushes(text: string, isShell: boolean): boolean {
  if (scriptPushes(text)) return true
  if (!isShell) return false
  const read = readCommand(text)
  return read === null || read.targets.length > 0
}

const isShellScript = (path: string, text: string): boolean => /\.(?:sh|bash|zsh|ksh)$/.test(path) || /^#!.*\b(?:sh|bash|zsh|ksh|dash)\b/.test(text) || !/\.[A-Za-z0-9]+$/.test(path.replace(/^.*\//, ''))

/** Whether a check pushes, as far as its text says: a refusal when it does (or cannot be read), else null. */
export async function checkOne($: EngineInterface, check: Check, commandPushes = false): Promise<Refusal | null> {
  if ('isLost' in check && check.isLost) return { deny: 'this command runs a script, an alias or a make target in a folder (or a workspace) the guard cannot tell, so it cannot read what runs. Run it in its folder on its own.' }
  if (check.kind === 'git-alias') {
    const dir = await folderOf($, check.cwd)
    // Follow an alias of an alias (`p` = `q`, `q` = `push`), at most five deep.
    let name = check.name
    for (let depth = 0; depth < 5; depth++) {
      const alias = lines(await gitIn($, dir, ['config', '--get', `alias.${name}`]))[0]
      if (alias === undefined) return null
      if (alias.startsWith('!') || isPushLike(alias)) return { deny: `git ${check.name} is an alias for "${alias.slice(0, 120)}", which the guard cannot follow. Run the git command itself (git push <remote> <branch>).` }
      name = alias.split(/\s+/)[0] ?? ''
    }
    return { deny: `git ${check.name} is an alias of an alias, more than five deep. Run the git command itself.` }
  }
  if (check.kind === 'gh') {
    const aliases = lines(await run($, ['gh', 'alias', 'list']))
    for (const line of aliases) {
      const at = line.indexOf(':')
      if (at < 0 || line.slice(0, at).trim() !== check.name) continue
      const expansion = line.slice(at + 1).trim()
      if (expansion.startsWith('!') || /\bpr\s+(?:create|new)\b|\bapi\b|\brepo\s+create\b|\balias\b/.test(expansion)) return { deny: `gh ${check.name} is an alias for "${expansion.slice(0, 120)}". Run the gh command itself (gh pr create --repo <owner/name>).` }
      return null
    }
    const extensions = lines(await run($, ['gh', 'extension', 'list']))
    if (extensions.some(line => new RegExp(`(^|\\s)gh[ -]${check.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(line))) {
      return { deny: `gh ${check.name} is a gh extension, a program the guard cannot read, so it was not run while a CodeBook run is held. Run it after the run is reported, or use git and gh themselves.` }
    }
    return null
  }
  const dir = await folderOf($, check.cwd)
  if (check.kind === 'hooks') {
    // The repository's hooks run with any git command (pre-commit, pre-push, post-commit…): one that pushes is refused.
    const where = lines(await gitIn($, dir, ['rev-parse', '--git-path', 'hooks']))[0]
    if (where === undefined) return null
    const hooksDir = where.startsWith('/') ? where : `${dir}/${where}`
    for (const hook of lines(await run($, ['ls', '-1', hooksDir])).filter(name => !name.endsWith('.sample'))) {
      const text = await textOf($, `${hooksDir}/${hook}`)
      if (text !== null && textPushes(text, true)) return { deny: `this repository's ${hook} hook pushes or opens a pull request, and git runs it with this command. The guard cannot follow it while a CodeBook run is held: remove or rename ${hooksDir}/${hook}, or run with --no-verify where git allows it.` }
    }
    return null
  }
  if (check.kind === 'file') {
    const path = (check.path.startsWith('/') || HOME_PREFIX.test(check.path) ? await folderOf($, check.path) : `${dir}/${check.path}`).replace(/\/(?:\.\/)+/g, '/')
    const text = await textOf($, path)
    // A script the same command writes and runs (`cat > d.sh <<'EOF' … git push … EOF; sh d.sh`) is not there yet.
    if (text === null) return commandPushes ? { deny: `${check.path} does not exist yet, and this command pushes: the guard cannot read a script before it is written. Write it first, then run it on its own.` } : null
    if (textPushes(text, isShellScript(path, text))) return { deny: `${check.path} pushes or opens a pull request inside, where the guard cannot read where to. Run the push on its own, plainly: git -C <checkout> push <remote> <branch>.` }
    return null
  }
  if (check.kind === 'npm') {
    const pkg = await textOf($, `${dir}/package.json`)
    if (pkg === null) return null
    let scripts: Record<string, unknown> = {}
    try {
      scripts = ((JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts) ?? {}
    } catch {
      return null
    }
    if (textPushes(scriptText(scripts, check.name), true)) return { deny: `the "${check.name}" script${LIFECYCLE[check.name] ? 's' : ''} in package.json push or open a pull request, where the guard cannot read where to. Run the push on its own, plainly.` }
    return null
  }
  for (const file of check.file ? [check.file] : ['GNUmakefile', 'makefile', 'Makefile']) {
    const text = await textOf($, file.startsWith('/') ? file : `${dir}/${file}`)
    if (text === null) continue
    if (scriptPushes(text)) return { deny: `the ${file} here pushes or opens a pull request${check.target ? ` (make ${check.target})` : ''}, where the guard cannot read where to. Run the push on its own, plainly.` }
    return null
  }
  return null
}
