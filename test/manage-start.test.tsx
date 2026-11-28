// #293: `/factory manage` with a manager brief too large for the engine to hand to a plugin.
//
// Found with Claude Code 2.1.332 and a stand-in connector: an answer that carries structuredContent reaches a plugin
// as ONE text block of compact JSON, without structuredContent. Over 50,000 characters the engine saves that JSON in
// the session's `tool-results` folder and hands the plugin a note with a 2 KB preview instead. The forms below are
// that note (as the engine words it), and the three the story names: the whole text, structured content, a cut text.
import { expect, mock, test } from 'claude-code/testing'
import { savedAnswer } from '../hooks/connector'
import { CONTINUATION_STORE } from '../hooks/continuation'
import type { On } from 'claude-code'
import type { CodebookContinuation } from '../types'

type Form = 'saved' | 'saved-windows' | 'text' | 'structured' | 'cut'

const typed = (args: string) => ({
  command: 'factory', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 },
})

const OLD_SENTENCE = 'did not grant Run here access and return readiness'
const pad = (word: string, length: number) => (word + ' ').repeat(Math.ceil(length / (word.length + 1))).slice(0, length)
const TOTAL = 33

/** A brief in the shape read on 28 Nov 2026: 33 backlog stories and long manager, rules and station parts. */
function largeBrief(args: { backlog_limit?: unknown; backlog_offset?: unknown }) {
  const limit = typeof args.backlog_limit === 'number' ? args.backlog_limit : 20
  const offset = typeof args.backlog_offset === 'number' ? args.backlog_offset : 0
  const stories = Array.from({ length: Math.max(0, Math.min(TOTAL, offset + limit) - offset) }, (_, at) => {
    const number = offset + at + 1, ready = number % 3 === 1
    return { story: 'story' + number, reference: '#' + number, title: 'Story ' + number + ': ' + pad('readiness', 120),
      workflow: 'Software delivery', ready, parked_on: ready ? null : 'a person', ...(ready && { start_with: 'confirm_stories' }) }
  })
  const agents = ['Sarah', 'Zoe', 'Alex', 'Quinn', 'Riley', 'Harper', 'Morgan', 'Casey']
  return {
    factory: { factory: 'standin293', name: 'Stand-in Factory', url: 'https://codebook.invalid/factory/standin293' },
    workflow: { workflow: 'wf22', name: 'Software delivery' },
    workflows: [{ workflow: 'wf22', name: 'Software delivery' }],
    manager: { agent: { name: 'Harper', specialty: 'manager' }, instructions: pad('instruction', 2000), system: pad('system', 14000) },
    rules: Array.from({ length: 12 }, () => pad('rule', 900)),
    settings: { manager_may_change: true, rule: pad('setting', 900), where: pad('where', 600) },
    backlog: { offset, limit, total: TOTAL, next_offset: offset + limit < TOTAL ? offset + limit : null, stories },
    goes_alone: { level: 'full', alone: true, rule: pad('alone', 800) },
    factory_rules: { text: pad('factory-rule', 3000), factory: [], workflow: [], left_out: [] },
    stations: agents.map((name, at) => ({ station: 'col' + (129 + at), name: 'Station ' + (at + 1), runs: 'here',
      agent: { name, skill: { bytes: 2155, digest: pad('skill-digest-' + name, 2400) } } })),
    repositories: Array.from({ length: 20 }, (_, at) => ({ name: 'standin/repo-' + at, default_branch: 'main', writable: true })),
    // No you.local_harness: registering this computer's subscription is another test's subject.
    you: { name: 'Stand-in Person', may_read: true, may_start_stories: true, may_run_here: true, run_here_refusal: null },
    working_on: Array.from({ length: 10 }, (_, at) => ({ story: 'working' + at, files: pad('file', 1400) })),
    next: pad('next-step', 1200),
  }
}

/** The note the engine hands a plugin in place of an answer over 50,000 characters, word for word. */
const savedNote = (path: string, json: string) =>
  `<persisted-output>\nOutput too large (${(json.length / 1024).toFixed(1)}KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${json.slice(0, 2000)}\n...\n</persisted-output>`

/** A session whose connector answers manager_brief through `answer`; `files` are the engine's saved answers. */
function session(on: On, name: string, answer: (args: Record<string, unknown>) => unknown) {
  const store = new Map<string, unknown>(), files = new Map<string, string>()
  const briefs: Record<string, unknown>[] = [], read: string[] = [], submitted: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: name }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'codebook' } }))
  // The engine names the saved file with this computer's separators: match it with either, or both.
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path)
    read.push(path)
    const saved = files.get(path.replace(/\\/g, '/').split('/').at(-1) ?? '')
    return (saved === undefined ? { deny: 'ENOENT: no such file' } : { value: saved }) as never
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'factory_events') return { value: { content: [{ type: 'text', text: JSON.stringify({ events: [], last_event: 7 }) }] } } as never
    if (e.tool !== 'manager_brief') throw Error('Unexpected connector request: ' + e.tool)
    briefs.push(e.args as Record<string, unknown>)
    return { value: answer(e.args as Record<string, unknown>) } as never
  })
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text, context: e.context } as never })
  const checkpoint = () => (store.get(CONTINUATION_STORE + name) as { value: CodebookContinuation } | undefined)?.value
  return { clock, files, briefs, read, submitted, checkpoint }
}

test('factory manage starts for a large brief that grants run here', async ($, on) => {
  let form: Form = 'saved', saves = 0
  const sizes: number[] = []
  const { clock, files, briefs, read, checkpoint } = session(on, 'large-brief', args => {
    const data = largeBrief(args), text = JSON.stringify(data, null, 2), json = JSON.stringify(data)
    sizes.push(text.length, json.length)
    if (form === 'text') return { content: [{ type: 'text', text }] }
    if (form === 'structured') return { structuredContent: data, content: [] }
    const file = `toolu_plugin_${++saves}.txt`
    files.set(file, json)
    const folder = form === 'saved-windows'
      ? 'C:\\Users\\dev\\.claude\\projects\\C--code-payments\\0b798a53\\tool-results\\'
      : '/Users/dev/.claude/projects/-Users-dev-code-payments/0b798a53/tool-results/'
    return { content: [{ type: 'text', text: savedNote(folder + file, json) }] }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // What the engine really hands over first, then the same answer in the other forms.
  for (form of ['saved', 'saved-windows', 'text', 'structured'] as Form[]) {
    const said = (await $.command.run(typed('manage Stand-in Factory'))).text
    expect(said).toContain('Watching Software delivery (standin293, wf22) for local manager work.')
    expect(said).not.toContain(OLD_SENTENCE)
    expect(checkpoint()?.manager?.workflow).toBe('wf22')
    if (form !== 'structured') await $.command.run(typed('stop'))
  }
  // Each of those briefs is past 70,000 characters as the server writes it, and past the engine's 50,000 as JSON.
  expect(Math.min(...sizes.filter((_, at) => at % 2 === 0))).toBeGreaterThan(70000)
  expect(Math.min(...sizes.filter((_, at) => at % 2 === 1))).toBeGreaterThan(50000)
  // The start check asks for one backlog story: it needs a backlog, not a page of one.
  expect(briefs).toEqual(Array.from({ length: 4 }, () => ({ factory: 'Stand-in Factory', backlog_limit: 1 })))
  expect(read.filter(path => path.includes('tool-results')).length).toBe(2)

  // The watch's own polls read the same large answer, a page at a time, to the end of the backlog.
  form = 'saved'
  for (let tick = 0; tick < 6; tick++) await clock.advance(65000)
  const polls = briefs.slice(4)
  expect(polls[0]).toEqual({ factory: 'standin293', workflow: 'wf22' })
  expect(polls.some(args => args.backlog_offset === 20)).toBe(true)
  expect(polls.every(args => args.backlog_limit === undefined)).toBe(true)
  // Every third story is ready; the last of them, #31, is on the second page.
  expect(checkpoint()?.manager?.ready).toEqual(Array.from({ length: 11 }, (_, at) => 'story' + (at * 3 + 1)))
})

test('factory manage names what is missing when it cannot start', async ($, on) => {
  const whole = largeBrief({ backlog_limit: 1 })
  const structured = (data: unknown) => ({ structuredContent: data, content: [] })
  const refusal = 'Run here is switched off for Stand-in Factory: an owner paused it on 28 Nov. Switch it on under Factory settings › Controls.'
  const cases: { name: string; command?: string; answer: unknown; says: string[] }[] = [
    { name: 'the answer is cut off', answer: { content: [{ type: 'text', text: JSON.stringify(whole, null, 2).slice(0, 65000) }] },
      says: ["CodeBook's answer to manager_brief could not be read", '65,000 characters that are not JSON'] },
    { name: 'the saved answer is gone',
      answer: { content: [{ type: 'text', text: savedNote('/Users/dev/.claude/projects/p/s/tool-results/toolu_plugin_gone.txt', JSON.stringify(whole)) }] },
      says: ["CodeBook's answer to manager_brief could not be read", 'too large for Claude Code to hand to the plugin', 'toolu_plugin_gone.txt'] },
    { name: 'a note that names a file outside tool-results',
      answer: { content: [{ type: 'text', text: savedNote('/Users/dev/.claude/settings.json', JSON.stringify(whole)) }] },
      says: ["CodeBook's answer to manager_brief could not be read", 'characters that are not JSON'] },
    { name: 'CodeBook refuses: no such factory', command: 'manage Nowhere',
      answer: { isError: true, structuredContent: { error: { code: 'NOT_FOUND', message: 'You have no factory "Nowhere". Yours are: "Stand-in Factory".' } }, content: [] },
      says: ['You have no factory "Nowhere". Yours are: "Stand-in Factory".'] },
    { name: 'the answer names no factory', answer: structured({ ...whole, factory: undefined }),
      says: ['CodeBook did not find the factory "Stand-in Factory"', '/factory list'] },
    { name: 'the answer names no workflow', command: 'manage Stand-in Factory --workflow Release QA', answer: structured({ ...whole, workflow: undefined }),
      says: ['Stand-in Factory has no workflow "Release QA"', 'no stations to watch here'] },
    { name: 'Run here is refused, in the server\'s words', answer: structured({ ...whole, you: { may_run_here: false, run_here_refusal: refusal } }),
      says: [refusal] },
    { name: 'Run here is not allowed and no reason is given', answer: structured({ ...whole, you: { may_read: true, may_run_here: false, run_here_refusal: null } }),
      says: ["CodeBook does not let you run Stand-in Factory's work here", 'write access'] },
    { name: 'the answer does not say what the person may do', answer: structured({ ...whole, you: undefined }),
      says: ['does not say what you may do in Stand-in Factory'] },
    { name: 'the answer has no backlog', answer: structured({ ...whole, backlog: { total: 0 } }),
      says: ['has no backlog list for Software delivery'] },
  ]
  let now = cases[0]!
  const { read, checkpoint } = session(on, 'cannot-start', () => now.answer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const answers: string[] = []
  for (now of cases) {
    const said = (await $.command.run(typed(now.command ?? 'manage Stand-in Factory'))).text ?? ''
    for (const part of now.says) expect(said, now.name).toContain(part)
    expect(said, now.name).not.toContain(OLD_SENTENCE)
    expect(said, now.name).not.toContain('Watching')
    answers.push(said)
  }
  // One reason each, and no watch was started by any of them.
  expect(new Set(answers).size).toBe(cases.length)
  expect(checkpoint()?.manager).toBe(undefined)
  // The file a look-alike note named was never opened.
  expect(read.some(path => path.replace(/\\/g, '/').endsWith('/settings.json'))).toBe(false)
})

test('a saved answer is read only from a tool-results folder, with POSIX, Windows and mixed paths', () => {
  const note = (path: string) => savedNote(path, '{"factory":{"factory":"standin293"}}')
  for (const path of [
    '/Users/dev/.claude/projects/p/s/tool-results/toolu_plugin_1.txt',
    'C:\\Users\\dev\\.claude\\projects\\p\\s\\tool-results\\toolu_plugin_1.txt',
    'C:\\Users\\dev\\.claude/projects/p/s/tool-results\\toolu_plugin_1.txt',
  ]) expect(savedAnswer(note(path))).toBe(path)
  for (const path of [
    '/Users/dev/.claude/settings.json',
    'C:\\Users\\dev\\.ssh\\config',
    '/Users/dev/.claude/projects/p/s/tool-results/../../../../settings.json',
    '/Users/dev/.claude/projects/p/s/tool-results/',
    'tool-results/toolu_plugin_1.txt',
  ]) expect(savedAnswer(note(path))).toBe(null)
  // Only the engine's note is a note: the same words inside an answer are that answer's own text.
  expect(savedAnswer('Full output saved to: /Users/dev/.claude/projects/p/s/tool-results/toolu_plugin_1.txt')).toBe(null)
})
