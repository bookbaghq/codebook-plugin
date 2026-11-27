// The CLI accepts a plugin directory, not a test-file filter, so the files to run are staged in a folder of their own.
// With no arguments every test/*.test.tsx runs; with file arguments (`node scripts/test-factory.mjs test/guard.test.tsx`)
// only those do. All connector/clock/store interactions in them use the native plugin test kit's mocks.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { nativeResultsToTap } from './native-test-output.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asked = process.argv.slice(2)
const files = asked.length > 0
  ? asked.map(file => resolve(process.cwd(), file))
  : readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.tsx')).sort().map(name => join(root, 'test', name))
const missing = files.filter(file => !existsSync(file) || !file.endsWith('.test.tsx'))
if (missing.length > 0) {
  console.error(`No such test file (test/<name>.test.tsx): ${missing.join(', ')}`)
  process.exit(2)
}
const stage = mkdtempSync(join(tmpdir(), 'codebook-factory-tests-'))
try {
  for (const name of ['hooks', 'types', '.claude-plugin']) cpSync(join(root, name), join(stage, name), { recursive: true })
  const skillScripts = 'skills/factory-manager/scripts'
  cpSync(join(root, skillScripts), join(stage, skillScripts), { recursive: true })
  mkdirSync(join(stage, 'test'))
  cpSync(join(root, 'test/fixtures'), join(stage, 'test/fixtures'), { recursive: true })
  for (const file of files) cpSync(file, join(stage, 'test', basename(file)))
  console.error(`Running ${files.map(file => `test/${basename(file)}`).join(', ')}`)
  const result = spawnSync('claude', ['plugin', 'test', stage], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  // Preserve the native diagnostics. CodeBook does not yet read its Bun-style result marks,
  // so transcribe only results the real runner printed; never infer a test pass from exit 0.
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  const browser = files.some(file => basename(file) === 'proof.test.tsx')
    ? spawnSync(process.execPath, [join(root, 'scripts/test-story-browser.mjs')], { encoding: 'utf8', timeout: 80000 })
    : null
  if (browser) {
    process.stderr.write(browser.stderr ?? '')
    process.stdout.write(browser.stdout ?? '')
  }
  const report = nativeResultsToTap(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  if (report.error) console.error(report.error)
  else if (browser && browser.status === 0) {
    const passed = /^\(pass\) ([^\r\n]+)$/m.exec(browser.stdout ?? '')
    if (!passed) throw Error('The browser witness returned no executed assertion name.')
    process.stdout.write(report.tap.replace(/1\.\.(\d+)\n$/, (_, size) => {
      const number = Number(size) + 1
      return `ok ${number} - ${passed[1]}\n1..${number}\n`
    }))
  } else process.stdout.write(report.tap)
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status !== 0 ? result.status ?? 1 : (result.error || report.error || report.failed || (browser && browser.status !== 0) ? 1 : 0)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
