import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { allowedOf, readCommand, repoOf, targetsOf } from '../hooks/guard'
import { checkoutsOf } from '../hooks/local'
import { forgetShell } from '../hooks/resolve'

const OWN = 'mcp__plugin_codebook_codebook__'

test('remotes are read as owner/name', async () => {
  expect(repoOf('https://github.com/BookbagHQ/codebook-plugin-sandbox.git')).toBe('bookbaghq/codebook-plugin-sandbox')
  expect(repoOf('git@github.com:bookbaghq/codebook-plugin-sandbox.git')).toBe('bookbaghq/codebook-plugin-sandbox')
  expect(repoOf('bookbaghq/codebook-plugin-sandbox')).toBe('bookbaghq/codebook-plugin-sandbox')
  expect(repoOf('origin')).toBeNull()
})

test('a brief allows its repositories, the G2 one or the G5b list', async () => {
  expect(allowedOf({ run_here: { repository: { name: 'acme/payments', url: 'https://github.com/acme/payments' } } })).toEqual(['acme/payments'])
  expect(allowedOf({ run_here: { repositories: [{ name: 'acme/a' }, { url: 'https://github.com/acme/b' }] } })).toEqual(['acme/a', 'acme/b'])
  expect(allowedOf({ run_here: { repository: null } })).toEqual([])
})

test('commands are read for their pushes and pull requests', async () => {
  expect(targetsOf('npm test')).toEqual([])
  expect(targetsOf('git push -u origin codebook/57-refunds')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  expect(targetsOf('cd ../other && git push fork main')).toEqual([{ kind: 'push', cwd: '../other', remote: 'fork' }])
  expect(targetsOf('git -C /tmp/x push')).toEqual([{ kind: 'push', cwd: '/tmp/x', remote: null }])
  expect(targetsOf('gh pr create --draft --repo acme/payments --title x')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('git add -A && git commit -m "x" && gh pr create --draft')).toEqual([{ kind: 'pr', cwd: null, repo: null }])
  expect(targetsOf('sh -c "git push other"')).toBeNull()
})

test('a here-document body is text, not commands (found live: a PR description with backticks was refused)', async () => {
  // Run 153: the body written to a file first, then a plain gh pr create.
  const toFile = "S=/tmp/run153; cat > $S/pr-body.md <<'EOF'\nStory: BR-1.\n- `src/sku.mjs`: `normalizeSku` trims; never `git push other`.\nEOF\ngh pr create --draft --repo acme/payments --body-file $S/pr-body.md"
  expect(targetsOf(toFile)).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  // Run 147: the body on standard input.
  const stdin = "cd /work/x && gh pr create --draft --repo acme/payments --head codebook/SD-1-run-147 --body-file - <<'EOF'\n## What changed\n- `src/dimensions.mjs`: exports `fitsBox`.\nEOF"
  expect(targetsOf(stdin)).toEqual([{ kind: 'pr', cwd: '/work/x', repo: 'acme/payments' }])
  // The usual "$(cat <<'EOF' … EOF)" argument, and a <<- body indented with tabs.
  const inline = "git push -u origin codebook/x && gh pr create --draft --title t --body \"$(cat <<'EOF'\nUses `fitsBox`; then $(rm -rf /) is only text.\nEOF\n)\""
  expect(targetsOf(inline)).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }, { kind: 'pr', cwd: null, repo: null }])
  expect(targetsOf("cat <<-\"END\" > notes.md\n\t`git push fork`\n\tEND\ngit push fork main")).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  // An unquoted delimiter runs what is in its body: still refused, and so is a push hidden in a substitution.
  expect(targetsOf('gh pr create --body-file - <<EOF\n$(git push other)\nEOF')).toBeNull()
  expect(targetsOf("gh pr create --body \"$(git push other; cat <<'EOF'\nx\nEOF\n)\"")).toBeNull()
  // An unquoted body with nothing to expand is text too.
  expect(targetsOf('cat > a.md <<EOF\ngit push other\nEOF\ngit push origin')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
})

/** A folder's git as the fake answers it: its remotes (fetch and push addresses), configuration and branch. */
type Repo = { remotes: Record<string, { fetch: string[]; push?: string[] }>; config?: Record<string, string>; branch?: string | null }
/** The world the guard looks into: folders, the session shell's variables, files, gh's aliases and extensions. */
type World = {
  cwd: string
  repoOf: (dir: string) => Repo | null
  shellEnv?: Record<string, string>
  shellAliases?: Record<string, string>
  shellFunctions?: Record<string, string>
  shellFails?: boolean
  files?: Record<string, string>
  ghAliases?: string
  ghExtensions?: string
}
const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** process.run as git, gh, head and the shell answer it in `w`. */
function answer(w: World, argv: string[]) {
  if (argv[0] === 'git' && argv[1] === '-C') {
    const repo = w.repoOf(argv[2] ?? '')
    const rest = argv.slice(3)
    if (!repo) return out('', 128)
    const [a, b, c, d] = rest
    if (a === 'remote' && b === undefined) return out(Object.keys(repo.remotes).join('\n'))
    if (a === 'remote' && b === 'get-url') {
      const name = rest.at(-1) ?? ''
      const one = repo.remotes[name]
      if (!one) return out('', 2)
      return out(`${(c === '--push' ? (one.push ?? one.fetch) : one.fetch).join('\n')}\n`)
    }
    if (a === 'symbolic-ref') return repo.branch ? out(`${repo.branch}\n`) : out('', 1)
    if (a === 'rev-parse' && b === '--git-path') return out(`.git/${c}\n`)
    if (a === 'rev-parse') return out(`${argv[2]}\n`)
    if (a === 'config' && b === '--get') {
      const value = repo.config?.[String(c).toLowerCase()]
      return value === undefined ? out('', 1) : out(`${value}\n`)
    }
    if (a === 'config' && b === '--get-regexp') {
      const re = new RegExp(String(c), 'i')
      const hits = Object.entries(repo.config ?? {}).filter(([key]) => re.test(key)).map(([key, value]) => `${key} ${value}`)
      return hits.length ? out(`${hits.join('\n')}\n`) : out('', 1)
    }
    void d
    return out('', 1)
  }
  // The shell probe, run under perl's alarm: its variables, aliases and function names; a function's body.
  if (argv[0] === 'perl') {
    const script = argv.at(-1) ?? ''
    const fn = /^(?:whence -f|declare -f) (\S+)$/.exec(script)
    if (fn) return w.shellFunctions?.[fn[1] ?? ''] === undefined ? out('', 1) : out(w.shellFunctions[fn[1] ?? ''] ?? '')
    if (w.shellFails) return out('', 142)
    const env = Object.entries(w.shellEnv ?? {}).map(([k, v]) => `@env ${k}=${v}`)
    const aliases = Object.entries(w.shellAliases ?? {}).map(([k, v]) => `@alias ${k}='${v}'`)
    const fns = Object.keys(w.shellFunctions ?? {}).map(k => `@fn ${k}`)
    return out([...env, ...aliases, ...fns].join('\n') + '\n')
  }
  if (argv[0] === 'gh' && argv[1] === 'alias') return out(w.ghAliases ?? '')
  if (argv[0] === 'gh' && argv[1] === 'extension') return out(w.ghExtensions ?? '')
  if (argv[0] === 'ls') {
    const dir = `${argv.at(-1) ?? ''}/`
    const names = Object.keys(w.files ?? {}).filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/')).map(path => path.slice(dir.length))
    return names.length ? out(`${names.join('\n')}\n`) : out('', 1)
  }
  if (argv[0] === 'head') {
    const text = w.files?.[argv.at(-1) ?? '']
    return text === undefined ? out('', 1) : out(text)
  }
  return out('', 1)
}

/** The world, a held claim's brief for `repo`, and the commands that ran. */
function world(on: On, w: World, repo = 'bookbaghq/codebook-plugin-sandbox', local: unknown = null) {
  const ran: string[] = []
  forgetShell()
  mock.store(on)
  on('session.cwd', () => ({ value: w.cwd }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/Users/me' : (e as { name?: string }).name === 'SHELL' ? '/bin/zsh' : undefined }) as never)
  on('process.run', (_, e) => answer(w, e.argv) as never)
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Bash') {
      ran.push(String((e as { command?: unknown }).command))
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    }
    const repository = local ? { name: repo, local } : { name: repo }
    const data = tool === OWN + 'claim_work' ? { run: 811, where: 'here', lease: { fence: 1 }, brief: { run_here: { repository } } } : { recorded: true, run: 811 }
    return { result: { structuredContent: data } as never, text: JSON.stringify(data) }
  })
  return ran
}

const SANDBOX = 'git@github.com:bookbaghq/codebook-plugin-sandbox.git'
const ELSEWHERE = 'https://github.com/someone/elsewhere.git'

function engine(on: On) {
  // The session's folder: origin is the sandbox, mirror pushes to two places, any other remote is elsewhere.
  const any = new Proxy({ origin: { fetch: [SANDBOX] }, mirror: { fetch: [SANDBOX], push: [ELSEWHERE, SANDBOX] } } as Repo['remotes'], {
    get: (all, name: string) => (name in all ? all[name] : { fetch: [ELSEWHERE] }),
  })
  // Two remotes: gh's default for this folder is origin (`gh repo set-default`), as a fork's checkout has it.
  const repo: Repo = { remotes: any, branch: 'codebook/57-refunds', config: { 'remote.origin.gh-resolved': 'base' } }
  return world(on, { cwd: '/work/sandbox', repoOf: () => ({ ...repo, remotes: any }) })
}

test('while a run is held, a push outside its repositories is refused and one inside goes through', async ($, on) => {
  const ran = engine(on)
  // No CodeBook run yet: the guard stands aside.
  await $.tool.call({ tool: 'Bash', command: 'git push fork main' } as never)
  expect(ran).toEqual(['git push fork main'])

  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  const refused = await $.tool.call({ tool: 'Bash', command: 'git push fork main' } as never)
  expect(String(refused.deny ?? refused.text)).toContain('someone/elsewhere')
  expect(ran.length).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'git push -u origin codebook/57-refunds' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --title "x"' } as never)
  expect(ran.length).toBe(3)

  const pr = await $.tool.call({ tool: 'Bash', command: 'gh pr create --repo acme/payments' } as never)
  expect(String(pr.deny ?? pr.text)).toContain('acme/payments')

  // The report ends the claim: the guard stands aside again.
  await $.tool.call({ tool: OWN + 'complete_work', run: 811, fence: 1, outcome: 'pass', summary: 'ok' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push fork main' } as never)
  expect(ran.length).toBe(4)
})

test('a command is read in its own folder: cd, pushd, git -C (relative to a cd), --git-dir, gh -R or GH_REPO', async () => {
  expect(targetsOf('cd ~/code && git -C sandbox-57 push -u origin codebook/57-x')).toEqual([{ kind: 'push', cwd: '~/code/sandbox-57', remote: 'origin' }])
  expect(targetsOf('pushd /work/a && git push')).toEqual([{ kind: 'push', cwd: '/work/a', remote: null }])
  expect(targetsOf('git --git-dir=/work/b/.git push')).toEqual([{ kind: 'push', cwd: '/work/b/.git', remote: null }])
  expect(targetsOf('git push --repo=https://github.com/someone/elsewhere.git')).toEqual([{ kind: 'push', cwd: null, remote: 'https://github.com/someone/elsewhere.git' }])
  expect(targetsOf('command /usr/bin/git push fork')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('{ cd /work/c; git push; }')).toEqual([{ kind: 'push', cwd: '/work/c', remote: null }])
  expect(targetsOf('gh pr create --draft -Racme/payments')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('GH_REPO=acme/payments gh pr create --draft')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('export GH_REPO=acme/payments && gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  // A subshell's cd does not outlive it, and popd goes back to a folder the guard cannot know: refused, not guessed.
  expect(targetsOf('(cd /work/other && git push)')).toBeNull()
  expect(targetsOf('pushd /work/a && popd && git push')).toBeNull()
})

/** The factory's checkout (and its worktrees) is not the session's folder: each folder has its own origin. */
function inFolders(on: On, folder = 'sandbox', repo = 'bookbaghq/codebook-plugin-sandbox') {
  const own = new RegExp(`^/Users/me/code/${folder}(-\\d+)?$`)
  return world(on, { cwd: '/work/session', repoOf: (dir) => ({ remotes: { origin: { fetch: [own.test(dir) ? `git@github.com:${repo}.git` : ELSEWHERE] } }, branch: 'main' }) }, repo,
    { path: '~/code', mode: 'clone_into', checkout_path: `~/code/${folder}` })
}

test('pushes from the factory checkout or its worktrees go through; other folders and repositories are refused', async ($, on) => {
  const ran = inFolders(on)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)

  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox push -u origin codebook/57-refunds' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/sandbox-57 push' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd ~/code/sandbox-57 && gh pr create --draft --title "SD-57"' } as never)
  expect(ran.length).toBe(3)

  const other = await $.tool.call({ tool: 'Bash', command: 'cd /Users/me/code/other && git push' } as never)
  expect(String(other.deny ?? other.text)).toContain('someone/elsewhere')
  const session = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(String(session.deny ?? session.text)).toContain('someone/elsewhere')
  const pr = await $.tool.call({ tool: 'Bash', command: 'cd ~/code/sandbox && gh pr create --draft --repo other/repo' } as never)
  expect(String(pr.deny ?? pr.text)).toContain('other/repo')
  expect(ran.length).toBe(3)
})

test('/factory status shows where each repository is on this computer, checked now', async ($, on) => {
  inFolders(on)
  on('command.register', () => ({ value: { command: 'factory' } }))
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  const typed = { command: 'factory', args: 'status', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
  const shown = await $.command.run(typed as never)
  const text = String((shown as { text?: string }).text)
  expect(text).toContain('No story is followed')
  expect(text).toContain('bookbaghq/codebook-plugin-sandbox: ~/code/sandbox — checked now: the code is there, origin matches')
})

test('local_code answers are read for each repository, and an older CodeBook names none', async () => {
  const brief = {
    repositories: [{ name: 'acme/payments' }],
    you: {
      local_code: {
        run_here_by_default: true,
        repositories: [
          { repository: 'r1', name: 'payments', clone_url: 'https://github.com/acme/payments.git', html_url: 'https://github.com/acme/payments', default_branch: 'main', path: '/Users/me/code/payments', mode: 'existing', checkout_path: '/Users/me/code/payments' },
          { repository: 'r2', name: 'site', clone_url: 'git@github.com:acme/site.git', html_url: 'https://github.com/acme/site', default_branch: 'main', path: null, mode: null, checkout_path: null },
        ],
      },
    },
  }
  expect(checkoutsOf('manager_brief', brief)).toEqual([
    { repository: 'acme/payments', checkoutPath: '/Users/me/code/payments', mode: 'existing' },
    { repository: 'acme/site', checkoutPath: null, mode: null },
  ])
  expect(checkoutsOf('set_local_checkout', brief.you.local_code)).toHaveLength(2)
  expect(checkoutsOf('manager_brief', { repositories: [{ name: 'acme/payments' }] })).toBeNull()
  expect(checkoutsOf('claim_work', { brief: { run_here: { repository: { name: 'acme/payments' } } } })).toBeNull()
  expect(checkoutsOf('claim_work', { brief: { run_here: { repository: { name: 'acme/payments', local: null } } } })).toEqual([{ repository: 'acme/payments', checkoutPath: null, mode: null }])
})

const EVIL = 'https://github.com/someone/elsewhere.git'
const ALLOWED = 'https://github.com/bookbaghq/codebook-plugin-sandbox.git'

test('git push: the repository on the command line wins over --repo, and option values are not the repository', async () => {
  expect(targetsOf(`git push --repo=${ALLOWED} ${EVIL} main`)).toEqual([{ kind: 'push', cwd: null, remote: EVIL }])
  expect(targetsOf(`git push --repo ${ALLOWED} ${EVIL}`)).toEqual([{ kind: 'push', cwd: null, remote: EVIL }])
  expect(targetsOf(`git push --repo=${ALLOWED} -u`)).toEqual([{ kind: 'push', cwd: null, remote: ALLOWED }])
  expect(targetsOf(`git push -o ${ALLOWED} ${EVIL}`)).toEqual([{ kind: 'push', cwd: null, remote: EVIL }])
  expect(targetsOf(`git push --push-option ${ALLOWED} ${EVIL} main`)).toEqual([{ kind: 'push', cwd: null, remote: EVIL }])
  expect(targetsOf(`git push --push-option=ci.skip origin main`)).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  expect(targetsOf(`git push -u -- ${EVIL} main`)).toEqual([{ kind: 'push', cwd: null, remote: EVIL }])
  expect(targetsOf('git push origin main 2>&1 | tail -5')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  expect(targetsOf('git push > /tmp/push.log origin main')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  // A GitHub address is read only as github.com itself, never a github.com path on another host.
  expect(repoOf('https://evil.example/github.com/bookbaghq/codebook-plugin-sandbox.git')).toBeNull()
  expect(repoOf('ssh://git@github.com:22/bookbaghq/codebook-plugin-sandbox.git')).toBe('bookbaghq/codebook-plugin-sandbox')
})

test('GH_REPO counts only exported or set before that gh', async () => {
  expect(targetsOf('GH_REPO=acme/payments; gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: null }])
  expect(targetsOf('GH_REPO=acme/payments && gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: null }])
  expect(targetsOf('GH_REPO=acme/payments gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('export GH_REPO=acme/payments; gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('export GH_REPO=acme/payments; unset GH_REPO; gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: null, ghRepoUnset: true }])
  expect(targetsOf('GH_REPO=acme/payments gh pr create --repo other/x')).toEqual([{ kind: 'pr', cwd: null, repo: 'other/x' }])
  // A value that looks like -R in a title is the title's.
  expect(targetsOf('gh pr create --title -Rother/x --repo acme/payments')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
})

test('forms the guard can read are read through: if/then, !, &, a backslash, quoted separators', async () => {
  expect(targetsOf('if true; then git push fork main; fi')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('! git push fork')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('true & git push fork')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('\\git push fork')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('while true; do git push fork; done')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('GIT_TERMINAL_PROMPT=0 git push origin b')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  // Quoted text is one word: a `;` or `&&` in a commit message does not split the command.
  expect(targetsOf('git commit -m "push the fix; then && git push fork" && git push origin b')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  expect(targetsOf("git commit -m 'push; git push fork'")).toEqual([])
  // Ordinary commands stay allowed.
  expect(targetsOf('git commit -m "push the fix"')).toEqual([])
  expect(targetsOf('git log --oneline -5')).toEqual([])
  expect(targetsOf('echo push')).toEqual([])
  expect(targetsOf('git stash push -m wip')).toEqual([])
  expect(targetsOf('grep -rn "git push" docs')).toEqual([])
  expect(targetsOf('gh api repos/acme/payments/pulls/3')).toEqual([])
  expect(targetsOf('git config --get remote.origin.url && git push origin b')).toEqual([{ kind: 'push', cwd: null, remote: 'origin' }])
  expect(targetsOf('git remote set-url origin git@github.com:acme/payments.git')).toEqual([])
  expect(targetsOf('cd /work/x || exit 1; git push origin b')).toEqual([{ kind: 'push', cwd: '/work/x', remote: 'origin' }])
})

test('push-like forms the guard cannot attribute are refused (null)', async () => {
  const unreadable = [
    'env -u FOO git push fork',
    'timeout 60 git push fork',
    'nice git push',
    'xargs git push',
    'sudo git push fork',
    'find . -name .git -execdir git push \;',
    'git -c alias.p=push p fork',
    "git -c alias.p='!git push fork' p",
    'git -c remote.origin.pushurl=https://github.com/someone/elsewhere.git push origin',
    'git -c url.https://github.com/someone/.insteadOf=https://github.com/bookbaghq/ push origin',
    'git -c branch.main.pushRemote=fork push',
    "bash <<'EOF'\ngit push fork\nEOF",
    "cat <<'EOF' | sh\ngit push fork\nEOF",
    "python3 <<'EOF'\nimport os; os.system('git push fork')\nEOF",
    'echo "git push fork" | sh',
    'python3 -c "import os; os.system(\'git push fork\')"',
    'eval "$PUSH"; git push origin',
    'gh api repos/x/y/pulls -X POST',
    'gh api repos/x/y/pulls --method POST -f title=t',
    'gh api repos/x/y/pulls --method=PATCH',
    'gh api repos/x/y/pulls -f title=t -f head=b -f base=main',
    'gh api repos/x/y/pulls -F draft=true',
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
    'gh api repos/x/y/git/refs -X POST -f ref=refs/heads/b -f sha=abc',
    'gh repo create x/y --source . --push',
    'GIT_DIR=/tmp/evil/.git git push origin',
    'export GIT_DIR=/tmp/evil/.git; git push origin',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=x git push origin',
    'git remote set-url origin https://github.com/someone/elsewhere.git && git push origin',
    'git remote set-url --push origin x; git push',
    'git remote remove origin && git remote add origin x && git push origin',
    'git remote rename fork origin && git push origin',
    'git config remote.origin.pushurl https://github.com/someone/elsewhere.git && git push',
    'git config --global url.https://github.com/someone/.pushInsteadOf https://github.com/bookbaghq/ && git push origin',
    'git remote set-url origin x && gh pr create',
    'git submodule foreach git push',
    'git rebase -x "git push fork" main',
    'git send-pack https://github.com/someone/elsewhere.git main',
    'git push --recurse-submodules=on-demand origin b',
    'cd /work/a || cd /work/b && git push',
    'cd /work/a | cat; git push',
    'cd - && git push',
    'if false; then cd /work/a; fi; git push',
    'git commit -m "unclosed && git push fork',
    'cat <(git push fork)',
  ]
  for (const command of unreadable) expect([command, targetsOf(command)]).toEqual([command, null])
})

test('while a run is held, an unreadable push is refused with the plain form to use instead', async ($, on) => {
  const ran = engine(on)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  const refused = await $.tool.call({ tool: 'Bash', command: 'timeout 60 git push origin b' } as never)
  expect(String(refused.deny)).toContain('git -C <checkout> push <remote> <branch>')
  expect(String(refused.deny)).toContain('gh pr create --repo <owner/name>')
  const viaRepo = await $.tool.call({ tool: 'Bash', command: `git push --repo=${ALLOWED} ${EVIL} main` } as never)
  expect(String(viaRepo.deny)).toContain('someone/elsewhere')
  const viaOption = await $.tool.call({ tool: 'Bash', command: `git push -o ${ALLOWED} ${EVIL}` } as never)
  expect(String(viaOption.deny)).toContain('someone/elsewhere')
  // A remote with two push addresses pushes to both: each must be allowed.
  const mirror = await $.tool.call({ tool: 'Bash', command: 'git push mirror main' } as never)
  expect(String(mirror.deny)).toContain('someone/elsewhere')
  expect(ran.length).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "push the fix; then && more"' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline -3' } as never)
  await $.tool.call({ tool: 'Bash', command: `GH_REPO=bookbaghq/codebook-plugin-sandbox gh pr create --draft` } as never)
  expect(ran.length).toBe(3)
})

test('"$HOME" and ${HOME} at the start of a folder are the home folder, quoted or not', async ($, on) => {
  const ran = inFolders(on, 'payments', 'acme/payments')
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  expect(targetsOf('cd "$HOME/code/payments" && git push -u origin b')).toEqual([{ kind: 'push', cwd: '$HOME/code/payments', remote: 'origin' }])
  expect(targetsOf('cd "$HOME/code" && git -C payments-26 push')).toEqual([{ kind: 'push', cwd: '$HOME/code/payments-26', remote: null }])
  await $.tool.call({ tool: 'Bash', command: 'cd "$HOME/code/payments" && git push -u origin b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C "$HOME/code/payments-26" push' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C ${HOME}/code/payments-26 push origin b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd $HOME/code/payments && gh pr create --draft --title "PAY-26"' } as never)
  expect(ran.length).toBe(4)
  // `~user` is another person's home, not this one: not the checkout.
  const other = await $.tool.call({ tool: 'Bash', command: 'git -C ~me/code/payments push' } as never)
  expect(String(other.deny)).toContain('someone/elsewhere')
  const elsewhere = await $.tool.call({ tool: 'Bash', command: 'cd "$HOME/code/other" && git push' } as never)
  expect(String(elsewhere.deny)).toContain('someone/elsewhere')
  // A bare GH_REPO=… is not exported: gh opens the pull request in the folder's own repository.
  const bareGhRepo = await $.tool.call({ tool: 'Bash', command: 'cd /Users/me/code/other && GH_REPO=acme/payments; gh pr create' } as never)
  expect(String(bareGhRepo.deny)).toContain('someone/elsewhere')
  expect(ran.length).toBe(4)
})

test('a claim with both repository and repositories reads all of repositories', async () => {
  const brief = {
    run_here: {
      repository: { name: 'acme/a', local: { checkout_path: '/Users/me/code/a', mode: 'existing' } },
      repositories: [
        { name: 'acme/a', local: { checkout_path: '/Users/me/code/a', mode: 'existing' } },
        { name: 'acme/b', local: { checkout_path: '/Users/me/code/b', mode: 'clone_into' } },
      ],
    },
  }
  expect(checkoutsOf('claim_work', { brief })).toEqual([
    { repository: 'acme/a', checkoutPath: '/Users/me/code/a', mode: 'existing' },
    { repository: 'acme/b', checkoutPath: '/Users/me/code/b', mode: 'clone_into' },
  ])
  expect(checkoutsOf('claim_work', { brief: { run_here: { repository: { name: 'acme/a', local: null }, repositories: [] } } })).toEqual([
    { repository: 'acme/a', checkoutPath: null, mode: null },
  ])
  expect(allowedOf(brief)).toEqual(['acme/a', 'acme/b'])
})

// ── The gaps closed in 0.13.0: what git and gh decide, aliases, scripts, the session's shell ────────────────────────

const SAND = 'bookbaghq/codebook-plugin-sandbox'
/** A held claim on the sandbox, in a folder set up as `repo` says; returns the commands that ran and a runner. */
async function held($: { tool: { call: (e: never) => Promise<{ deny?: string; text?: string }> } }, on: On, repo: Repo, more: Partial<World> = {}) {
  const ran = world(on, { cwd: '/work/sandbox', repoOf: () => repo, ...more })
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  const bash = async (command: string) => String((await $.tool.call({ tool: 'Bash', command } as never)).deny ?? '')
  return { ran, bash }
}

test('a plain git push goes where git sends it: pushRemote, then pushDefault, then the branch\'s remote, then origin', async ($, on) => {
  const remotes = { origin: { fetch: [SANDBOX] }, fork: { fetch: [ELSEWHERE] } }
  {
    const { ran, bash } = await held($, on, { remotes, branch: 'b', config: { 'branch.b.pushremote': 'fork', 'remote.pushdefault': 'origin', 'branch.b.remote': 'origin' } })
    expect(await bash('git push')).toContain('someone/elsewhere')
    expect(await bash('git push origin b')).toBe('')
    expect(ran).toEqual(['git push origin b'])
  }
})

test('pushDefault and the branch\'s own remote count when there is no pushRemote; a configured address is read too', async ($, on) => {
  const remotes = { origin: { fetch: [SANDBOX] }, fork: { fetch: [ELSEWHERE] } }
  const a = await held($, on, { remotes, branch: 'b', config: { 'remote.pushdefault': 'fork' } })
  expect(await a.bash('git push')).toContain('someone/elsewhere')
})

test('the branch\'s remote, then origin', async ($, on) => {
  const remotes = { origin: { fetch: [SANDBOX] }, fork: { fetch: [ELSEWHERE] } }
  const a = await held($, on, { remotes, branch: 'b', config: { 'branch.b.remote': 'fork' } })
  expect(await a.bash('git push')).toContain('someone/elsewhere')
})

test('with nothing configured, origin; on a detached HEAD too', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: null })
  expect(await a.bash('git push')).toBe('')
  expect(a.ran).toEqual(['git push'])
})

test('a push straight to an address is rewritten as git rewrites it: pushInsteadOf, else insteadOf', async ($, on) => {
  const config = { 'url.https://github.com/someone/elsewhere.pushinsteadof': 'https://github.com/bookbaghq/codebook-plugin-sandbox' }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b', config })
  expect(await a.bash('git push https://github.com/bookbaghq/codebook-plugin-sandbox.git b')).toContain('someone/elsewhere')
  expect(a.ran).toEqual([])
})

test('insteadOf applies when no pushInsteadOf does, and an address with no rule is read as it is', async ($, on) => {
  const config = { 'url.git@github.com:someone/.insteadof': 'gh:' }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b', config })
  expect(await a.bash('git push gh:elsewhere.git b')).toContain('someone/elsewhere')
  expect(await a.bash('git push git@github.com:bookbaghq/codebook-plugin-sandbox.git b')).toBe('')
  expect(a.ran.length).toBe(1)
})

test('gh pr create without --repo goes where gh sends it: the default repository, else the only remote; several and no default are refused', async ($, on) => {
  const two = { origin: { fetch: [SANDBOX] }, upstream: { fetch: [ELSEWHERE] } }
  {
    const a = await held($, on, { remotes: two, branch: 'b' })
    expect(await a.bash('gh pr create --draft')).toContain('2 remotes (origin, upstream) and no default')
    expect(await a.bash(`gh pr create --draft --repo ${SAND}`)).toBe('')
  }
})

test('gh repo set-default on the fork\'s upstream sends the pull request there: refused', async ($, on) => {
  const two = { origin: { fetch: [SANDBOX] }, upstream: { fetch: [ELSEWHERE] } }
  const a = await held($, on, { remotes: two, branch: 'b', config: { 'remote.upstream.gh-resolved': 'base' } })
  expect(await a.bash('gh pr create --draft')).toContain('someone/elsewhere')
})

test('gh repo set-default on origin, or a single remote, goes through', async ($, on) => {
  const two = { origin: { fetch: [SANDBOX] }, upstream: { fetch: [ELSEWHERE] } }
  const a = await held($, on, { remotes: two, branch: 'b', config: { 'remote.origin.gh-resolved': 'base' } })
  expect(await a.bash('gh pr create --draft')).toBe('')
  expect(a.ran).toEqual(['gh pr create --draft'])
})

test('the session shell\'s GH_REPO counts as gh\'s, and its GIT_DIR or GIT_CONFIG_* refuses a push', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { shellEnv: { GH_REPO: 'someone/elsewhere', GIT_DIR: '/elsewhere/.git' } })
  expect(await a.bash('gh pr create --draft')).toContain('someone/elsewhere')
  expect(await a.bash('git push origin b')).toContain('GIT_DIR')
  // The command's own --repo still wins over the shell's GH_REPO.
  expect(await a.bash(`gh pr create --repo ${SAND}`)).toBe('')
  expect(a.ran.length).toBe(1)
})

test('git aliases are looked up: one that pushes or runs a shell is refused, any other runs', async ($, on) => {
  const config = { 'alias.p': 'push', 'alias.ship': '!git push fork', 'alias.lg': 'log --oneline' }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b', config })
  expect(await a.bash('git p')).toContain('git p is an alias for "push"')
  expect(await a.bash('git ship')).toContain('alias')
  expect(await a.bash('git lg -3')).toBe('')
  expect(a.ran).toEqual(['git lg -3'])
})

test('gh aliases and extensions: an alias that opens a pull request or calls the API is refused, an extension is refused, others run', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, {
    ghAliases: 'prc:\tpr create --repo someone/elsewhere\nco:\tpr checkout\n',
    ghExtensions: 'gh dash\tdlvhdr/gh-dash\tv4.0.0\n',
  })
  expect(await a.bash('gh prc')).toContain('gh prc is an alias for "pr create --repo someone/elsewhere"')
  expect(await a.bash('gh dash')).toContain('gh extension')
  expect(await a.bash('gh co 12')).toBe('')
  expect(a.ran).toEqual(['gh co 12'])
})

test('scripts are read: a file, an npm script (and what it runs), a Makefile; one that pushes is refused', async ($, on) => {
  const files = {
    '/work/sandbox/deploy.sh': '#!/bin/sh\nnpm run build\ngit push fork main\n',
    '/work/sandbox/scripts/build.sh': '#!/bin/sh\nnode build.mjs\n',
    '/work/sandbox/package.json': JSON.stringify({ scripts: { test: 'node test.mjs', release: 'npm run tag && npm run ship', tag: 'git tag v1', ship: 'git push --tags fork' } }),
    '/work/sandbox/Makefile': 'release:\n\tgit push origin main\n',
  }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { files })
  expect(await a.bash('./deploy.sh')).toContain('./deploy.sh pushes')
  expect(await a.bash('bash deploy.sh')).toContain('deploy.sh pushes')
  expect(await a.bash('npm run release')).toContain('"release" script')
  expect(await a.bash('make release')).toContain('Makefile')
  expect(await a.bash('bash scripts/build.sh')).toBe('')
  expect(await a.bash('npm test')).toBe('')
  expect(a.ran).toEqual(['bash scripts/build.sh', 'npm test'])
})

test('git alias chains are followed: an alias of an alias that pushes is refused', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b', config: { 'alias.p': 'q', 'alias.q': 'push fork', 'alias.s': 'st', 'alias.st': 'status' } })
  expect(await a.bash('git p')).toContain('alias')
  expect(await a.bash('git s')).toBe('')
  expect(a.ran).toEqual(['git s'])
})

test('the person\'s shell aliases and functions that run git or gh are refused', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { shellAliases: { gp: 'git push fork', ll: 'ls -la' }, shellFunctions: { ship: 'ship () {\n\tgit push "$@"\n}', greet: 'greet () {\n\techo hi\n}', sync: 'sync () {\n\tcommand git -C "$DIR" fetch\n}' } })
  expect(await a.bash('gp')).toContain('shell alias')
  expect(await a.bash('ship main')).toContain('shell function')
  expect(await a.bash('ll')).toBe('')
  expect(await a.bash('greet')).toBe('')
  expect(await a.bash('sync')).toBe('')
})

test('a shell that does not answer in time refuses a push, and only a push', async ($, on) => {
  const b = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { shellFails: true })
  expect(await b.bash('git push origin b')).toContain("could not read this session's shell")
  expect(await b.bash('git status')).toBe('')
})

test('a hook that pushes is refused with any git command', async ($, on) => {
  const files = {
    '/work/sandbox/.git/hooks/post-commit': '#!/bin/sh\ngit push fork HEAD\n',
    '/work/sandbox/.git/hooks/pre-push.sample': '#!/bin/sh\ngit push elsewhere\n',
  }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { files })
  expect(await a.bash('git commit -m x')).toContain('post-commit hook')
})

test('sample hooks and hooks that do not push are left alone', async ($, on) => {
  const quiet = { '/work/sandbox/.git/hooks/pre-commit': '#!/bin/sh\nnpm run lint\n', '/work/sandbox/.git/hooks/pre-push.sample': '#!/bin/sh\ngit push elsewhere\n' }
  const b = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { files: quiet })
  expect(await b.bash('git commit -m x')).toBe('')
})

test('scripts: no false alarms for array pushes, pushd or docker push; a script the command writes first is refused', async ($, on) => {
  const files = {
    '/work/sandbox/build.js': 'const out = []\nout.push(1)\n',
    '/work/sandbox/tidy.sh': '#!/bin/sh\npushd lib && ls && popd\n',
    '/work/sandbox/ship.sh': '#!/bin/sh\ndocker push registry/app:1\n',
    '/work/sandbox/sneak.sh': '#!/bin/sh\ngit "pu"sh fork\n',
    '/work/sandbox/package.json': JSON.stringify({ scripts: { preversion: 'git push fork', postinstall: 'node setup.js' } }),
    '/work/sandbox/sub/ci.mk': 'all:\n\tgit push fork\n',
  }
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' }, { files })
  expect(await a.bash('node build.js')).toBe('')
  expect(await a.bash('bash tidy.sh')).toBe('')
  expect(await a.bash('sh ship.sh')).toBe('')
  expect(await a.bash('sh sneak.sh')).toContain('sneak.sh pushes')
  expect(await a.bash('npm version patch')).toContain('"version" scripts')
  expect(await a.bash('npm install')).toBe('')
  expect(await a.bash('make -C sub -f ci.mk')).toContain('ci.mk')
  expect(await a.bash("printf 'git push fork' > new.sh && sh new.sh")).not.toBe('')
})

test('expansions, functions and eval around git or gh cannot be read and are refused; env is read through', async () => {
  // env is read through: its GH_REPO is that gh's.
  expect(readCommand('env GH_REPO=x/y gh pr create')?.targets).toEqual([{ kind: 'pr', cwd: null, repo: 'x/y' }])
  expect(readCommand('x=push; git $x fork')).toBeNull()
  expect(readCommand('f() { git "$@"; }; f push fork')).toBeNull()
  expect(readCommand('eval "git push fork"')).toBeNull()
  expect(readCommand('ls -la')).not.toBeNull()
  expect(readCommand('docker push registry/app:1')?.targets ?? null).toEqual([])
})

test('with no CodeBook run held, nothing is looked up and everything runs', async ($, on) => {
  const ran = world(on, { cwd: '/work/sandbox', repoOf: () => ({ remotes: { origin: { fetch: [ELSEWHERE] } }, config: { 'alias.p': 'push' } }) })
  await $.tool.call({ tool: 'Bash', command: 'git p' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(ran).toEqual(['git p', 'git push'])
})
