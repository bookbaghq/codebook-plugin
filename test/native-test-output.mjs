import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeResultsToTap } from '../scripts/native-test-output.mjs'

test('native result transcription preserves observed names and outcomes', () => {
  const report = nativeResultsToTap('\u001b[32m(pass) owned story completion wakes continuation once [83.38ms]\u001b[0m\n(fail) failed assertion [1ms]\n(skip) unavailable case\n(todo) future case\n 1 pass\n 1 fail\nRan 4 tests across 1 file. [2.41s]')
  assert.equal(report.failed, 1)
  assert.equal(report.tap, 'TAP version 13\nok 1 - owned story completion wakes continuation once\nnot ok 2 - failed assertion\nok 3 - unavailable case # SKIP\nok 4 - future case # TODO\n1..4\n')
})

test('native result transcription refuses missing or inconsistent results', () => {
  for (const output of ['', 'Everything passed', ' 1 pass\n 0 fail\nRan 1 test across 1 file.', '(pass) one [1ms]\n 2 pass\n 0 fail\nRan 2 tests across 1 file.', '(pass) one [1ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file.']) {
    assert.ok(nativeResultsToTap(output).error)
    assert.equal(nativeResultsToTap(output).tap, undefined)
  }
})

test('native result transcription cannot turn a test name into a skip directive', () => {
  assert.match(nativeResultsToTap('(pass) literal # SKIP name [1ms]\n 1 pass\n 0 fail\nRan 1 test across 1 file.').tap, /literal \\# SKIP name/)
})
