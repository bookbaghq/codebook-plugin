import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { allowedOf, repoOf, targetsOf } from '../hooks/guard'

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
