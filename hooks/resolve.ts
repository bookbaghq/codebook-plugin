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

import { HOME_PREFIX, isPushLike, isRiskyGitVar, repoOf } from './guard'
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

/**
 * The session shell's own values of the variables that matter (Claude Code's Bash starts from the person's shell
 * profile, which may export GH_REPO or GIT_DIR), and the hooks' own environment as a fallback. Only those names are
 * kept; nothing else of the environment is read out.
 */
export async function shellEnv($: EngineInterface): Promise<ShellEnv> {
  const out: ShellEnv = new Map()
  // The hooks' own environment first (each name literal: the runtime lists what a module reads).
  keep(out, 'GH_REPO', await $.env.get('GH_REPO'))
  keep(out, 'GIT_DIR', await $.env.get('GIT_DIR'))
  keep(out, 'GIT_WORK_TREE', await $.env.get('GIT_WORK_TREE'))
  keep(out, 'GIT_COMMON_DIR', await $.env.get('GIT_COMMON_DIR'))
  keep(out, 'GIT_NAMESPACE', await $.env.get('GIT_NAMESPACE'))
  keep(out, 'GIT_CONFIG', await $.env.get('GIT_CONFIG'))
  keep(out, 'GIT_CONFIG_GLOBAL', await $.env.get('GIT_CONFIG_GLOBAL'))
  keep(out, 'GIT_CONFIG_SYSTEM', await $.env.get('GIT_CONFIG_SYSTEM'))
  keep(out, 'GIT_CONFIG_COUNT', await $.env.get('GIT_CONFIG_COUNT'))
  keep(out, 'GIT_CONFIG_PARAMETERS', await $.env.get('GIT_CONFIG_PARAMETERS'))
  keep(out, 'GIT_INDEX_FILE', await $.env.get('GIT_INDEX_FILE'))
  keep(out, 'GIT_OBJECT_DIRECTORY', await $.env.get('GIT_OBJECT_DIRECTORY'))
  const shell = (await $.env.get('SHELL')) || '/bin/zsh'
  const probe = WATCHED.map(name => `printf '%s=%s\\n' ${name} "$${name}"`).join('; ')
  const got = await $.process.run([shell, '-ic', probe])
  if (got.exitCode === 0) {
    for (const line of lines(got.stdout)) {
      const at = line.indexOf('=')
      const name = line.slice(0, at)
      const value = line.slice(at + 1)
      if (WATCHED.includes(name) && value !== '') out.set(name, value)
    }
  }
  return out
}

function keep(out: ShellEnv, name: string, value: string | undefined): void {
  if (typeof value === 'string' && value !== '') out.set(name, value)
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
    return pushReaches($, dir, target.remote ?? (await defaultRemote($, dir)))
  }
  if (target.repo) return [repoOf(target.repo)]
  const fromEnv = env.get('GH_REPO')
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

/** An npm-like script with its pre/post scripts, following `npm run <other>` inside it, at most 4 deep. */
function scriptText(scripts: Record<string, unknown>, name: string, depth = 0): string {
  if (depth > 3) return 'push'
  const own = ['pre' + name, name, 'post' + name].map(key => (typeof scripts[key] === 'string' ? String(scripts[key]) : '')).join('\n')
  const nested = [...own.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:_.-]+)/g)].map(m => m[1] ?? '').filter(other => other !== name && other in scripts)
  return [own, ...nested.map(other => scriptText(scripts, other, depth + 1))].join('\n')
}

/** Whether a check pushes, as far as its text says: a refusal when it does (or cannot be read), else null. */
export async function checkOne($: EngineInterface, check: Check): Promise<Refusal | null> {
  if ('isLost' in check && check.isLost) return { deny: 'this command runs a script, an alias or a make target after a cd that may not have happened, so the guard cannot tell which one. Run it in its folder on its own.' }
  if (check.kind === 'git-alias') {
    const dir = await folderOf($, check.cwd)
    const alias = lines(await gitIn($, dir, ['config', '--get', `alias.${check.name}`]))[0]
    if (alias === undefined) return null
    if (alias.startsWith('!') || isPushLike(alias)) return { deny: `git ${check.name} is an alias for "${alias.slice(0, 120)}", which the guard cannot follow. Run the git command itself (git push <remote> <branch>).` }
    return null
  }
  if (check.kind === 'gh') {
    const aliases = lines(await run($, ['gh', 'alias', 'list']))
    for (const line of aliases) {
      const at = line.indexOf(':')
      if (at < 0 || line.slice(0, at).trim() !== check.name) continue
      const expansion = line.slice(at + 1).trim()
      if (expansion.startsWith('!') || /\bpr\s+(?:create|new)\b|\bapi\b|\brepo\s+create\b/.test(expansion)) return { deny: `gh ${check.name} is an alias for "${expansion.slice(0, 120)}". Run the gh command itself (gh pr create --repo <owner/name>).` }
      return null
    }
    const extensions = lines(await run($, ['gh', 'extension', 'list']))
    if (extensions.some(line => new RegExp(`(^|\\s)gh[ -]${check.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(line))) {
      return { deny: `gh ${check.name} is a gh extension, a program the guard cannot read, so it was not run while a CodeBook run is held. Run it after the run is reported, or use git and gh themselves.` }
    }
    return null
  }
  const dir = await folderOf($, check.cwd)
  if (check.kind === 'file') {
    const path = (check.path.startsWith('/') || HOME_PREFIX.test(check.path) ? await folderOf($, check.path) : `${dir}/${check.path}`).replace(/\/(?:\.\/)+/g, '/')
    const text = await textOf($, path)
    if (text !== null && isPushLike(text)) return { deny: `${check.path} pushes or opens a pull request inside, where the guard cannot read where to. Run the push on its own, plainly: git -C <checkout> push <remote> <branch>.` }
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
    if (isPushLike(scriptText(scripts, check.name))) return { deny: `the "${check.name}" script in package.json pushes or opens a pull request, where the guard cannot read where to. Run the push on its own, plainly.` }
    return null
  }
  for (const file of ['GNUmakefile', 'makefile', 'Makefile']) {
    const text = await textOf($, `${dir}/${file}`)
    if (text === null) continue
    if (isPushLike(text)) return { deny: `the ${file} here pushes or opens a pull request${check.target ? ` (make ${check.target})` : ''}, where the guard cannot read where to. Run the push on its own, plainly.` }
    return null
  }
  return null
}
