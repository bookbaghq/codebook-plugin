import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { splitRun } from '../hooks/factory'

// A story in the "Payments" factory: Plan passed, Build waits for this person's runner, Review is a person (you).
const BOARD = {
  factory: 'k3Vb9QmZ',
  name: 'Payments',
  url: 'https://app.codebook.work/workspace/ws1/factory/k3Vb9QmZ',
  workflow: { workflow: 'wf12', name: 'Delivery' },
  stations: [
    { station: 'col40', name: 'Plan', ends_work: null, worker: { type: 'agent', name: 'Planner' } },
    { station: 'col41', name: 'Build', ends_work: null, worker: { type: 'agent', name: 'Builder' } },
    { station: 'col42', name: 'Review', ends_work: null, worker: { type: 'person', name: 'Tom', person: { name: 'Tom', is_you: true } } },
    { station: 'col43', name: 'Done', ends_work: 'done', worker: { type: 'none' } },
  ],
}

type At = 'build' | 'claimed' | 'review' | 'done' | 'asks' | 'escalated'
const ASKED = 'Refund to the card, or as store credit?'
/** A CodeBook from before §12.10: person stations carry no on_approve. */
const older = { codebook: false }
const MERGES = 'Approving moves the story to Done, and CodeBook then merges pull request #212 — the commit you approve, once its checks pass.'

const LEFT = 'pull request #212 (a draft) is still open, and CodeBook will not merge it: no person approved a commit, because every station of this workflow is an agent\'s. Ask the person to review and merge it at the repository host.'

function status(at: At): Record<string, unknown> {
  // An agent asked for a person mid-run (request_person): the run waits on this person with the question's text.
  if (at === 'asks') return {
    ...status('build'),
    run: { run: 811, state: 'waiting_for_person', where: 'here' },
    waiting: { on: 'person', run: 811, on_you: true, question: ASKED, tools: ['answer_question', 'approve_station', 'send_back'] },
  }
  // The manager asked the person (ask_person, an escalation): the story carries the question.
  if (at === 'escalated') return {
    ...status('build'),
    question: { text: 'Which payment providers are in scope?', choices: ['Stripe only', 'Stripe and PayPal'], on_you: true },
  }
  if (at === 'done') return {
    ...status('review'),
    station: { station: 'col43', name: 'Done' },
    finished: 'done',
    run: null,
    waiting: null,
    done: { needs_person: true, pull_requests: [{ number: 212, draft: true, outcome: 'left_for_person', needs_person: true }], sentence: LEFT },
    events: [{ id: 9005, kind: 'card.finished', occurred_at: '2026-11-01T10:09:00Z', station: 'Done' }],
    last_event: 9005,
  }
  const isBuild = at !== 'review'
  return {
    story: { story: '6KjN', reference: '#57', title: 'Let customers refund a payment' },
    factory: { factory: 'k3Vb9QmZ', name: 'Payments' },
    workflow: { workflow: 'wf12', name: 'Delivery' },
    station: isBuild ? { station: 'col41', name: 'Build' } : { station: 'col42', name: 'Review' },
    in_backlog: false,
    finished: null,
    run: isBuild ? { run: 811, state: 'with_outside_agent', where: 'here' } : { run: 812, state: 'waiting_for_person' },
    run_location: {
      where: 'here',
      person: { name: 'Tom', is_you: true },
      changeable: at !== 'claimed',
      stations: [
        { station: 'col40', name: 'Plan', runs: 'here' },
        { station: 'col41', name: 'Build', runs: 'here' },
        { station: 'col42', name: 'Review', runs: 'person' },
      ],
    },
    waiting: isBuild
      ? {
          on: 'runner',
          run: 811,
          on_you: true,
          claimed: at === 'claimed',
          claimed_by_you: at === 'claimed',
          lease: at === 'claimed' ? { fence: 3, expires_at: '2026-11-01T10:15:00Z', expired: false } : null,
          tools: ['claim_work', 'heartbeat_work', 'complete_work'],
        }
      : {
          on: 'person',
          run: 812,
          on_you: true,
          pull_requests: [{ pull_request_id: 5, number: 212, head_sha: 'abc', html_url: 'https://github.com/acme/payments/pull/212' }],
          ...(older.codebook ? {} : { on_approve: { merge: 'now', by: 'codebook', sentence: MERGES } }),
          tools: ['approve_station', 'send_back'],
        },
    stations: [
      { station: 'col40', name: 'Plan', run: 810, state: 'passed', summary: 'Six steps, written on the card.' },
      ...(isBuild ? [] : [{ station: 'col41', name: 'Build', run: 811, state: 'passed', summary: 'Draft pull request #212 is open.' }]),
    ],
    events: isBuild
      ? [{ id: 9001, kind: 'run.passed', occurred_at: '2026-11-01T10:00:00Z', station: 'Plan', subject: null }]
      : [
          { id: 9001.5, kind: 'agent.assigned', occurred_at: '2026-11-01T10:00:30Z', station: 'Build', card: null, where: null, who: { agent: { name: 'Alex', role: 'Developer' }, person: null, via: null } },
          { id: 9002, kind: 'agent.assigned', occurred_at: '2026-11-01T10:01:00Z', station: 'Build', card: { key: '6KjN', reference: 57 }, where: 'here', who: { agent: { name: 'Alex', role: 'Developer' }, person: { name: 'Tom', is_you: true }, via: 'Claude Code' } },
          { id: 9003, kind: 'pr.linked', occurred_at: '2026-11-01T10:05:00Z', station: 'Build', subject: 'acme/payments#212 — Refunds', where: 'here' },
          { id: 9004, kind: 'card.moved', occurred_at: '2026-11-01T10:06:00Z', station: 'Build', to_station: 'Review' },
        ],
    last_event: isBuild ? 9001 : 9004,
    url: 'https://app.codebook.work/workspace/ws1/factory/k3Vb9QmZ?card=6KjN',
  }
}

/** The command as the person types it at the prompt. */
function typed(args: string) {
  return {
    command: 'factory',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 160 },
  }
}

const TRAIL = {
  story: { story: '6KjN', reference: '#57', title: 'Let customers refund a payment' },
  comments: [{ id: 1, author: 'Alex (Developer) via Tom’s Claude Code', by: 'agent', text: 'Starting: refunds from the order page.\nMore.', at: '2026-11-01T10:02:00Z' }],
  runs: [],
  artifacts: [{ id: 3, kind: 'test_report', title: 'Tests' }],
  pull_requests: [{ number: 212, title: 'Refunds', state: 'open', repository: 'acme/payments', url: 'https://github.com/acme/payments/pull/212' }],
}

type Calls = { tool: string; args: Record<string, unknown> }[]

/** #58, the second story a confirm_stories created: at Build, or waiting on this person with a question. */
function status58(asks: boolean): Record<string, unknown> {
  const s = status('build')
  return {
    ...s,
    story: { story: '7LmP', reference: '#58', title: 'Refund email' },
    events: [],
    last_event: null,
    ...(asks
      ? { run: { run: 821, state: 'waiting_for_person', where: 'here' }, waiting: { on: 'person', run: 821, on_you: true, question: 'Send the refund email from billing@ or support@?' } }
      : { run: { run: 821, state: 'with_outside_agent', where: 'here' }, waiting: { on: 'runner', run: 821, on_you: true, claimed: false } }),
  }
}

/** The engine beneath the plugin: a connected codebook server answering from the fixtures above. */
function engine(on: On, at: { now: At; asks58?: boolean; session?: string; stored?: Record<string, unknown> }) {
  const calls: Calls = []
  const prompts: string[] = []
  const filled: string[] = []
  const logged: string[] = []
  // $.store in memory, as mock.store keeps it, recording what is removed.
  const kept = new Map<string, unknown>(Object.entries(at.stored ?? {}))
  const deleted: string[] = []
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    deleted.push(e.key)
    kept.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: at.session ?? 'session-a' }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:codebook:codebook' } }))
  // The model's own calls of the connector (what the person sends after the pane offers it) answer the same way.
  on('tool.call', (_, e) => {
    const tool = String(e.tool).replace('mcp__plugin_codebook_codebook__', '')
    const { tool: _name, tool_use_id: _id, ...args } = e as Record<string, unknown>
    calls.push({ tool, args })
    const data = answer(tool, args)
    return { result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }, text: JSON.stringify(data) }
  })
  function answer(tool: string, args: Record<string, unknown>) {
    return tool === 'start_story'
        ? {
            story: { story: '6KjN', reference: '#57', title: String(args.title) },
            factory: { factory: 'k3Vb9QmZ', name: 'Payments' },
            workflow: { workflow: 'wf12', name: 'Delivery' },
            station: { station: 'col40', name: 'Plan' },
            run: { run: 810, state: 'queued' },
            url: 'https://app.codebook.work/workspace/ws1/factory/k3Vb9QmZ?card=6KjN',
          }
        : tool === 'factory_board'
          ? BOARD
          : tool === 'story_status'
            ? args.story === '7LmP'
              ? status58(at.asks58 === true)
              : status(at.now)
            : tool === 'approve_station'
              ? { decided: 'approved', run: 812, next: 'Review approved; the story moves on.' }
              : tool === 'list_factories'
                ? { factories: [{ factory: 'k3Vb9QmZ', name: 'Payments', workspace: { name: 'Claims' }, may_start_stories: true }], total: 1 }
                : tool === 'set_run_location'
                  ? { next: "The story's agent stations now run in CodeBook." }
                  : tool === 'story_trail'
                    ? TRAIL
                    : tool === 'confirm_stories'
                      ? { proposal: { proposal: 'wo7', reference: 'WO-7', status: 'open' }, created: [{ item: 41, story: '6KjN', reference: '#57', title: 'Let customers refund a payment' }, { item: 42, story: '7LmP', reference: '#58', title: 'Refund email' }], skipped: [], waiting: [] }
                      : { error: { code: 'NOT_FOUND', message: 'no such tool here' } }
  }
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const data = answer(e.tool, e.args)
    const isError = typeof data === 'object' && data !== null && 'error' in data
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } }
  })
  return { calls, prompts, filled, logged, clock, deleted }
}

/** What the person does with the request the pane offered: sends it, and Claude starts the story. */
async function claudeStarts($: Engine, where: 'here' | 'cloud' = 'here') {
  await $.tool.call({
    tool: 'mcp__plugin_codebook_codebook__start_story',
    factory: 'Payments',
    title: 'Let customers refund a payment',
    run_location: where,
  } as never)
}

const PANE = {
  plugin: 'codebook',
  component: 'Pane',
  requestId: 'codebook-factory',
  props: {
    title: 'Factory',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('/factory run offers the start request; once Claude starts it, the pane draws its stations', async ($, on) => {
  const { calls, filled } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(typed('run Payments "Let customers refund a payment"'))
  expect(ran.text).toContain('press Enter')
  // The plugin writes nothing itself: the request waits in the person's prompt box.
  expect(calls.find(one => one.tool === 'start_story')).toBeUndefined()
  expect(filled[0]).toContain('codebook:factory-manager')
  expect(filled[0]).toContain('"Payments": Let customers refund a payment')

  await claudeStarts($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /PAYMENTS FACTORY · #57/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Plan$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ready to run here/ })).toBeDefined()
    // The Done column ends work: it is not a station card.
    expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the plugin itself sends nothing while it follows a story: the manager session runs the stations', async ($, on) => {
  const { prompts, calls, clock } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(prompts.length).toBe(0)
  // Only reads went to CodeBook from the plugin.
  expect(calls.every(one => ['factory_board', 'story_status', 'story_trail', 'start_story'].includes(one.tool))).toBe(true)
})

test('Work it here offers the worker request for a station waiting here', async ($, on) => {
  const { filled } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'work-here' })
  expect(filled.at(-1)).toContain('codebook:factory-worker')
  expect(filled.at(-1)).toContain('run 811')
  await ui.unmount()
})

test('a cloud story is offered with run_location cloud', async ($, on) => {
  const { filled } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('cloud'))
  await $.command.run(typed('run Payments "Let customers refund a payment"'))
  expect(filled[0]).toContain('run_location "cloud"')
})

test('a story typed in the pane is offered, not started', async ($, on) => {
  const { calls, filled } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'load' })
  await ui.press({ key: 'pick-k3Vb9QmZ' })
  await ui.input({ key: 'title', text: 'Add a discount' })
  expect(filled[0]).toContain('codebook:factory-manager')
  expect(filled[0]).toContain('Add a discount')
  expect(calls.find(one => one.tool === 'start_story')).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /press Enter/ })).toBeDefined()
  await ui.unmount()
})

test('Run in CodeBook moves the followed story', async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { filled } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-cloud' })
  expect(filled.at(-1)).toContain('story id 6KjN')
  expect(filled.at(-1)).toContain('set_run_location "cloud"')
  await ui.unmount()
})

test("Approve in the pane shows CodeBook's merge sentence and offers the approval with the pull request heads", async ($, on) => {
  const { filled } = engine(on, { now: 'review' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CodeBook then merges pull request #212/ })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(filled.at(-1)).toContain('Approve the Review station')
  expect(filled.at(-1)).toContain('[{"pull_request_id":5,"head_sha":"abc"}]')
  expect(filled.at(-1)).toContain(`CodeBook says: ${MERGES}`)
  await ui.unmount()
})

test('without CodeBook\'s merge sentence, Approve still warns it may merge', async ($, on) => {
  older.codebook = true
  try {
    const { filled } = engine(on, { now: 'review' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await claudeStarts($)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Approving may merge the pull request/ })).toBeDefined()
    await ui.press({ key: 'approve' })
    expect(filled.at(-1)).toContain('may merge the pull request')
    await ui.unmount()
  } finally {
    older.codebook = false
  }
})

test('a missing sign-in says how to sign in', async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'auth', message: 'needs sign-in' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(typed(''))
  expect(ran.text).toContain('/mcp')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Sign in to CodeBook/ })).toBeDefined()
  await ui.unmount()
})

test('/factory run without a title explains itself', async ($, on) => {
  engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run(typed('run Payments'))
  expect(ran.text).toContain('Usage: /factory run')
})

test('/factory list names the factories', async ($, on) => {
  engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run(typed('list'))
  expect(ran.text).toBe('Payments (Claims)')
})

test("the model's own calls of the connector are left to the person's permission settings", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: 'the mode decides' }))
  const verdict = await $.tool.check({ tool: 'mcp__plugin_codebook_codebook__start_story', input: { factory: 'Payments' } })
  expect(verdict.decision).toBe('ask')
})

test('the run choice shows which is chosen and switches on Choose', async ($, on) => {
  engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Run here is the default: only Run in CodeBook offers Choose.
  expect(await ui.find({ key: 'run-here' })).toBeUndefined()
  await ui.press({ key: 'run-cloud' })
  expect(await ui.find({ key: 'run-cloud' })).toBeUndefined()
  expect(await ui.find({ key: 'run-here' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /run in CodeBook's cloud/ })).toBeDefined()
  await ui.unmount()
})

test('new events of the followed story become lines in the chat, and the pane shows the card', async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { logged, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  // The first look fills the pane only.
  expect(logged.length).toBe(0)
  at.now = 'review'
  await clock.advance(5000)
  expect(logged).toEqual([
    'CodeBook: Alex (Developer) is working #57 at Build, here.',
    'CodeBook: Pull request acme/payments#212 — Refunds linked to #57.',
    'CodeBook: ▸ #57 moved to Review.',
  ])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /ON THE CARD/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Starting: refunds from the order page\.$/ })).toBeDefined()
  await ui.unmount()
})

test('a story done with a pull request nobody will merge says so in the chat and the pane', async ($, on) => {
  const at: { now: At } = { now: 'review' }
  const { logged, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  at.now = 'done'
  await clock.advance(5000)
  expect(logged).toEqual(['CodeBook: #57 is done.', `CodeBook: #57 is done, but ${LEFT}`])
  await clock.advance(5000)
  expect(logged.length).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Now: Done, but pull request #212 \(a draft\) is still open/ })).toBeDefined()
  await ui.unmount()
})

test('confirming stories follows every story created: the pane shows the first, and a question on another wakes the session', async ($, on) => {
  const at: { now: At; asks58?: boolean } = { now: 'build' }
  const { prompts, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__confirm_stories', proposal: 'wo7', run_location: 'here' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PAYMENTS FACTORY · #57/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /also following #58/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#58 Refund email$/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(5000)
  expect(prompts.length).toBe(0)
  // Only #58 starts waiting on this person (found live: only created[0] ever woke the session).
  at.asks58 = true
  await clock.advance(5000)
  expect(prompts).toEqual([
    'CodeBook: #58 has a question for you at Build: "Send the refund email from billing@ or support@?". Use the codebook:factory-manager skill: ask me this here, with its likely answers, then call answer_question with my words. Never call approve_station in place of an answer.',
  ])
  await clock.advance(5000)
  expect(prompts.length).toBe(1)
})

test('an agent\'s request_person wakes the session with the question\'s text, once, and the pane offers Answer', async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { prompts, logged, filled, calls, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  at.now = 'asks'
  await clock.advance(5000)
  expect(prompts).toEqual([
    `CodeBook: #57 has a question for you at Build: "${ASKED}". Use the codebook:factory-manager skill: ask me this here, with its likely answers, then call answer_question with my words. Never call approve_station in place of an answer.`,
  ])
  expect(logged).toContain(`CodeBook: #57 asks you: "${ASKED}"`)
  await clock.advance(5000)
  expect(prompts.length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: ASKED })).toBeDefined()
  await ui.press({ key: 'answer' })
  expect(filled.at(-1)).toBe('Answer #57: ')
  await ui.unmount()
  // The plugin never answers, approves or sends back by itself.
  expect(calls.find(one => ['answer_question', 'approve_station', 'send_back'].includes(one.tool))).toBeUndefined()
})

test("a manager's question (ask_person, an escalation) wakes the session with its text and likely answers", async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { prompts, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  at.now = 'escalated'
  await clock.advance(5000)
  expect(prompts).toEqual([
    'CodeBook: #57 has a question for you at Build: "Which payment providers are in scope?" (likely answers: Stripe only / Stripe and PayPal). Use the codebook:factory-manager skill: ask me this here, with its likely answers, then call answer_question with my words. Never call approve_station in place of an answer.',
  ])
})

test("auto mode's refusal of the pane's own read says which calls to allow", async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:codebook:codebook' } }))
  // As the engine refused it live (2 Nov 2026): the call rejects with the classifier's reason.
  on('mcp.call', () => ({
    deny: 'Permission to use mcp__plugin_codebook_codebook__list_factories has been refused: The server-side auto mode classifier gave no verdict for mcp__plugin_codebook_codebook__list_factories: the request that produced this action did not ask for one.',
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(typed('list'))
  expect(ran.text).toContain('Auto mode refused')
  for (const tool of ['list_factories', 'story_status', 'story_trail']) {
    expect(ran.text).toContain(`mcp__plugin_codebook_codebook__${tool}`)
  }
  expect(ran.text).not.toContain('classifier gave no verdict')
})

test('the chosen run keeps its label whole in a narrow pane', async ($, on) => {
  engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  expect(await ui.find({ type: 'Text', text: ' ✓ Chosen ' })).toBeDefined()
  await ui.unmount()
})

test("/factory run never takes a request's first word for a factory (found live: \"we have too many branches\" ran in factory \"we\")", async ($, on) => {
  const { filled } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Payments is the only factory: the whole text is the request.
  const ran = await $.command.run(typed('run we have too many branches'))
  expect(ran.text).toContain('press Enter')
  expect(filled[0]).toContain('the CodeBook factory "Payments": we have too many branches')
})

test('the factory is read from the leading words that name one, in any case, quoted or not', () => {
  const names = ['Vibeforce', 'Bug fix factory', 'Feature factory']
  expect(splitRun(['bug', 'fix', 'factory', 'fix', 'the', 'login'], names, null)).toEqual({ factory: 'Bug fix factory', title: 'fix the login' })
  expect(splitRun(['Bug fix factory', 'fix the login'], names, null)).toEqual({ factory: 'Bug fix factory', title: 'fix the login' })
  expect(splitRun(['vibeforce', 'tidy', 'branches'], names, null)).toEqual({ factory: 'Vibeforce', title: 'tidy branches' })
  // No name leads: the pane's pick, else nothing (the command asks which factory).
  expect(splitRun(['we', 'have', 'too', 'many'], names, 'Vibeforce')).toEqual({ factory: 'Vibeforce', title: 'we have too many' })
  expect(splitRun(['we', 'have', 'too', 'many'], names, null)).toBeNull()
})

test('a station that starts waiting on this person wakes the session to ask, once per run (found live: 81 minutes at Human review, nobody asked)', async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { prompts, calls, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  await clock.advance(5000)
  expect(prompts.length).toBe(0)
  at.now = 'review'
  await clock.advance(5000)
  expect(prompts).toEqual([
    'CodeBook: #57 is waiting for your approval at Review. Use the codebook:factory-manager skill: show me what to look at (what was done, QA\'s verdict, the pull request) and what approving does, then ask me to approve or send it back. Call approve_station or send_back only after I answer.',
  ])
  await clock.advance(5000)
  await clock.advance(5000)
  expect(prompts.length).toBe(1)
  // Asking is not deciding: the plugin itself never approves.
  expect(calls.find(one => one.tool === 'approve_station' || one.tool === 'send_back')).toBeUndefined()
})

const FOLLOWED = { story: 'st_57', factory: 'f_1', factoryName: 'Payments', workflow: null, reference: '#57', title: 'Let customers refund a payment', url: null }

test('a new session follows nothing another session follows: no polling, no wake prompt, and the old shared keys are gone', async ($, on) => {
  const other = { at: 1_000_000, active: FOLLOWED, watched: [{ ...FOLLOWED, story: 'st_58', reference: '#58', waitKey: null, question: null }] }
  const { calls, prompts, clock, deleted } = engine(on, { now: 'review', stored: { 'session-1:session-other': other, 'active-1': FOLLOWED, 'watched-1': [other.watched[0]] } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(20000)
  expect(calls.filter(one => one.tool === 'story_status').length).toBe(0)
  expect(prompts).toEqual([])
  expect(deleted).toEqual(expect.arrayContaining(['active-1', 'watched-1']))
  // The other session's own list is left alone, and /factory stop here does not touch it.
  await $.command.run(typed('stop'))
  expect(deleted).not.toContain('session-1:session-other')
})

test('a resumed session carries on with its own story and wakes itself', async ($, on) => {
  const { calls, prompts, clock } = engine(on, { now: 'review', session: 'session-a', stored: { 'session-1:session-a': { at: 1_000_000, active: FOLLOWED, watched: [] } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(calls.filter(one => one.tool === 'story_status').length).toBeGreaterThan(0)
  expect(prompts.length).toBe(1)
})

test('a session gone for over 30 days loses its key, and /factory stop removes only its own', async ($, on) => {
  const { clock, deleted } = engine(on, { now: 'build', session: 'session-a', stored: {
    'session-1:session-gone': { at: 1_000_000 - 31 * 24 * 3600 * 1000, active: FOLLOWED, watched: [] },
    'session-1:session-a': { at: 1_000_000, active: FOLLOWED, watched: [] },
  } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(deleted).toContain('session-1:session-gone')
  expect(deleted).not.toContain('session-1:session-a')
  await clock.advance(1000)
  await $.command.run(typed('stop'))
  expect(deleted).toContain('session-1:session-a')
})

test('many followed stories are polled one per tick, so a session stays well under the connector limit', async ($, on) => {
  const watched = ['st_a', 'st_b', 'st_c', 'st_d', 'st_e', 'st_f', 'st_g', 'st_h'].map(story => ({ ...FOLLOWED, story, reference: story, waitKey: null, question: null }))
  const { calls, clock } = engine(on, { now: 'build', stored: { 'session-1:session-a': { at: 1_000_000, active: null, watched } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 60; i++) await clock.advance(1000)
  const polled = calls.filter(one => one.tool === 'story_status')
  expect(polled.length).toBeLessThanOrEqual(16)
  expect(polled.length).toBeGreaterThanOrEqual(8)
  // Each gets its turn.
  expect(new Set(polled.map(one => (one.args as { story: string }).story)).size).toBe(8)
})
