// The CLI accepts a plugin directory, not a test-file filter. Stage only the factory lifecycle test file.
// All connector/clock/store interactions in that file use the native plugin test kit's mocks.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { nativeResultsToTap } from './native-test-output.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = mkdtempSync(join(tmpdir(), 'codebook-factory-tests-'))
try {
  for (const name of ['hooks', 'types', '.claude-plugin']) cpSync(join(root, name), join(stage, name), { recursive: true })
  mkdirSync(join(stage, 'test'))
  cpSync(join(root, 'test/factory.test.tsx'), join(stage, 'test/factory.test.tsx'))
  const result = spawnSync('claude', ['plugin', 'test', stage], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  // Preserve the native diagnostics. CodeBook does not yet read its Bun-style result marks,
  // so transcribe only results the real runner printed; never infer a test pass from exit 0.
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  const report = nativeResultsToTap(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  if (report.error) console.error(report.error)
  else process.stdout.write(report.tap)
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status !== 0 ? result.status ?? 1 : (result.error || report.error || report.failed ? 1 : 0)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
