// Exercise the actual production hook and local sandbox. Only the Bookbag RPC/report services are disposable stand-ins.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = await realpath(await mkdtemp(join(tmpdir(), 'codebook-locked-proof-test-')))
const exec = promisify(execFile)
const sys = async (argv, cwd, env = {}) => {
  try {
    const { stdout, stderr } = await exec(argv[0], argv.slice(1), {
      cwd,
      env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
      timeout: 310000,
      maxBuffer: 16 << 20
    })
    return { exitCode: 0, stdout, stderr }
  } catch (e) {
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}
try {
  for (const name of ['proof', 'connector', 'egress', 'lockedDependencies']) {
    const text = await readFile(join(root, 'hooks', name + '.ts'), 'utf8')
    const source = stripTypeScriptTypes(text, { mode: 'transform' }).replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'")
    await writeFile(join(temp, name + '.mjs'), source)
  }
  const { runProof } = await import(pathToFileURL(join(temp, 'proof.mjs')))
  const repo = join(temp, 'fixture'),
    pkg = join(temp, 'package')
  await mkdir(join(repo, 'test'), { recursive: true })
  await mkdir(pkg)
  const git = async (...args) => {
    const out = await sys(
      ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args],
      repo
    )
    assert.equal(out.exitCode, 0, out.stderr)
    return out.stdout.trim()
  }
  await git('init', '-b', 'main')
  await git('remote', 'add', 'origin', 'https://github.com/fixture/offline.git')
  const archive = join(temp, 'fixture.tgz')
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'unit-fixture', version: '1.0.0', main: 'index.cjs', scripts: { postinstall: 'exit 71' } })
  )
  await writeFile(join(pkg, 'index.cjs'), 'module.exports=42;\n')
  assert.equal((await sys(['tar', 'czf', archive, 'package'], temp, { COPYFILE_DISABLE: '1' })).exitCode, 0)
  const bytes = await readFile(archive),
    sha = createHash('sha512').update(bytes).digest()
  const hex = sha.toString('hex'),
    cache = join(temp, '.npm', '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, bytes)
  await writeFile(
    join(repo, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/unit-fixture': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/unit-fixture/-/unit-fixture-1.0.0.tgz',
          integrity: 'sha512-' + sha.toString('base64')
        }
      }
    })
  )
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
  const sentinel = join(temp, 'outside-proof.txt')
  await writeFile(sentinel, 'unavailable to the test')
  await writeFile(
    join(repo, 'test', 'unit.mjs'),
    "import assert from 'node:assert/strict';import fs from 'node:fs';import value from 'unit-fixture';assert.equal(value,42);assert.throws(()=>fs.readFileSync(" +
      JSON.stringify(sentinel) +
      "));assert.throws(()=>fs.writeFileSync('package-lock.json','changed'));console.log('PASS verified offline fixture');\n"
  )
  await git('add', '.')
  await git('commit', '-m', 'pinned offline fixture')
  const commit = await git('rev-parse', 'HEAD')
  const developerDeps = join(repo, 'node_modules', 'unit-fixture')
  await mkdir(developerDeps, { recursive: true })
  await writeFile(join(developerDeps, 'index.js'), "throw Error('developer dependencies were read')\n")
  const before = await git('status', '--porcelain')
  const target = {
    proof: 123,
    repository: 'fixture/offline',
    worktree: repo,
    branch: 'main',
    commands: ['fixture'],
    delegated_focused_version: 1,
    dependency_wait_version: 1,
    commit
  }
  const reports = [],
    calls = [],
    waits = []
  let mismatchedRuntime = false,
    unrelatedReady = false
  let stagedAttempts = 0
  const $ = {
    clock: { now: async () => Date.now() },
    env: { get: async (name) => (name === 'HOME' ? temp : undefined) },
    cwd: async () => repo,
    process: {
      run: async (argv, opt) => {
        if (mismatchedRuntime && argv.includes('build') && argv.includes('-I')) {
          const destination = join(argv.at(-2), 'provenance.json')
          const supplied = JSON.parse(await readFile(destination, 'utf8'))
          supplied.runtime.node = '0.0.0'
          await writeFile(destination, JSON.stringify(supplied))
        }
        const res = await sys(argv, opt?.cwd || repo)
        if (argv.includes('-I') && argv.includes('stage')) stagedAttempts++
        if (res.exitCode && argv.includes('-I')) console.error('Native preparer:', res.stderr.slice(-900))
        return res
      }
    },
    mcp: {
      connect: async () => ({ isConnected: true, server: 'fixture' }),
      call: async (_s, name, args) => {
        assert.equal(name, 'claim_proof')
        calls.push(args)
        let value
        if (args.peek)
          value = { waiting: unrelatedReady ? [target, { ...target, proof: 125, dependency_wait: undefined }] : [target] }
        else if (args.dependency_wait) {
          target.dependency_wait = args.dependency_wait
          waits.push(args.dependency_wait)
          value = { proof: 123, waiting_for_dependencies: true }
        } else {
          assert.equal(args.dependency_wait_version, 1)
          value = {
            proof: args.proof,
            token: 'fixture',
            report_url: 'http://fixture.invalid/proof',
            expected_commit: commit,
            repository: { id: 1, full_name: target.repository },
            proof_scope: 'focused',
            recipe: { revision: 1, install: '', network: 'loopback' },
            steps: [
              {
                run: 124,
                name: 'fixture',
                line: 'node test/unit.mjs',
                timeout_seconds: 30,
                baseline: false,
                delegated_focused: true
              }
            ]
          }
        }
        return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
      }
    },
    http: {
      fetch: async (_url, req) => {
        reports.push(JSON.parse(req.body))
        return { ok: true, text: JSON.stringify({ data: true, status: 'passed', tests: 1 }) }
      }
    }
  }
  const invoke = (proof = 123, authorized) =>
    runProof($, {
      proof,
      authorized,
      known: [{ repository: target.repository, checkoutPath: repo }],
      hint: { worktree: repo, branch: 'main' }
    })
  const checkExpiredRoute = async () => {
    const before = stagedAttempts
    const previousCalls = calls.length
    const result = await invoke(123, async () => stagedAttempts === before)
    assert.ok(stagedAttempts > before)
    assert.equal(result.isRun, false)
    assert.match(result.text, /recovery route changed/)
    assert.deepEqual(calls.slice(previousCalls), [{ peek: true }])
  }
  await checkExpiredRoute()
  const happy = await invoke()
  assert.equal(happy.isRun, true, JSON.stringify(happy))
  assert.equal(reports[0]?.exit_code, 0, reports[0]?.output)
  assert.match(reports[0].output, /PASS verified offline fixture/)
  assert.equal(reports[0].commit, commit)
  assert.equal(reports[0].dirty, false)
  assert.match(reports[0].output, /Offline dependencies [a-f0-9]{64}; Node .+package-lock.json=[a-f0-9]{64}/)
  assert.equal(await git('status', '--porcelain'), before)
  console.log('PASS delegated proof runs with verified offline dependencies at the pinned commit')
  await rm(cache)
  await checkExpiredRoute()
  await invoke()
  await invoke()
  assert.equal(waits.length, 1)
  assert.equal(waits[0].code, 'missing')
  await writeFile(cache, 'mismatched bytes')
  await invoke()
  assert.equal(waits.at(-1).code, 'lock_mismatch')
  await writeFile(cache, bytes)
  mismatchedRuntime = true
  await invoke()
  assert.equal(waits.at(-1).code, 'runtime_mismatch')
  assert.equal(reports.length, 1)
  assert.equal(calls.filter((a) => !a.peek && !a.dependency_wait).length, 1)
  mismatchedRuntime = false
  unrelatedReady = true
  assert.equal((await invoke(null)).isRun, true)
  assert.equal(calls.at(-1).proof, 125)
  unrelatedReady = false
  await invoke()
  assert.equal(reports.length, 3)
  assert.equal(reports.at(-1).exit_code, 0)
  console.log('PASS delegated proof parks a missing or mismatched dependency bundle')
} finally {
  await rm(temp, { recursive: true, force: true })
}
