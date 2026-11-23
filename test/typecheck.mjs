// The type check: TypeScript 5.6.3 over hooks/, types/ and test/ against the `claude-code` declarations of the
// Claude Code installed here, with tsconfig.json's options (the ones those declarations' header gives a hooks
// module). It must report no errors, so a new type error is seen and not lost among old ones.
//
//   node --test test/typecheck.mjs
//
// `claude-code` is declared by the host, not by a package: Claude Code writes its `claude-code.d.ts` beside its
// plugin-authoring skill each time a session loads skills, and lays it in `.claude-plugin/types/` when it loads this
// folder as a mod it hot-reloads. This finds it, in this order:
//   1. CLAUDE_CODE_TYPES: a claude-code.d.ts, or a folder holding claude-code/index.d.ts;
//   2. .claude-plugin/types/claude-code/index.d.ts in this repository;
//   3. the plugin-authoring skill's types/claude-code.d.ts in the temporary folder's claude*/bundled-skills/, for the
//      version `claude --version` prints (CLAUDE_BIN names another binary), else the newest there.
// None found is a failure that names what is missing: a type check without the host's types checks nothing.
// TypeScript 5.2 is too old for these declarations (5.4 or newer); 5.6.3 is pinned so a release cannot move it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TYPESCRIPT = 'typescript@5.6.3'
const windows = process.platform === 'win32'

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
const list = (dir) => { try { return readdirSync(dir) } catch { return [] } }

/** The installed Claude Code's version, or null. */
function claudeVersion() {
  const run = spawnSync(process.env.CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8', shell: windows, timeout: 30000 })
  return /\b(\d+\.\d+\.\d+)\b/.exec(run.stdout || '')?.[1] ?? null
}

const byVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Where the host's declarations are, and what was searched. */
export function findHostTypes() {
  const searched = []
  const fromEnv = process.env.CLAUDE_CODE_TYPES
  if (fromEnv) {
    const file = isFile(fromEnv) ? fromEnv : join(fromEnv, 'claude-code', 'index.d.ts')
    searched.push(`CLAUDE_CODE_TYPES (${file})`)
    if (isFile(file)) return { file, from: 'CLAUDE_CODE_TYPES', searched }
  }
  const laid = join(ROOT, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
  searched.push(laid)
  if (isFile(laid)) return { file: laid, from: 'laid by the engine', searched }

  const version = claudeVersion()
  const roots = [...new Set([tmpdir(), ...(windows ? [] : ['/tmp', '/private/tmp'])])]
  const found = []
  for (const root of roots) {
    for (const base of list(root).filter((name) => /^claude(-|$)/.test(name))) {
      const skills = join(root, base, 'bundled-skills')
      searched.push(join(skills, '<version>', '*', 'plugin-authoring', 'types', 'claude-code.d.ts'))
      for (const v of list(skills).filter((name) => /^\d+\.\d+\.\d+$/.test(name))) {
        for (const hash of list(join(skills, v))) {
          const file = join(skills, v, hash, 'plugin-authoring', 'types', 'claude-code.d.ts')
          if (isFile(file)) found.push({ version: v, file })
        }
      }
    }
  }
  const exact = found.find((f) => f.version === version)
  if (exact) return { file: exact.file, from: `Claude Code ${version}`, searched }
  const newest = found.sort((a, b) => byVersion(b.version, a.version))[0]
  if (newest) return { file: newest.file, from: `Claude Code ${newest.version} (installed: ${version ?? 'not found'})`, searched }
  return { file: null, version, searched }
}

test('the type check passes with no errors', { timeout: 300000 }, () => {
  const host = findHostTypes()
  assert.ok(host.file, [
    'The claude-code type declarations were not found, so nothing can be type-checked.',
    `Claude Code here: ${host.version ?? 'not found on PATH (set CLAUDE_BIN)'}. Searched:`,
    ...host.searched.map((s) => `  ${s}`),
    'Start a Claude Code session once (it writes them beside its plugin-authoring skill), or set CLAUDE_CODE_TYPES.',
  ].join('\n'))

  const dir = mkdtempSync(join(tmpdir(), 'codebook-typecheck-'))
  try {
    const config = join(dir, 'tsconfig.json')
    writeFileSync(config, JSON.stringify({
      extends: join(ROOT, 'tsconfig.json'),
      files: [host.file],
      include: ['hooks', 'types', 'test'].map((part) => join(ROOT, part)),
    }, null, 2))
    const run = spawnSync('npx', ['--yes', '-p', TYPESCRIPT, 'tsc', '-p', config, '--pretty', 'false'], {
      cwd: ROOT, encoding: 'utf8', shell: windows, timeout: 280000,
    })
    const output = `${run.stdout || ''}${run.stderr || ''}`.split('\n').filter((l) => !l.startsWith('npm notice')).join('\n').trim()
    assert.equal(run.status, 0, `tsc (${TYPESCRIPT}, types from ${host.from}: ${host.file}) reported:\n${output || run.error?.message || 'nothing'}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
