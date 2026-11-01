import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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

type At = 'build' | 'claimed' | 'review'

function status(at: At) {
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

/** The engine beneath the plugin: a connected codebook server answering from the fixtures above. */
function engine(on: On, at: { now: At }) {
  const calls: Calls = []
  const prompts: string[] = []
  const filled: string[] = []
  const logged: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
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
            ? status(at.now)
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
    const isError = 'error' in data
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } }
  })
  return { calls, prompts, filled, logged, clock }
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

test('Approve in the pane warns it may merge and offers the approval with the pull request heads', async ($, on) => {
  const { filled } = engine(on, { now: 'review' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Approving may merge the pull request/ })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(filled.at(-1)).toContain('Approve the Review station')
  expect(filled.at(-1)).toContain('[{"pull_request_id":5,"head_sha":"abc"}]')
  expect(filled.at(-1)).toContain('may merge the pull request')
  await ui.unmount()
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

test('confirming stories follows the first one created', async ($, on) => {
  engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__confirm_stories', proposal: 'wo7', run_location: 'here' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PAYMENTS FACTORY · #57/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 more created/ })).toBeDefined()
  await ui.unmount()
})
