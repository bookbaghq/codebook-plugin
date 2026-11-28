import { expect, test } from 'claude-code/testing'

test('Claude attaches proposal routing to the real tool reply and preserves a pause conflict', async ($, on) => {
  const grant = { decision_owner: 'manager', next_action: 'wait_for_resume', may_confirm_yourself: false, factory_paused: true }
  const proposal = { proposal: { proposal: 'wo7' }, stories: [{ title: 'Export', criteria: [{ text: 'Export opens' }] }] }
  let payload: object = { ...proposal, goes_alone: grant }
  let refused = false
  on('tool.call', () => ({ result: { structuredContent: payload }, text: JSON.stringify(payload), isError: refused }))
  const call = (tool: string) => $.tool.call({ tool: 'mcp__plugin_codebook_codebook__' + tool } as never)

  const held = await call('propose_stories')
  expect(held.context?.[0]).toContain('after it resumes')
  expect(held.context?.[0]).not.toMatch(/proceed|confirm_stories/i)
  refused = true
  payload = { error: { code: 'CONFLICT', goes_alone: grant } }
  const raced = await call('confirm_stories')
  expect(raced.isError).toBe(true)
  expect(raced.context).toEqual(held.context)

  refused = false
  payload = { ...proposal, goes_alone: { next_action: 'ask_person', decision_owner: 'person', may_confirm_yourself: true } }
  expect((await call('propose_stories')).context?.[0]).toContain('wait for the person’s yes')
  payload = { ...proposal, goes_alone: { next_action: 'confirm', decision_owner: 'manager' } }
  expect((await call('propose_stories')).context?.[0]).toContain('decided_by: "manager"')
})
