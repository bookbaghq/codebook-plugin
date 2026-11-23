import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { allowedOf, claimOf, expiresOf, leaseOf, mayReach, pushSpecOf, readCommand, repoOf, sentBranchOf, targetsOf } from '../hooks/guard'
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
  /** The connector's answer to one of its tools (its name without the prefix), in place of the stand-in's. */
  connector?: (name: string, call: Record<string, unknown>) => unknown
  /** What `$.store` holds when the test starts (what earlier sessions left there). */
  stored?: Record<string, unknown>
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
  mock.store(on, w.stored)
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
    const data = (tool.startsWith(OWN) ? w.connector?.(tool.slice(OWN.length), e as never) : undefined)
      ?? (tool === OWN + 'claim_work' ? { run: 811, where: 'here', lease: { fence: 1 }, brief: { run_here: { repository } } } : { recorded: true, run: 811 })
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

/** Two repositories on this computer: the factory's (its checkout and worktrees) and one no CodeBook run works on. */
function twoRepositories(on: On) {
  const factory = /^\/Users\/me\/code\/sandbox(-\d+)?$/
  const other = /^\/Users\/me\/code\/app$/
  const remote = (dir: string) => (factory.test(dir) ? 'git@github.com:bookbaghq/codebook-plugin-sandbox.git' : other.test(dir) ? 'https://github.com/bookbaghq/codebook-app.git' : ELSEWHERE)
  return world(on, { cwd: '/work/session', repoOf: (dir) => ({ remotes: { origin: { fetch: [remote(dir)] } }, branch: 'wave-j/j1' }) }, 'bookbaghq/codebook-plugin-sandbox',
    { path: '~/code', mode: 'clone_into', checkout_path: '~/code/sandbox' })
}

test('P2: a held run\'s guard lets the same session push to an unrelated repository, and still refuses what it should', async ($, on) => {
  const ran = twoRepositories(on)
  // A factory-worker sub-agent claims run 811 on the sandbox (Vibeforce WO-29's runs on 22 Nov).
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)

  // The main conversation (Wave J's J1 and J6) pushes to and opens a pull request on a repository no held run works on.
  await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/app push -u origin wave-j/j1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd /Users/me/code/app && gh pr create --draft --repo bookbaghq/codebook-app --title "J1"' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12 --repo bookbaghq/codebook-app --squash' } as never)
  // So does another sub-agent of the session.
  await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/app push -u origin wave-j/j6', agentId: 'track-j6' } as never)
  expect(ran).toEqual([
    'git -C /Users/me/code/app push -u origin wave-j/j1',
    'cd /Users/me/code/app && gh pr create --draft --repo bookbaghq/codebook-app --title "J1"',
    'gh pr merge 12 --repo bookbaghq/codebook-app --squash',
    'git -C /Users/me/code/app push -u origin wave-j/j6',
  ])

  // Without the run's lease, nobody pushes to the factory's repository: not the main conversation, not another agent.
  const main = await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push -u origin codebook/57-x' } as never)
  expect(String(main.deny ?? main.text)).toContain('bookbaghq/codebook-plugin-sandbox, which CodeBook run 811 works on')
  const pr = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --repo bookbaghq/codebook-plugin-sandbox', agentId: 'track-j6' } as never)
  expect(String(pr.deny ?? pr.text)).toContain('Only that run\'s worker')
  // What the guard cannot attribute is still refused while a run is held, with the plain form to use.
  const wrapped = await $.tool.call({ tool: 'Bash', command: 'timeout 60 git -C /Users/me/code/app push' } as never)
  expect(String(wrapped.deny ?? wrapped.text)).toContain('cannot tell where this command pushes')
  expect(ran.length).toBe(4)

  // The run's own worker pushes its branch, and nothing outside its run's repository.
  await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/sandbox-57 push -u origin codebook/57-x', agentId: 'worker-1' } as never)
  expect(ran.length).toBe(5)
  const out = await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/app push -u origin wave-j/j1', agentId: 'worker-1' } as never)
  expect(String(out.deny ?? out.text)).toContain('the factory allows bookbaghq/codebook-plugin-sandbox')
  const outPr = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --repo bookbaghq/codebook-app', agentId: 'worker-1' } as never)
  expect(String(outPr.deny ?? outPr.text)).toContain('bookbaghq/codebook-app')
  expect(ran.length).toBe(5)

  // Its report ends the lease: the factory's repository is anyone's again.
  await $.tool.call({ tool: OWN + 'complete_work', run: 811, fence: 1, outcome: 'pass', summary: 'ok', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push -u origin codebook/57-x' } as never)
  expect(ran.length).toBe(6)
})

test('P2: the lease is the claiming loop\'s: leaseOf and mayReach', async () => {
  const held = [{ run: 811, repos: ['acme/payments'], agentId: 'worker-1' }, { run: 812, repos: ['acme/site'] }]
  expect(leaseOf([], 'anyone')).toEqual({ kind: 'free' })
  const worker = leaseOf(held, 'worker-1')
  expect(worker).toEqual({ kind: 'worker', runs: [811], allowed: ['acme/payments'] })
  expect([mayReach(worker, 'acme/payments'), mayReach(worker, 'acme/site'), mayReach(worker, 'bookbaghq/codebook-app'), mayReach(worker, null)]).toEqual([true, false, false, false])
  // The main conversation claimed 812 itself (a crew's lead): it is that run's worker.
  expect(leaseOf(held, undefined)).toEqual({ kind: 'worker', runs: [812], allowed: ['acme/site'] })
  const other = leaseOf(held, 'track-j6')
  expect(other).toEqual({ kind: 'bystander', runs: [811, 812], held: ['acme/payments', 'acme/site'] })
  expect([mayReach(other, 'bookbaghq/codebook-app'), mayReach(other, 'acme/payments'), mayReach(other, 'acme/site'), mayReach(other, null)]).toEqual([true, false, false, false])
  // A claim names its loop and the story's key and branch, for the proof that follows.
  expect(claimOf(811, { run_here: { repository: { name: 'acme/payments' }, card_reference: { key: 'VF-29', branch: 'codebook/VF-29-run-811' } } }, 'worker-1'))
    .toEqual({ run: 811, repos: ['acme/payments'], agentId: 'worker-1', key: 'VF-29', branch: 'codebook/VF-29-run-811' })
  expect(claimOf(812, { run_here: { repository: null } }, undefined)).toEqual({ run: 812, repos: [] })
})

/**
 * #142: the factory's checkout (on main), a run's worktree beside it (on the run's branch) and another folder of the
 * same repository (on the run's branch too), all pushing to the sandbox.
 */
function runWorktree(on: On) {
  const branchOf = (dir: string) => (dir === '/Users/me/code/sandbox' ? 'main' : 'codebook/57-x')
  return world(on, { cwd: '/work/session', repoOf: (dir) => ({ remotes: { origin: { fetch: [SANDBOX] } }, branch: branchOf(dir) }) }, 'bookbaghq/codebook-plugin-sandbox',
    { path: '~/code', mode: 'clone_into', checkout_path: '~/code/sandbox' })
}

const DECLARE = { tool: OWN + 'declare_work', run: 811, fence: 1, repository: 'bookbaghq/codebook-plugin-sandbox', worktree: '~/code/sandbox-57', branch: 'codebook/57-x' }

test('P2: a claim without a loop does not block the worker that pushes its own declared branch from its own worktree', async ($, on) => {
  const ran = runWorktree(on)
  // Run 1157: the claim was recorded with no agentId (the main conversation's, or 0.24.1's), and so was its declaration.
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  await $.tool.call(DECLARE as never)
  // The sub-agent that does the work pushes the run's branch from the run's worktree: named, as HEAD, or the current one.
  await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/sandbox-57 push -u origin codebook/57-x', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd ~/code/sandbox-57 && git push origin HEAD', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd "$HOME/code/sandbox-57" && git push', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push origin HEAD:refs/heads/codebook/57-x', agentId: 'worker-1' } as never)
  expect(ran.length).toBe(4)
})

test('P2: declare_work re-attributes the run\'s claim to the loop that declares it', async ($, on) => {
  const ran = runWorktree(on)
  // Claimed by one loop (or by none), declared by the sub-agent that works it: the lease is now that sub-agent's.
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'old-loop' } as never)
  await $.tool.call({ ...DECLARE, agentId: 'worker-1' } as never)
  // As the run's worker it opens the pull request too, which an own push never excuses for a bystander.
  await $.tool.call({ tool: 'Bash', command: 'cd ~/code/sandbox-57 && gh pr create --draft --title "SD-57"', agentId: 'worker-1' } as never)
  expect(ran.length).toBe(1)
  // The loop that claimed it no longer holds it: it is a bystander to the run's repository.
  const old = await $.tool.call({ tool: 'Bash', command: 'cd ~/code/sandbox-57 && gh pr create --draft', agentId: 'old-loop' } as never)
  expect(String(old.deny ?? old.text)).toContain('Only that run\'s worker')
  // A declaration from the main conversation (no agentId) leaves the claim with its loop.
  await $.tool.call(DECLARE as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push origin codebook/57-y', agentId: 'worker-1' } as never)
  expect(ran.length).toBe(2)
  // A claim with no loop at all is adopted by the first loop that declares work for it.
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  await $.tool.call({ ...DECLARE, agentId: 'worker-2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push origin codebook/57-y', agentId: 'worker-2' } as never)
  expect(ran.length).toBe(3)
})

test('P2: a bystander is still refused the held repository, a different branch and a different folder', async ($, on) => {
  const ran = runWorktree(on)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  await $.tool.call({ ...DECLARE, agentId: 'worker-1' } as never)
  const refused = async (command: string) => {
    const got = await $.tool.call({ tool: 'Bash', command, agentId: 'track-j6' } as never)
    return String(got.deny ?? got.text)
  }
  // Another branch of the held repository, from the run's worktree.
  expect(await refused('git -C ~/code/sandbox-57 push origin codebook/57-y')).toContain('Only that run\'s worker')
  // The declared branch from another folder (the factory's checkout).
  expect(await refused('git -C ~/code/sandbox push origin codebook/57-x')).toContain('Only that run\'s worker')
  // A pull request from the run's worktree.
  expect(await refused('cd ~/code/sandbox-57 && gh pr create --draft --title "SD-57"')).toContain('Only that run\'s worker')
  // More than the declared branch, or not plainly: a second branch, tags, a force, a deletion.
  expect(await refused('git -C ~/code/sandbox-57 push origin codebook/57-x codebook/57-y')).toContain('Only that run\'s worker')
  expect(await refused('git -C ~/code/sandbox-57 push --tags origin codebook/57-x')).toContain('Only that run\'s worker')
  expect(await refused('git -C ~/code/sandbox-57 push --force origin codebook/57-x')).toContain('Only that run\'s worker')
  expect(await refused('git -C ~/code/sandbox-57 push origin +codebook/57-x')).toContain('Only that run\'s worker')
  expect(await refused('git -C ~/code/sandbox-57 push origin :codebook/57-x')).toContain('Only that run\'s worker')
  expect(ran.length).toBe(0)
  // The run's own branch from its own worktree goes through, from any loop.
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push origin codebook/57-x', agentId: 'track-j6' } as never)
  expect(ran.length).toBe(1)
})

test('P2: a claim with no declared branch or worktree excuses nothing', async ($, on) => {
  const ran = runWorktree(on)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811 } as never)
  const got = await $.tool.call({ tool: 'Bash', command: 'git -C ~/code/sandbox-57 push -u origin codebook/57-x', agentId: 'worker-1' } as never)
  expect(String(got.deny ?? got.text)).toContain('Only that run\'s worker')
  expect(ran.length).toBe(0)
  // What a push sends, as the guard reads it.
  const spec = (command: string) => pushSpecOf((targetsOf(command) ?? [])[0] ?? { kind: 'pr', cwd: null, repo: null })
  expect(spec('git push -u origin a b')).toEqual({ refs: ['a', 'b'], isPlain: true })
  expect(spec('git push --all origin')).toEqual({ refs: [], isPlain: false })
  expect(sentBranchOf({ refs: [], isPlain: true }, 'codebook/57-x')).toBe('codebook/57-x')
  expect(sentBranchOf({ refs: ['HEAD'], isPlain: true }, 'codebook/57-x')).toBe('codebook/57-x')
  expect(sentBranchOf({ refs: ['main:refs/heads/codebook/57-x'], isPlain: true }, null)).toBe('codebook/57-x')
  expect(sentBranchOf({ refs: ['refs/tags/v1'], isPlain: true }, null)).toBeNull()
  expect(sentBranchOf({ refs: ['a', 'b'], isPlain: true }, null)).toBeNull()
  expect(sentBranchOf({ refs: [], isPlain: true }, null)).toBeNull()
})

test('P2: a bystander\'s refusal names the blocking runs, their holders and the way out', async ($, on) => {
  // Two runs on the sandbox: 811 held by a sub-agent, 812 by the main conversation (a crew's lead).
  const brief = { run_here: { repository: { name: 'bookbaghq/codebook-plugin-sandbox' } } }
  const ran = world(on, {
    cwd: '/work/session',
    repoOf: () => ({ remotes: { origin: { fetch: [SANDBOX] } }, branch: 'main' }),
    connector: (name, call) => (name === 'claim_work' ? { run: call.run, where: 'here', lease: { fence: 1 }, brief } : undefined),
  })
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  await $.tool.call({ tool: OWN + 'claim_work', run: 812 } as never)
  const got = await $.tool.call({ tool: 'Bash', command: 'git -C /Users/me/code/sandbox push origin main', agentId: 'track-j6' } as never)
  const text = String(got.deny ?? got.text)
  // What the earlier wording said is still said.
  expect(text).toContain('bookbaghq/codebook-plugin-sandbox, which CodeBook run 811, 812 works on')
  expect(text).toContain('Only that run\'s worker')
  // Every blocking run, its repository and its holder.
  expect(text).toContain('run 811 on bookbaghq/codebook-plugin-sandbox, held by agent worker-1')
  expect(text).toContain('run 812 on bookbaghq/codebook-plugin-sandbox, held by the main conversation')
  // The ways out.
  expect(text).toContain('complete_work')
  expect(text).toContain('its lease lapses')
  expect(text).toContain('the main conversation, when it holds the run')
  expect(text).toContain('declared branch, pushed from its declared worktree, goes through from any loop')
  expect(ran).toEqual([])
})

test('P2: an unreadable command is refused with the one-command-at-a-time form', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' })
  for (const command of [
    'gh pr merge --repo bookbaghq/codebook-plugin-sandbox $(gh pr list --json number -q ".[0].number")',
    'timeout 60 git push origin b',
    'sh -c "git push origin b"',
  ]) {
    const text = await a.bash(command)
    expect(text).toContain('cannot tell where this command pushes')
    expect(text).toContain('git -C <checkout> push <remote> <branch>')
    expect(text).toContain('gh pr create --repo <owner/name>')
    expect(text).toContain('`for` or `while` loops, `$(…)` or backtick substitutions')
    expect(text).toContain('run each `gh pr merge --repo <owner/name> <n>`, each push and each pull request as its own command')
    expect(text).toContain('run 811 on bookbaghq/codebook-plugin-sandbox, held by the main conversation')
  }
  expect(a.ran).toEqual([])
})

test('P2: a worker\'s refusal names its declared branch and worktree', async ($, on) => {
  const ran = runWorktree(on)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  // Before declare_work: it says none is declared, and how to declare it.
  const before = await $.tool.call({ tool: 'Bash', command: 'git push fork main', agentId: 'worker-1' } as never)
  expect(String(before.deny ?? before.text)).toContain('the factory allows bookbaghq/codebook-plugin-sandbox')
  expect(String(before.deny ?? before.text)).toContain('Run 811 has no declared branch or worktree yet: call declare_work')
  await $.tool.call({ ...DECLARE, agentId: 'worker-1' } as never)
  const after = await $.tool.call({ tool: 'Bash', command: 'git push fork main', agentId: 'worker-1' } as never)
  expect(String(after.deny ?? after.text)).toContain('the factory allows bookbaghq/codebook-plugin-sandbox')
  expect(String(after.deny ?? after.text)).toContain('Run 811\'s declared branch is codebook/57-x in ~/code/sandbox-57.')
  expect(ran).toEqual([])
})

/**
 * #146: sessions by id. The engine's atoms are the host's for the process, which goes on under a new id after a /clear
 * or a resume, and a new process (claude --resume) starts with none: only the session's id tells sessions apart.
 */
function sessions(on: On, stored?: Record<string, unknown>) {
  const at = { session: 'session-a' }
  const ran = world(on, { cwd: '/work/session', repoOf: () => ({ remotes: { origin: { fetch: [SANDBOX] } }, branch: 'main' }), ...(stored ? { stored } : {}) })
  on('session.id', () => ({ value: at.session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  return { ran, at }
}

test('P4: another session\'s claims do not block this session\'s push', async ($, on) => {
  const { ran, at } = sessions(on)
  // Session A's factory worker claims run 811 on the sandbox.
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  const inA = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(inA.deny ?? inA.text)).toContain('which CodeBook run 811 works on')
  // Session B (another manager, or this process after a /clear) pushes there: A's run is not B's to respect.
  at.session = 'session-b'
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --repo bookbaghq/codebook-plugin-sandbox', agentId: 'track-j6' } as never)
  expect(ran).toEqual(['git push origin main', 'gh pr create --draft --repo bookbaghq/codebook-plugin-sandbox'])
  // B's own claim binds only B.
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-2' } as never)
  const inB = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(inB.deny ?? inB.text)).toContain('held by agent worker-2')
  expect(ran.length).toBe(2)
})

test('P4: a resumed session keeps its own claims', async ($, on) => {
  // What session A left in the plugin's store before its process ended, and an old session's leftover.
  const T = Date.now()
  const { ran, at } = sessions(on, {
    'claims-1:session-a': { at: T, claims: [{ run: 811, repos: ['bookbaghq/codebook-plugin-sandbox'], agentId: 'worker-1' }] },
    'claims-1:session-old': { at: T - 31 * 24 * 3600 * 1000, claims: [{ run: 700, repos: ['bookbaghq/codebook-app'], agentId: 'worker-9' }] },
  })
  // claude --resume: a new process, the same id. Its claim still holds.
  const resumed = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(resumed.deny ?? resumed.text)).toContain('run 811 on bookbaghq/codebook-plugin-sandbox, held by agent worker-1')
  // Away to another session and back: still its own.
  at.session = 'session-b'
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  at.session = 'session-a'
  const back = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(back.deny ?? back.text)).toContain('which CodeBook run 811 works on')
  expect(ran).toEqual(['git push origin main'])
  // Its report ends the claim.
  await $.tool.call({ tool: OWN + 'complete_work', run: 811, fence: 1, outcome: 'pass', summary: 'ok', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(ran.length).toBe(2)
  // A session gone for longer than KEEP_SESSION_MS is cleared when another session starts: resuming it finds nothing held.
  at.session = 'session-old'
  const old = await $.tool.call({ tool: 'Bash', command: 'git push https://github.com/bookbaghq/codebook-app.git main' } as never)
  expect(String(old.deny ?? old.text)).toContain('run 700 on bookbaghq/codebook-app, held by agent worker-9')
  at.session = 'session-a'
  await $.session.start({ cwd: '/work/session', surface: 'cli', isInteractive: true } as never)
  at.session = 'session-old'
  await $.tool.call({ tool: 'Bash', command: 'git push https://github.com/bookbaghq/codebook-app.git main' } as never)
  expect(ran.length).toBe(3)
})

/** #143: CodeBook's answers carry the lease, shaped like app.codebook.work's; the clock starts at T0. */
const T0 = Date.parse('2026-11-23T19:00:00.000Z')
const leaseAt = (ms: number) => ({ fence: 2, expires_at: new Date(T0 + ms).toISOString(), seconds: 3600, heartbeat_every_seconds: 1200 })
function leased(on: On, answers: Record<string, unknown>) {
  const ran = world(on, { cwd: '/work/session', repoOf: () => ({ remotes: { origin: { fetch: [SANDBOX] } }, branch: 'main' }), connector: name => answers[name] })
  const clock = mock.clock(on, { now: T0 })
  return { ran, clock }
}
const CLAIMED = (lease: unknown) => ({ run: 811, where: 'here', lease, brief: { run_here: { repository: { name: 'bookbaghq/codebook-plugin-sandbox' } } } })

test('P3: a claim whose lease has expired no longer blocks a push', async ($, on) => {
  const answers: Record<string, unknown> = { claim_work: CLAIMED(leaseAt(60_000)) }
  const { ran, clock } = leased(on, answers)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  const held = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(held.deny ?? held.text)).toContain('which CodeBook run 811 works on')
  // The lease runs out (the run went back to waiting, or its sub-agent stopped): another loop pushes there again.
  await clock.advance(60_001)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(ran).toEqual(['git push origin main'])
  // And the claim is gone: a later answer for that run does not bring it back, and its old worker is held to nothing.
  answers.heartbeat_work = { run: 811, lease: leaseAt(600_000) }
  await $.tool.call({ tool: OWN + 'heartbeat_work', run: 811, fence: 2, agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push fork main', agentId: 'worker-1' } as never)
  expect(ran.length).toBe(3)
})

test('P3: a heartbeat renews the claim\'s lease', async ($, on) => {
  const answers: Record<string, unknown> = { claim_work: CLAIMED(leaseAt(60_000)), heartbeat_work: { run: 811, lease: leaseAt(120_000) } }
  const { ran, clock } = leased(on, answers)
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  await $.tool.call({ tool: OWN + 'heartbeat_work', run: 811, fence: 2, agentId: 'worker-1' } as never)
  // An answer with an earlier expires_at does not shorten it.
  answers.run_note = { run: 811, lease: leaseAt(30_000) }
  await $.tool.call({ tool: OWN + 'run_note', run: 811, fence: 2, text: 'x', agentId: 'worker-1' } as never)
  // Past the first expiry the claim is still in force.
  await clock.advance(90_000)
  const held = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(held.deny ?? held.text)).toContain('which CodeBook run 811 works on')
  // A run_artifact answer renews it too; past the last expiry it lapses.
  answers.run_artifact = { run: 811, lease: leaseAt(150_000) }
  await $.tool.call({ tool: OWN + 'run_artifact', run: 811, fence: 2, kind: 'test_report', title: 'x', agentId: 'worker-1' } as never)
  await clock.advance(40_000)
  const still = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(still.deny ?? still.text)).toContain('which CodeBook run 811 works on')
  await clock.advance(20_001)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(ran).toEqual(['git push origin main'])
})

test('P3: a claim without a lease is not dropped by time', async ($, on) => {
  const { ran, clock } = leased(on, { claim_work: CLAIMED({ fence: 1 }) })
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  await clock.advance(7_200_000)
  const held = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(held.deny ?? held.text)).toContain('which CodeBook run 811 works on')
  expect(ran.length).toBe(0)
  // Only its report ends it.
  await $.tool.call({ tool: OWN + 'complete_work', run: 811, fence: 1, outcome: 'pass', summary: 'ok', agentId: 'worker-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(ran.length).toBe(1)
  // Reading an answer's lease: an ISO time, a number, or nothing that can be read.
  expect(expiresOf({ expires_at: '2026-11-23T19:41:57.260Z' })).toBe(Date.parse('2026-11-23T19:41:57.260Z'))
  expect(expiresOf({ expires_at: 'soon' })).toBeUndefined()
  expect(expiresOf(undefined)).toBeUndefined()
})

test('P3: a live claim still blocks a bystander\'s push', async ($, on) => {
  const { ran, clock } = leased(on, { claim_work: CLAIMED(leaseAt(60_000)) })
  await $.tool.call({ tool: OWN + 'claim_work', run: 811, agentId: 'worker-1' } as never)
  await clock.advance(59_000)
  const main = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String(main.deny ?? main.text)).toContain('which CodeBook run 811 works on')
  const other = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --repo bookbaghq/codebook-plugin-sandbox', agentId: 'track-j6' } as never)
  expect(String(other.deny ?? other.text)).toContain('Only that run\'s worker')
  // Its own worker still pushes there.
  await $.tool.call({ tool: 'Bash', command: 'git push origin main', agentId: 'worker-1' } as never)
  expect(ran).toEqual(['git push origin main'])
  // leaseOf reads the same: live before expires_at, free after it.
  const claim = { run: 811, repos: ['bookbaghq/codebook-plugin-sandbox'], agentId: 'worker-1', expiresAt: T0 + 60_000 }
  expect(leaseOf([claim], undefined, T0 + 59_000).kind).toBe('bystander')
  expect(leaseOf([claim], undefined, T0 + 60_000).kind).toBe('free')
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

test('P6: a script body whose only push is a method call is not refused', async ($, on) => {
  // The manager's own edits on 23 Nov, while a run was held: a python3 script in a quoted here-document.
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' })
  const python = "python3 - <<'EOF'\nimport json\nitems = []\nitems.push(x)\nlist.push(x)\nprint(json.dumps(items))\nEOF"
  expect(await a.bash(python)).toBe('')
  const node = "cd /work/sandbox && node - <<'EOF'\nconst lines = []\nlines.push('a')\nlines.push ('b')\nEOF"
  expect(await a.bash(node)).toBe('')
  expect(a.ran).toEqual([python, node])
  // Read as nothing push-like: no targets, and the command is not refused when the guard cannot read the rest.
  expect(readCommand(python)?.pushLike).toBe(false)
  expect(readCommand(python)?.targets).toEqual([])
})

test('P6: a method call named push in an inline script is not refused', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' })
  expect(await a.bash("node -e 'const arr = []; arr.push(1); console.log(arr)'")).toBe('')
  expect(await a.bash('node -e "out.push (2)"')).toBe('')
  expect(await a.bash("python3 -c 'stack = []; stack.push(1)'")).toBe('')
  expect(a.ran.length).toBe(3)
  // Push-like words that are not a method call still count: read word by word, and refused when they cannot be read.
  expect(readCommand('pushd lib')?.pushLike).toBe(true)
  expect(readCommand("node -e 'arr.push'")).toBeNull()
  expect(readCommand('git push')?.pushLike).toBe(true)
})

test('P6: a script that really pushes is still refused', async ($, on) => {
  const a = await held($, on, { remotes: { origin: { fetch: [SANDBOX] } }, branch: 'b' })
  expect(await a.bash('sh -c "git push other"')).toContain('cannot tell where this command pushes')
  expect(await a.bash("python3 - <<'EOF'\nimport subprocess\nitems.push(1)\nsubprocess.run(['git', 'push', 'other'])\nEOF")).toContain('cannot tell where this command pushes')
  expect(await a.bash("bash <<'EOF'\ngit push other\nEOF")).toContain('cannot tell where this command pushes')
  expect(await a.bash("node -e 'arr.push(1); require(\"child_process\").execSync(\"gh pr create --fill\")'")).toContain('cannot tell where this command pushes')
  // A script the command writes from a here-document, then runs: what it will say cannot be read now.
  expect(await a.bash("cat > /work/sandbox/d.sh <<'EOF'\nlist.push(1)\ngit push other\nEOF\nsh /work/sandbox/d.sh")).not.toBe('')
  expect(a.ran).toEqual([])
  // sh -c "git push other" reads as unreadable, as before.
  expect(targetsOf('sh -c "git push other"')).toBeNull()
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
