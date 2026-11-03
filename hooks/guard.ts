// The repository guard (G5 decision 6): while this session works a CodeBook run, a `git push` or `gh pr create`
// may reach only the repositories that run's brief lists. These helpers read a shell command for the pushes and
// pull requests it would make and name the repository each one reaches; register.tsx decides.

import { words } from './connector'

/** One push or pull request a command would make, and how to find the repository it reaches. */
export type Target =
  | { kind: 'push'; cwd: string | null; remote: string }
  | { kind: 'pr'; cwd: string | null; repo: string | null }

/** `github.com/owner/name` from any spelling of a GitHub remote (https, ssh, scp-like, with or without .git). */
export function repoOf(remote: string): string | null {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  if (match) return `${match[1]}/${match[2]}`.toLowerCase()
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(remote.trim())
  return bare ? `${bare[1]}/${bare[2]}`.toLowerCase() : null
}

/** The repositories a brief allows, as `owner/name`: `run_here.repositories` (G5b) or the one `repository` (G2). */
export function allowedOf(brief: unknown): string[] {
  const here = (brief as { run_here?: { repository?: unknown; repositories?: unknown } } | null)?.run_here
  const listed = Array.isArray(here?.repositories) ? here.repositories : here?.repository ? [here.repository] : []
  const names = listed
    .map(one => {
      const repo = one as { name?: string; full_name?: string; url?: string } | string
      if (typeof repo === 'string') return repoOf(repo)
      return repoOf(repo.name ?? repo.full_name ?? '') ?? repoOf(repo.url ?? '')
    })
    .filter((name): name is string => name !== null)
  return [...new Set(names)]
}

const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** Words that run the command after them (`command git push`, `env X=1 git push`): read past them. */
const RUNNERS = new Set(['command', 'builtin', 'env', 'exec', 'nohup', 'time', 'export'])

const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * The command without its here-documents' bodies. A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) makes the body
 * plain text, such as a pull request's description with backticks in it, never commands; and `"$(cat <<'EOF' … EOF)"`,
 * the usual way to pass such a body as one argument, becomes one word. An unquoted delimiter expands `$(...)` and
 * backticks in its body, so a body with either keeps a `$(` for targetsOf to refuse.
 */
export function withoutHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ''
    out.push(line)
    for (const start of line.matchAll(HEREDOC)) {
      const quoted = start[2] ?? start[3] ?? start[4]
      const delimiter = quoted ?? start[5] ?? ''
      const body: string[] = []
      while (at + 1 < lines.length) {
        const next = lines[++at] ?? ''
        if ((start[1] ? next.replace(/^\t+/, '') : next) === delimiter) break
        body.push(next)
      }
      if (quoted === undefined && /\$\(|`/.test(body.join('\n'))) out.push('$(')
    }
  }
  return out.join('\n').replace(/\$\(\s*cat\s+<<-?\s*(?:'[^'\n]+'|"[^"\n]+"|\\[A-Za-z_][A-Za-z0-9_]*)\s*\n\s*\)/g, 'BODY')
}

/** `to` as seen from `from` (a `cd`, a `git -C`): absolute and `~` paths stand alone; null is the session's folder. */
function joined(from: string | null, to: string): string {
  return to.startsWith('/') || to.startsWith('~') || from === null ? to : `${from}/${to}`
}

/** A program name without its folder: `/usr/bin/git` is `git`. */
function program(word: string | undefined): string {
  return (word ?? '').replace(/^.*\//, '')
}

/** The repository `gh` is pointed at by `-R`/`--repo` (any spelling), else null. */
function ghRepoOf(argv: string[]): string | null {
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] ?? ''
    if (word === '-R' || word === '--repo') return argv[at + 1] ?? null
    if (word.startsWith('--repo=')) return word.slice('--repo='.length)
    if (/^-R.+/.test(word)) return word.slice(2).replace(/^=/, '')
  }
  return null
}

/**
 * The pushes and pull requests a shell command would make, each with the folder it runs in: commands joined by `&&`,
 * `||`, `;`, `|` or new lines are read one by one, following `cd`/`pushd`, `git -C <dir>` and `--git-dir`, and `gh`'s
 * `-R`/`--repo` (or `GH_REPO`); here-documents' bodies are text (withoutHeredocs). `null` when the command does
 * something the guard cannot read with confidence (a push inside `$(...)` or a `( … )` subshell, `eval`, `sh -c`,
 * a push after `popd`), so the caller refuses rather than guesses.
 */
export function targetsOf(full: string): Target[] | null {
  const command = withoutHeredocs(full)
  if (!/\bgit\b[^\n]*\bpush\b|\bgh\b[^\n]*\bpr\b[^\n]*\bcreate\b/.test(command)) return []
  if (/\$\(|`|\beval\b|\b(?:ba|z)?sh\s+-c\b/.test(command)) return null
  const targets: Target[] = []
  let cwd: string | null = null
  let isLost = false
  let ghRepo: string | null = null
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const argv = words(part.trim())
    if ((argv[0] ?? '').startsWith('(')) return null
    if (argv[0] === '{') argv.shift()
    if (argv.at(-1) === '}') argv.pop()
    let inlineGhRepo: string | null = null
    while (argv.length > 0 && (RUNNERS.has(argv[0] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? ''))) {
      const word = argv.shift() ?? ''
      if (word.startsWith('GH_REPO=')) inlineGhRepo = word.slice('GH_REPO='.length)
      if (word === 'export' && (argv[0] ?? '').startsWith('GH_REPO=')) ghRepo = (argv.shift() ?? '').slice('GH_REPO='.length)
    }
    const name = program(argv[0])
    if (argv.length === 0 && inlineGhRepo !== null) ghRepo = inlineGhRepo
    if (name === 'cd' || name === 'pushd') {
      cwd = joined(cwd, argv[1] ?? '~')
      continue
    }
    if (name === 'popd') {
      isLost = true
      continue
    }
    if (name === 'git') {
      let at = 1
      let here = cwd
      while (at < argv.length && (argv[at] ?? '').startsWith('-')) {
        const option = argv[at] ?? ''
        if (option === '-C' || option === '--git-dir') here = joined(here, argv[at + 1] ?? '.')
        if (option.startsWith('--git-dir=')) here = joined(here, option.slice('--git-dir='.length))
        at += OPTIONS_WITH_VALUE.has(option) ? 2 : 1
      }
      if (argv[at] !== 'push') continue
      if (isLost) return null
      const rest = argv.slice(at + 1)
      const flag = rest.indexOf('--repo')
      const inline = rest.find(word => word.startsWith('--repo='))
      const named = flag >= 0 ? rest[flag + 1] : inline?.slice('--repo='.length)
      const remote = named ?? rest.find(word => !word.startsWith('-')) ?? 'origin'
      targets.push({ kind: 'push', cwd: here, remote })
      continue
    }
    if (name === 'gh' && argv[1] === 'pr' && argv[2] === 'create') {
      if (isLost) return null
      targets.push({ kind: 'pr', cwd, repo: ghRepoOf(argv) ?? inlineGhRepo ?? ghRepo })
    }
  }
  return targets
}
