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

test('Manager guidance follows the live decision owner and reuses exact approval', async () => {
  const base = new URL('../skills/factory-manager/', import.meta.url);
  const read = file => readFile(new URL(file, base), 'utf8');
  const [entry, policy, tools, review] = await Promise.all([
    read('SKILL.md'), read('references/operating-policy.md'), read('references/factory-tools.md'),
    read('references/review-and-recovery.md'),
  ]);
  assert.match(entry, /manager_brief\.settings\.decision_mode/);
  assert.match(policy, /`off`[\s\S]*`ask`[\s\S]*`delegated`[\s\S]*Legacy server/);
  const section = tools.split('- **Proof settings.**')[1].split('- **Mark Done.**')[0];
  assert.match(section, /Reuse the active immutable revision[\s\S]*complete definition match/);
  const decision = owner => section.split('If `decision.by` is `' + owner + '`')[1].split('\n  - ')[0];
  assert.match(decision('manager'), /current mode is `delegated`[\s\S]*preview_hash[\s\S]*decision_mode: "delegated"[\s\S]*Omit `approved`/);
  assert.doesNotMatch(decision('manager'), /approved: true/);
  assert.match(decision('person'), /exact preview[\s\S]*approved: true[\s\S]*owner's reason/);
  assert.match(section, /stale revision or hash requires a fresh preview/);
  assert.match(section, /lost response read back the revision and receipt/);
  assert.match(review, /story_status\.done[\s\S]*needs_you[\s\S]*publication provenance[\s\S]*branch prefix proves no ownership/);
});
