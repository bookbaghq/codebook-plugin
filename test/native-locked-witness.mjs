// Run against a clean, explicitly selected candidate that implements the locked-dependency protocol.
// This rehearsal uses real sibling OS sandboxes and disposable fixture control. It has no CodeBook credentials.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { lockedWitnessDriver, lockedWitnessFixture } from '../hooks/locked-witness-fixture.ts'

const [directory, commit] = process.argv.slice(2)
if (!directory || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? '')) {
  throw new Error('Usage: node test/native-locked-witness.mjs <clean candidate checkout> <full Git SHA>')
}
const checkout = realpathSync(directory)
const observe = (sha, operation) => spawnSync('/usr/bin/python3',
  ['-I', '-S', '-c', lockedWitnessFixture, checkout, sha, process.platform, '120', operation],
  {cwd:'/', timeout:120000, encoding:'utf8', maxBuffer:8192})
const probe = observe(commit, 'probe')
assert.equal(probe.status, 0, 'This host needs a compatible native sandbox, Python 3, Git and Node with TypeScript stripping.')
const result = observe(commit, lockedWitnessDriver)
assert.equal(result.status, 0, result.stdout)
assert.deepEqual(JSON.parse(result.stdout), {verified_offline_dependency:'passed',parked_dependency_proof:'passed'})
console.log('PASS native dependency fixture observed at '+commit+' on '+process.platform)
const different = (commit[0] === '0' ? '1' : '0') + commit.slice(1)
const refused = observe(different, lockedWitnessDriver)
assert.notEqual(refused.status, 0)
assert.equal(Object.hasOwn(JSON.parse(refused.stdout),'verified_offline_dependency'),false)
console.log('PASS a different source commit has no native observations')
