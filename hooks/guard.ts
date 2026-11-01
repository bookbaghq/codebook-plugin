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

/**
 * The pushes and pull requests a shell command would make. Commands joined by `&&`, `||`, `;`, `|` or new lines are
 * read one by one, following `cd`. `null` when the command does something the guard cannot read with confidence (a
 * push inside `$(...)`, `eval`, `sh -c`), so the caller refuses rather than guesses.
 */
export function targetsOf(command: string): Target[] | null {
  if (!/\bgit\b[^\n]*\bpush\b|\bgh\b[^\n]*\bpr\b[^\n]*\bcreate\b/.test(command)) return []
  if (/\$\(|`|\beval\b|\b(?:ba|z)?sh\s+-c\b/.test(command)) return null
  const targets: Target[] = []
  let cwd: string | null = null
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const argv = words(part.trim())
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) argv.shift()
    if (argv[0] === 'cd') {
      const to = argv[1] ?? '~'
      cwd = to.startsWith('/') || to.startsWith('~') || cwd === null ? to : `${cwd}/${to}`
      continue
    }
    if (argv[0] === 'git') {
      let at = 1
      let here = cwd
      while (at < argv.length && (argv[at] ?? '').startsWith('-')) {
        const option = argv[at] ?? ''
        if (option === '-C') here = argv[at + 1] ?? here
        at += OPTIONS_WITH_VALUE.has(option) ? 2 : 1
      }
      if (argv[at] !== 'push') continue
      const rest = argv.slice(at + 1)
      const remote = rest.find(word => !word.startsWith('-')) ?? 'origin'
      targets.push({ kind: 'push', cwd: here, remote })
      continue
    }
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create') {
      const flag = argv.findIndex(word => word === '--repo' || word === '-R')
      const inline = argv.find(word => word.startsWith('--repo='))
      const repo = flag >= 0 ? (argv[flag + 1] ?? null) : inline ? inline.slice('--repo='.length) : null
      targets.push({ kind: 'pr', cwd, repo })
    }
  }
  return targets
}
