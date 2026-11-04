// The repository guard (G5 decision 6): while this session works a CodeBook run, a `git push` or `gh pr create`
// may reach only the repositories that run's brief lists. These helpers read a shell command for the pushes and
// pull requests it would make and name the repository each one reaches; register.tsx decides. What they cannot read
// with confidence they answer `null`, and the guard refuses rather than guesses.

/**
 * One push or pull request a command would make, and how to find the repository it reaches. A push's `remote` is null
 * when the command names none: git then picks it from the branch's configuration (resolve.ts reads it as git does).
 */
export type Target =
  | { kind: 'push'; cwd: string | null; remote: string | null }
  | { kind: 'pr'; cwd: string | null; repo: string | null; ghRepoUnset?: boolean }

/**
 * Something in a command that may push without saying so, for resolve.ts to look into before the command runs: a git
 * subcommand that is not git's own (an alias, `git p` = `push`), a gh command that is not gh's own (an alias or an
 * extension), a script file, an npm / pnpm / yarn / bun script, or a make target. `isLost` when the folder it runs in
 * cannot be told (after a `cd` that may not have happened, or `popd`).
 */
export type Check =
  | { kind: 'git-alias'; cwd: string | null; name: string; isLost: boolean }
  | { kind: 'gh'; name: string }
  | { kind: 'file'; cwd: string | null; path: string; isLost: boolean }
  | { kind: 'npm'; cwd: string | null; name: string; isLost: boolean }
  | { kind: 'make'; cwd: string | null; target: string | null; isLost: boolean; file?: string | null }
  | { kind: 'hooks'; cwd: string | null; isLost: boolean }

/** A command as the guard reads it: the pushes and pull requests it names, and what else to look into. */
export type Reading = { targets: Target[]; checks: Check[]; programs: string[]; pushLike: boolean }

/** `github.com/owner/name` from any spelling of a GitHub remote (https, ssh, scp-like, with or without .git). */
export function repoOf(remote: string): string | null {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim())
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

/**
 * Anything that might push, open a pull request or change where a push goes. A command without any of these is not
 * read at all (`git log`, `npm test`); one with any of them is read word by word, and what cannot be read is refused.
 */
const PUSH_LIKE = /\bpush|send-pack|\bpr\s+(?:create|new)\b|\bpulls\b|createpullrequest|\bmutation\b|\bgh\b[^\n]*\bapi\b|set-url|\bremote\.|\burl\.|insteadof|\bGIT_\w+/i

/** Whether text (a command, an alias's expansion, a script's body) might push or open a pull request. */
export function isPushLike(text: string): boolean {
  return PUSH_LIKE.test(text)
}

/**
 * Whether a script's text (a file, a package.json script, a Makefile) pushes or opens a pull request: git or gh words
 * on one line, not any "push" (`arr.push(`, `pushd`, `docker push` are not git pushes). resolve.ts also reads a shell
 * script's lines as commands (readCommand), which sees through quoting such as `git "pu"sh`.
 */
export function scriptPushes(text: string): boolean {
  return /\bgit\b[^\n]{0,200}?\b(?:push|send-pack)\b|\bgh\b[^\n]{0,200}?\b(?:pr\s+(?:create|new)|api\b|repo\s+create\b[^\n]*--push)|createpullrequest|api\.github\.com[^\n]*\/(?:pulls|git\/refs|merges)|\bhub\s+(?:push|pull-request)\b/i.test(text)
}

/** gh's own top-level commands: any other word is an alias or an extension, whose expansion resolve.ts reads. */
const GH_BUILTIN = new Set(
  ('agent-task alias api attestation auth browse cache codespace completion config copilot extension gist gpg-key help ' +
    'issue label org pr preview project release repo ruleset run search secret ssh-key status variable version workflow').split(' '),
)

/** Programs that run a script file given as their first word (`bash deploy.sh`, `node release.mjs`). */
const SCRIPT_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'source', '.', 'python', 'python3', 'node', 'perl', 'ruby', 'deno', 'tsx', 'ts-node'])

/** Package managers whose scripts are read from package.json, and the words that run one. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const NPM_SHORTHANDS = new Set(['test', 't', 'start', 'stop', 'restart'])

/** The home folder at the start of a path: `~`, `$HOME` or `${HOME}` (register.tsx expands them). */
export const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/

/** git's own options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path'])

/** `git push` options that take the next word as their value (so it is not the repository). */
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

/** Configuration that changes where a push goes or what a git word runs: refused next to a push. */
const RISKY_CONFIG = /^(?:alias|remote|url|push|branch|include|includeif)\./i

/** `GIT_*` variables that cannot change where a push goes; any other next to a push is refused. */
const HARMLESS_GIT_VARS = /^GIT_(?:TERMINAL_PROMPT|TRACE\w*|EDITOR|SEQUENCE_EDITOR|PAGER|ASKPASS|SSH_COMMAND|SSH|AUTHOR_\w+|COMMITTER_\w+|PROGRESS_DELAY|FLUSH|OPTIONAL_LOCKS|ADVICE|MERGE_AUTOEDIT)$/

/** git subcommands known not to run other commands (an unknown one may be an alias). */
const GIT_PLAIN = new Set(
  ('add am apply archive blame branch bundle cat-file checkout cherry cherry-pick clean clone commit config count-objects describe diff ' +
    'diff-files diff-index diff-tree fetch format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree maintenance merge ' +
    'merge-base mv name-rev notes pull push range-diff read-tree reflog remote repack replace reset restore rev-list rev-parse revert rm ' +
    'shortlog show show-branch show-ref sparse-checkout stash status switch symbolic-ref tag update-index update-ref var verify-commit ' +
    'version whatchanged worktree write-tree').split(' '),
)

/** Words that run the command after them (`command git push`, `env X=1 git push`): read past them. */
const RUNNERS = new Set(['command', 'builtin', 'env', 'exec', 'nohup', 'time'])

/** Programs that run text as commands: next to anything push-like, the guard cannot read what they run. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'eval', 'source', '.', 'python', 'python3', 'node', 'perl', 'ruby', 'deno', 'bun', 'osascript'])

/** Programs whose words are only printed, never run. */
const INERT = new Set(['echo', 'printf', 'true', 'false', ':'])

/** Programs that read a here-document's body as text (a file, a pull request's body, a commit message). */
const TEXT_READERS = new Set(['cat', 'tee', 'gh', 'git', 'cd', 'pushd'])

const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * The command without its here-documents' bodies, and whether a body is run rather than read. A quoted delimiter
 * (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) makes the body plain text, such as a pull request's description with backticks in
 * it; and `"$(cat <<'EOF' … EOF)"`, the usual way to pass such a body as one argument, becomes one word. An unquoted
 * delimiter expands `$(...)` and backticks in its body, so a body with either keeps a `$(` for targetsOf to refuse;
 * and a push-like body fed to a shell or another program that runs it (`bash <<'EOF'`) is commands: unreadable.
 */
function stripHeredocs(command: string): { text: string; isRun: boolean } {
  const lines = command.split('\n')
  const out: string[] = []
  let isRun = false
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
      const text = body.join('\n')
      if (quoted === undefined && /\$\(|`/.test(text)) out.push('$(')
      else if (PUSH_LIKE.test(text) && !readsAsText(line, start.index ?? 0)) isRun = true
    }
  }
  const text = out.join('\n').replace(/\$\(\s*cat\s+<<-?\s*(?:'[^'\n]+'|"[^"\n]+"|\\[A-Za-z_][A-Za-z0-9_]*)\s*\n\s*\)/g, 'BODY')
  return { text, isRun }
}

/** Whether the here-document starting at `at` on `line` goes to programs that only read it (cat, tee, gh, git). */
function readsAsText(line: string, at: number): boolean {
  if (/\$\(\s*cat\s+$/.test(line.slice(0, at))) return true
  const simple = simpleCommands(line)
  if (simple === null) return false
  return simple.every(one => {
    const argv = commandWords(one.words).argv
    return argv.length === 0 || TEXT_READERS.has(program(argv[0]))
  })
}

/** For a caller that wants only the text: the command without its here-documents' bodies. */
export function withoutHeredocs(command: string): string {
  return stripHeredocs(command).text
}

/** One simple command: its words (quotes removed, redirections dropped) and the operators around it. */
type Simple = { words: string[]; before: string; after: string; hasParen: boolean }

/**
 * A command split as the shell splits it: on `;`, `&`, `&&`, `|`, `||` and new lines outside quotes, so a `;` in a
 * commit message stays in its word. Quotes and backslashes are removed, comments and redirections (`2>&1`, `> f`,
 * `<<'EOF'`) dropped; an unquoted `(` or `)` is noted. `null` for an unclosed quote.
 */
function simpleCommands(command: string): Simple[] | null {
  const out: Simple[] = []
  let words: string[] = []
  let cur = ''
  let isWord = false
  let isTarget = false
  let hasParen = false
  let before = ''
  const endWord = (): void => {
    if (isWord) {
      if (isTarget) isTarget = false
      else words.push(cur)
    }
    cur = ''
    isWord = false
  }
  const endCommand = (op: string): void => {
    endWord()
    isTarget = false
    if (words.length > 0 || hasParen) out.push({ words, before, after: op, hasParen })
    words = []
    hasParen = false
    before = op
  }
  for (let at = 0; at < command.length; at++) {
    const c = command[at] ?? ''
    const next = command[at + 1] ?? ''
    if (c === "'") {
      const end = command.indexOf("'", at + 1)
      if (end < 0) return null
      cur += command.slice(at + 1, end)
      isWord = true
      at = end
      continue
    }
    if (c === '"') {
      let end = at + 1
      for (; end < command.length && command[end] !== '"'; end++) {
        if (command[end] === '\\' && /[\\"$`\n]/.test(command[end + 1] ?? '')) {
          end++
          if (command[end] !== '\n') cur += command[end]
        } else {
          cur += command[end]
        }
      }
      if (end >= command.length) return null
      isWord = true
      at = end
      continue
    }
    if (c === '\\') {
      if (next !== '\n') {
        cur += next
        isWord = true
      }
      at++
      continue
    }
    if (c === '#' && !isWord) {
      const end = command.indexOf('\n', at)
      at = (end < 0 ? command.length : end) - 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (isWord && /^\d+$/.test(cur)) {
        cur = ''
        isWord = false
      } else {
        endWord()
      }
      let op = ''
      while (/[<>&|-]/.test(command[at] ?? '') && !(command[at] === '&' && command[at + 1] === '&')) {
        if (command[at] === '|' && !op.endsWith('>')) break
        if (command[at] === '-' && !op.endsWith('<<') && !op.endsWith('&')) break
        op += command[at]
        at++
      }
      // `2>&1`, `>&-`: a descriptor, not a file.
      if (op.endsWith('&') && /[\d-]/.test(command[at] ?? '')) {
        while (/[\d-]/.test(command[at] ?? '')) at++
      } else if (!op.endsWith('&-')) {
        isTarget = true
      }
      at--
      continue
    }
    if (c === '\n' || c === ';' || c === '&' || c === '|') {
      let op = c
      if ((c === '&' || c === '|' || c === ';') && next === c) {
        op += next
        at++
      } else if (c === '|' && next === '&') {
        at++
      }
      endCommand(op)
      continue
    }
    if (c === '(' || c === ')') {
      endWord()
      hasParen = true
      continue
    }
    cur += c
    isWord = true
  }
  endCommand('')
  return out
}

type Words = { argv: string[]; keywords: string[]; assigns: Array<[string, string]>; exports: Array<[string, string | null]> }

/** A simple command's words without its leading keywords, variable assignments, `export` and runners. */
function commandWords(words: string[]): Words {
  const argv = [...words]
  const keywords: string[] = []
  const assigns: Array<[string, string]> = []
  const exports: Array<[string, string | null]> = []
  while (argv.length > 0) {
    const word = argv[0] ?? ''
    if (['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'fi', 'done', 'esac', 'for', 'select', 'case'].includes(word)) {
      keywords.push(argv.shift() ?? '')
      if (word === 'for' || word === 'select' || word === 'case') argv.length = 0
      continue
    }
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word)
    if (assign) {
      assigns.push([assign[1] ?? '', assign[2] ?? ''])
      argv.shift()
      continue
    }
    if (['export', 'declare', 'typeset', 'readonly'].includes(word)) {
      argv.shift()
      for (const one of argv) {
        const named = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(one)
        if (named) exports.push([named[1] ?? '', named[2] ?? null])
      }
      argv.length = 0
      continue
    }
    if (RUNNERS.has(word) && !(argv[1] ?? '').startsWith('-')) {
      argv.shift()
      continue
    }
    break
  }
  if (argv.at(-1) === '}') argv.pop()
  return { argv, keywords, assigns, exports }
}

/** `to` as seen from `from` (a `cd`, a `git -C`): absolute and home paths stand alone; null is the session's folder. */
function joined(from: string | null, to: string): string {
  return to.startsWith('/') || HOME_PREFIX.test(to) || from === null ? to : `${from}/${to}`
}

/** The command word of a git or gh line: the first word after the program and its own options (and their values). */
function firstWordOf(argv: string[]): string | null {
  for (let at = 1; at < argv.length; at++) {
    const word = argv[at] ?? ''
    if (GIT_OPTIONS_WITH_VALUE.has(word) || word === '-R' || word === '--repo') at++
    else if (!word.startsWith('-')) return word
  }
  return null
}

/** A program name without its folder: `/usr/bin/git` is `git`. */
function program(word: string | undefined): string {
  return (word ?? '').replace(/^.*\//, '')
}

/** A `GIT_*` variable that can change where a push goes (`GIT_DIR`, `GIT_CONFIG_*`, …). */
export function isRiskyGitVar(name: string): boolean {
  return name.startsWith('GIT_') && !HARMLESS_GIT_VARS.test(name)
}

type GitRead = { push?: { cwd: string | null; remote: string | null }; isUnreadable?: boolean; changesRemotes?: boolean; alias?: { cwd: string | null; name: string } }

/** One `git …` command: its push (folder and repository), or that it changes remotes, or that it cannot be read. */
function readGit(argv: string[], cwd: string | null): GitRead {
  let at = 1
  let here = cwd
  while (at < argv.length && (argv[at] ?? '').startsWith('-')) {
    const option = argv[at] ?? ''
    if (option === '-C' || option === '--git-dir') here = joined(here, argv[at + 1] ?? '.')
    if (option.startsWith('--git-dir=')) here = joined(here, option.slice('--git-dir='.length))
    if (option === '-c' && RISKY_CONFIG.test(argv[at + 1] ?? '')) return { isUnreadable: true }
    if (option.startsWith('--config-env')) return { isUnreadable: true }
    at += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1
  }
  const sub = argv[at] ?? ''
  const rest = argv.slice(at + 1)
  if (sub === 'push') {
    let positional: string | null = null
    let repoFlag: string | null = null
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] ?? ''
      if (word === '--') {
        positional = rest[i + 1] ?? null
        break
      }
      if (word === '--repo') repoFlag = rest[i + 1] ?? null
      else if (word.startsWith('--repo=')) repoFlag = word.slice('--repo='.length)
      if (/^--recurse-submodules=(?:on-demand|only)$/.test(word)) return { isUnreadable: true }
      if (PUSH_OPTIONS_WITH_VALUE.has(word) || /^-[A-Za-z]*o$/.test(word)) {
        i++
        continue
      }
      if (word.startsWith('-')) continue
      positional = word
      break
    }
    // The repository on the command line wins over --repo (`git push --repo=<a> <b>` pushes to <b>). None named: git's
    // own choice from the branch's configuration (pushRemote, pushDefault, the branch's remote, origin), read later.
    return { push: { cwd: here, remote: positional ?? repoFlag ?? null } }
  }
  if (sub === 'send-pack') return { isUnreadable: true }
  if (sub === 'remote' && ['add', 'set-url', 'rename', 'remove', 'rm'].includes(rest[0] ?? '')) return { changesRemotes: true }
  if (sub === 'config') {
    const isRead = rest.some(word => ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'].includes(word))
    if (!isRead && rest.some(word => RISKY_CONFIG.test(word))) return { changesRemotes: true }
  }
  // An alias, or a subcommand that runs others (`git submodule foreach git push`, `git rebase -x "git push …"`).
  const runsOthers = !GIT_PLAIN.has(sub) || sub === 'rebase'
  if (runsOthers && rest.some(word => /\bpush\b|send-pack/.test(word))) return { isUnreadable: true }
  // Not one of git's own: perhaps an alias (`git p` for `push`), whose expansion is read before the command runs.
  if (sub !== '' && !GIT_PLAIN.has(sub)) return { alias: { cwd: here, name: sub } }
  return {}
}

/** gh options that take the next word as their value, for `gh pr create` and for `gh api`. */
const GH_PR_VALUES = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '--recover', '-R', '--repo'])
const GH_API_VALUES = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview', '-R', '--repo'])

type GhRead = { pr?: { repo: string | null }; isUnreadable?: boolean; other?: string }

/** One `gh …` command: the pull request it opens (with its `-R`/`--repo`), or that it writes where the guard cannot read. */
function readGh(argv: string[]): GhRead {
  const positional: string[] = []
  for (let at = 1; at < argv.length && positional.length < 2; at++) {
    const word = argv[at] ?? ''
    if (word === '-R' || word === '--repo') at++
    else if (!word.startsWith('-')) positional.push(word)
  }
  const [command = '', sub = ''] = positional
  if (command === 'pr' && (sub === 'create' || sub === 'new')) {
    let repo: string | null = null
    for (let at = 1; at < argv.length; at++) {
      const word = argv[at] ?? ''
      if (word === '-R' || word === '--repo') repo = argv[at + 1] ?? null
      else if (word.startsWith('--repo=')) repo = word.slice('--repo='.length)
      else if (/^-R\S+$/.test(word)) repo = word.slice(2).replace(/^=/, '')
      if (GH_PR_VALUES.has(word)) at++
    }
    return { pr: { repo } }
  }
  if (command === 'api') {
    let method: string | null = null
    let hasFields = false
    for (let at = 1; at < argv.length; at++) {
      const word = argv[at] ?? ''
      if (word === '-X' || word === '--method') method = argv[at + 1] ?? ''
      else if (word.startsWith('--method=')) method = word.slice('--method='.length)
      else if (/^-X\S+$/.test(word)) method = word.slice(2)
      if (/^(?:-[fF]|--field|--raw-field|--input)(?:=|$)/.test(word) || /^-[fF]\S/.test(word)) hasFields = true
      if (GH_API_VALUES.has(word)) at++
    }
    const isWrite = method !== null ? method.toUpperCase() !== 'GET' : hasFields
    const reachesCode = argv.some(word => /pulls|\/git\/|\/contents\/|\/merges|\/forks|graphql|createpullrequest|mutation/i.test(word))
    return isWrite && reachesCode ? { isUnreadable: true } : {}
  }
  if (command === 'repo' && sub === 'create' && argv.includes('--push')) return { isUnreadable: true }
  // Not one of gh's own commands: an alias or an extension, looked into before the command runs.
  if (command !== '' && !GH_BUILTIN.has(command)) return { other: command }
  return {}
}

/** A script a simple command runs, if any: a file it executes, an npm-like script, or a make target. */
function scriptOf(argv: string[], cwd: string | null, isLost: boolean): Check | null {
  const name = program(argv[0])
  const first = argv[0] ?? ''
  if (first.includes('/') && !['git', 'gh'].includes(name)) return { kind: 'file', cwd, path: first, isLost }
  // `deno run x.ts`, `bun run x.ts`, `npx tsx x.ts`, `pnpm dlx tsx x.ts`, `bunx tsx x.ts`: the file after the runner.
  if (['deno', 'npx', 'bunx'].includes(name) || (name === 'pnpm' && argv[1] === 'dlx') || (name === 'bun' && /\.(?:[cm]?[jt]sx?)$/.test(argv[2] ?? ''))) {
    const file = argv.slice(1).find(word => /\.(?:[cm]?[jt]sx?|sh|py|rb|pl)$/.test(word))
    if (file) return { kind: 'file', cwd, path: file, isLost }
    if (name !== 'bun') return null
  }
  if (SCRIPT_RUNNERS.has(name)) {
    const args = argv.slice(1)
    if (args.some(word => word === '-c' || word === '-e' || word === '--eval' || word === '-p')) return null
    const file = args.find(word => !word.startsWith('-'))
    return file ? { kind: 'file', cwd, path: file, isLost } : null
  }
  if (PACKAGE_MANAGERS.has(name)) {
    // `npm --prefix <dir>`, `npm -C <dir>`, `pnpm -C <dir>`, `yarn --cwd <dir>`: the scripts of that folder.
    let here = cwd
    const rest: string[] = []
    for (let at = 1; at < argv.length; at++) {
      const word = argv[at] ?? ''
      if (['--prefix', '-C', '--cwd', '--dir'].includes(word)) here = joined(here, argv[++at] ?? '.')
      else if (/^--(?:prefix|cwd|dir)=/.test(word)) here = joined(here, word.replace(/^--\w+=/, ''))
      else if (!word.startsWith('-')) rest.push(word)
    }
    const [verb = '', next = ''] = rest
    // A workspace's or a filter's scripts live in another package.json: the guard cannot tell which.
    if (verb === 'workspace' || verb === 'workspaces' || argv.some(word => /^--(?:filter|workspace|ws)/.test(word) || word === '-r' || word === '--recursive')) return { kind: 'npm', cwd: here, name: '*', isLost: true }
    if (verb === 'run' || verb === 'run-script') return next ? { kind: 'npm', cwd: here, name: next, isLost } : null
    // `npm version` runs preversion, version and postversion; installing runs the package's own lifecycle scripts.
    if (verb === 'version') return { kind: 'npm', cwd: here, name: 'version', isLost }
    if (['install', 'i', 'ci', 'add'].includes(verb) || verb === '') return { kind: 'npm', cwd: here, name: 'install', isLost }
    if (name === 'npm') return NPM_SHORTHANDS.has(verb) ? { kind: 'npm', cwd: here, name: verb === 't' ? 'test' : verb, isLost } : null
    // pnpm, yarn and bun run a package script by its bare name too (`pnpm deploy`, `yarn release`).
    return verb && !['remove', 'exec', 'dlx', 'x', 'create', 'init', 'why', 'list', 'ls', 'outdated', 'audit', 'info'].includes(verb)
      ? { kind: 'npm', cwd: here, name: verb, isLost }
      : null
  }
  if (name === 'make' || name === 'gmake') {
    let here = cwd
    let file: string | null = null
    let target: string | null = null
    for (let at = 1; at < argv.length; at++) {
      const word = argv[at] ?? ''
      if (word === '-C' || word === '--directory') here = joined(here, argv[++at] ?? '.')
      else if (word.startsWith('--directory=')) here = joined(here, word.slice('--directory='.length))
      else if (word === '-f' || word === '--file' || word === '--makefile') file = argv[++at] ?? null
      else if (/^--(?:file|makefile)=/.test(word)) file = word.replace(/^--\w+=/, '')
      else if (!word.startsWith('-') && !word.includes('=') && target === null) target = word
    }
    return { kind: 'make', cwd: here, target, isLost, file }
  }
  return null
}

/**
 * The pushes and pull requests a shell command would make, each with the folder it runs in. The command is split as
 * the shell splits it (simpleCommands) and each simple command read past `!`, `if`/`then`/`do`, assignments and
 * runners (`command`, `env`, `exec`, `nohup`, `time`), following `cd`/`pushd`, `git -C <dir>` and `--git-dir`, and
 * `gh`'s `-R`/`--repo` (or `GH_REPO`, exported or set before that `gh`); here-documents' bodies are text when only
 * read. `null` when a push-like command does something the guard cannot attribute with confidence: a substitution, a
 * subshell, a shell or interpreter, a wrapper (`timeout`, `xargs`, `nice`, `env -u`), git configuration or `GIT_*`
 * variables that change where it goes, a remote changed in the same command, a write through `gh api`, or a push
 * after `popd` or after a `cd` that may not have happened. The caller refuses rather than guesses.
 */
export function targetsOf(full: string): Target[] | null {
  return readCommand(full)?.targets ?? null
}

/**
 * The command as the guard reads it (targetsOf's rules), plus what may push without saying so (`checks`, for
 * resolve.ts). A command with nothing push-like in it is never refused here: what cannot be read in it only ends the
 * reading, with the checks found so far.
 */
export function readCommand(full: string): Reading | null {
  const pushLike = PUSH_LIKE.test(full)
  const checks: Check[] = []
  const targets: Target[] = []
  // What cannot be read is refused when it pushes, or when a shell function or eval wraps git or gh: a function body
  // (`f(){ git "$1"sh …; }; f pu`) or an eval may hide a push without saying "push".
  const hidesGit = /(?:\b[A-Za-z_][\w-]*\s*\(\s*\)\s*\{|\bfunction\s+[A-Za-z_]|\beval\b)[\s\S]*\b(?:git|gh)\b|\b(?:git|gh)\b[\s\S]*\beval\b/.test(full)
  const programs: string[] = []
  const unreadable = (): Reading | null => (pushLike || hidesGit ? null : { targets: [], checks, programs, pushLike })
  const { text: command, isRun } = stripHeredocs(full)
  if (pushLike && (isRun || /\$\(|`|<\(|>\(/.test(command))) return null
  const simple = simpleCommands(command)
  if (simple === null) return unreadable()
  let cwd: string | null = null
  let isLost = false
  let isTainted = false
  let ghRepo: string | null = null
  let ghRepoUnset = false
  let ghAliasChanged = false
  let feedsPush = false
  let sawGit = false
  let gitCwd: string | null = null
  let depth = 0
  for (const one of simple) {
    if (one.hasParen) return unreadable()
    const { argv, keywords, assigns, exports } = commandWords(one.words)
    for (const word of keywords) {
      if (['if', 'while', 'until', 'for', 'select', 'case'].includes(word)) depth++
      if (['fi', 'done', 'esac'].includes(word)) depth = Math.max(0, depth - 1)
    }
    for (const [name] of [...assigns, ...exports]) if (isRiskyGitVar(name)) isTainted = true
    for (const [name, value] of exports) if (name === 'GH_REPO') ghRepo = value
    // `GH_REPO=x gh …` sets it for that gh only; a bare `GH_REPO=x;` is not exported, so gh never sees it.
    const prefixGhRepo = assigns.find(([name]) => name === 'GH_REPO')?.[1] ?? null
    if (argv.length === 0) continue
    const name = program(argv[0])
    if (argv[0]) programs.push(argv[0])
    if (name === 'unset' && argv.includes('GH_REPO')) {
      ghRepo = null
      ghRepoUnset = true
    }
    if (name === 'cd' || name === 'pushd') {
      const to = argv.slice(1).find(word => !/^-[LPe@]+$/.test(word) && word !== '--')
      const mayNotRun = depth > 0 || one.before === '||' || one.before === '|' || one.after === '|' || one.after === '&'
      if (mayNotRun || to === '-' || (to !== undefined && /^[+-]\d+$/.test(to)) || (name === 'pushd' && to === undefined)) isLost = true
      else cwd = joined(cwd, to ?? '~')
      continue
    }
    if (name === 'popd') {
      isLost = true
      continue
    }
    // An expansion as the program or as git's or gh's command word (`git ${x}sh`): what runs cannot be read.
    if (/\$/.test(argv[0] ?? '') || ((name === 'git' || name === 'gh') && /\$/.test(firstWordOf(argv) ?? ''))) return pushLike || /\b(?:git|gh)\b/.test(full) ? null : unreadable()
    if (name !== 'git' && name !== 'gh' && !INERT.has(name) && one.words.slice(1).some(word => scriptPushes(word))) feedsPush = true
    if (INERT.has(name) && one.words.slice(1).some(word => scriptPushes(word))) feedsPush = true
    if (name === 'gh' && (argv[1] === 'alias' && ['set', 'import', 'delete'].includes(argv[2] ?? ''))) ghAliasChanged = true
    if (name === 'git') {
      sawGit = true
      gitCwd = gitCwd ?? cwd
      const read = readGit(argv, cwd)
      if (read.isUnreadable) return unreadable()
      if (read.changesRemotes) isTainted = true
      if (read.alias) checks.push({ kind: 'git-alias', ...read.alias, isLost })
      if (read.push) {
        if (isLost) return unreadable()
        targets.push({ kind: 'push', ...read.push })
      }
      continue
    }
    if (name === 'gh') {
      const read = readGh(argv)
      if (read.isUnreadable) return unreadable()
      if (read.other) checks.push({ kind: 'gh', name: read.other })
      if (read.pr) {
        if (isLost) return unreadable()
        targets.push({ kind: 'pr', cwd, repo: read.pr.repo ?? prefixGhRepo ?? ghRepo, ...(ghRepoUnset ? { ghRepoUnset: true } : {}) })
      }
      continue
    }
    if (INERT.has(name)) continue
    const script = scriptOf(argv, cwd, isLost)
    if (script) checks.push(script)
    // A shell or interpreter running push-like text, or reading it from a pipe.
    const runsText = name === 'eval' || name === 'source' || name === '.' || one.before === '|' || one.words.some(word => PUSH_LIKE.test(word))
    if (INTERPRETERS.has(name) && runsText) return unreadable()
    // A wrapper around git or gh (`timeout 60 git push`, `xargs git push`, `nice`, `sudo`, `env -u X git push`).
    // Read as one line, so `pr create` (two words) is seen too.
    if (argv.slice(1).some(word => ['git', 'gh'].includes(program(word))) && PUSH_LIKE.test(argv.join(' '))) return unreadable()
  }
  // A remote, git's configuration (an alias included) or a GIT_* variable changed in the same command: the push, or the
  // alias it then runs, may not go where it reads.
  if (isTainted && (targets.length > 0 || checks.some(check => check.kind === 'git-alias'))) return null
  // A gh alias set or imported in the same command, then used: it cannot be read before it exists.
  if (ghAliasChanged && checks.some(check => check.kind === 'gh')) return null
  // Text that pushes handed to a program that is not git push or gh pr create (`npm pkg set scripts.x="git push …"`,
  // `echo 'git push …' > d.sh`) in a command that then runs a script: what the script will say cannot be read now.
  if (pushLike && feedsPush && checks.some(check => check.kind === 'file' || check.kind === 'npm' || check.kind === 'make')) return null
  // Any git command runs the repository's hooks (pre-commit, pre-push): resolve.ts reads them.
  if (sawGit) checks.push({ kind: 'hooks', cwd: gitCwd, isLost })
  return { targets, checks, programs, pushLike }
}
