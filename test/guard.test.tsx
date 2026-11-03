import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { allowedOf, repoOf, targetsOf } from '../hooks/guard'
import { checkoutsOf } from '../hooks/local'

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
  expect(targetsOf('git -C /tmp/x push')).toEqual([{ kind: 'push', cwd: '/tmp/x', remote: 'origin' }])
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

function engine(on: On) {
  const ran: string[] = []
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/sandbox' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('process.run', (_, e) => {
    const remote = e.argv.at(-1)
    const url = remote === 'origin' ? 'git@github.com:bookbaghq/codebook-plugin-sandbox.git' : 'https://github.com/someone/elsewhere.git'
    return { value: { exitCode: 0, stdout: `${url}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Bash') {
      ran.push(String((e as { command?: unknown }).command))
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    }
    const data =
      tool === OWN + 'claim_work'
        ? { run: 811, where: 'here', lease: { fence: 1 }, brief: { run_here: { repository: { name: 'bookbaghq/codebook-plugin-sandbox' } } } }
        : { recorded: true, run: 811 }
    return { result: { structuredContent: data } as never, text: JSON.stringify(data) }
  })
  return ran
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
  expect(targetsOf('pushd /work/a && git push')).toEqual([{ kind: 'push', cwd: '/work/a', remote: 'origin' }])
  expect(targetsOf('git --git-dir=/work/b/.git push')).toEqual([{ kind: 'push', cwd: '/work/b/.git', remote: 'origin' }])
  expect(targetsOf('git push --repo=https://github.com/someone/elsewhere.git main')).toEqual([{ kind: 'push', cwd: null, remote: 'https://github.com/someone/elsewhere.git' }])
  expect(targetsOf('command /usr/bin/git push fork')).toEqual([{ kind: 'push', cwd: null, remote: 'fork' }])
  expect(targetsOf('{ cd /work/c; git push; }')).toEqual([{ kind: 'push', cwd: '/work/c', remote: 'origin' }])
  expect(targetsOf('gh pr create --draft -Racme/payments')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('GH_REPO=acme/payments gh pr create --draft')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  expect(targetsOf('export GH_REPO=acme/payments && gh pr create')).toEqual([{ kind: 'pr', cwd: null, repo: 'acme/payments' }])
  // A subshell's cd does not outlive it, and popd goes back to a folder the guard cannot know: refused, not guessed.
  expect(targetsOf('(cd /work/other && git push)')).toBeNull()
  expect(targetsOf('pushd /work/a && popd && git push')).toBeNull()
})

/** The factory's checkout (and its worktrees) is not the session's folder: each folder has its own origin. */
function inFolders(on: On) {
  const ran: string[] = []
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/session' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('process.run', (_, e) => {
    const dir = e.argv[2] ?? ''
    const url = /^\/Users\/me\/code\/sandbox(-\d+)?$/.test(dir) ? 'git@github.com:bookbaghq/codebook-plugin-sandbox.git' : 'https://github.com/someone/elsewhere.git'
    const top = e.argv[3] === 'rev-parse'
    return { value: { exitCode: 0, stdout: `${top ? dir : url}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Bash') {
      ran.push(String((e as { command?: unknown }).command))
      return { result: { stdout: '', stderr: '', interrupted: false } as never }
    }
    const repository = { name: 'bookbaghq/codebook-plugin-sandbox', local: { path: '~/code', mode: 'clone_into', checkout_path: '~/code/sandbox' } }
    const data = { run: 811, where: 'here', lease: { fence: 1 }, brief: { run_here: { repository } } }
    return { result: { structuredContent: data } as never, text: JSON.stringify(data) }
  })
  return ran
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
