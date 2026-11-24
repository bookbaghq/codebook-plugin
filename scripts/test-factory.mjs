// The CLI accepts a plugin directory, not a test-file filter. Stage only the factory lifecycle test file.
// All connector/clock/store interactions in that file use the native plugin test kit's mocks.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = mkdtempSync(join(tmpdir(), 'codebook-factory-tests-'))
try {
  for (const name of ['hooks', 'types', '.claude-plugin']) cpSync(join(root, name), join(stage, name), { recursive: true })
  mkdirSync(join(stage, 'test'))
  cpSync(join(root, 'test/factory.test.tsx'), join(stage, 'test/factory.test.tsx'))
  const result = spawnSync('claude', ['plugin', 'test', stage], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(stage, { recursive: true, force: true })
}
