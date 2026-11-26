import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('MCP operator controls plugin guidance preserves approval boundaries', async () => {
  const reference = 'references/factory-tools.md';
  const skill = new URL('../skills/factory-manager/SKILL.md', import.meta.url);
  assert.ok((await readFile(skill, 'utf8')).includes(`(${reference})`));
  const guide = (await readFile(new URL(reference, skill), 'utf8')).split('## Operator decisions')[1];
  const section = label => guide.split(`- **${label}.**`)[1].split('\n- **')[0];
  const retry = section('Check again');
  const args = JSON.parse(retry.match(/`(\{".*?\})`/)[1]);
  assert.deepEqual(Object.keys(args).sort(), ['check', 'decision', 'factory', 'order']);
  assert.equal(args.decision, 'retry');
  assert.match(retry, /milestones\[\]\.check\.latest\.id/);
  assert.match(retry, /Refresh a stale attempt/);
  assert.match(section('Pass by hand'), /owner explicitly approves this attempt and their reason/);
  assert.match(section('Pass by hand'), /approved: true/);
  const settings = section('Proof settings');
  assert.match(settings, /preview_proof_definition[\s\S]+expected_revision[\s\S]+explicit owner approval[\s\S]+approve_proof_definition[\s\S]+preview_hash/);
  assert.match(settings, /focused checks require administrator access/);
  assert.match(settings, /saved_with_audit_error/);
  const close = section('Mark Done');
  assert.deepEqual(Object.keys(JSON.parse(close.match(/`(\{".*?\})`/)[1])).sort(), ['factory', 'order', 'status']);
  assert.match(close, /"status":"done"/);
  assert.match(close, /Coolify separately/);
  assert.match(guide, /tools\/list[\s\S]+older servers[\s\S]+website control/);
});
