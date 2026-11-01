import { expect, mock, test } from 'claude-code/testing'
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
    events: [{ id: isBuild ? 9001 : 9002, kind: 'run.passed', occurred_at: '2026-11-01T10:00:00Z', station: 'Plan', subject: null }],
    last_event: isBuild ? 9001 : 9002,
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

type Calls = { tool: string; args: Record<string, unknown> }[]

/** The engine beneath the plugin: a connected codebook server answering from the fixtures above. */
function engine(on: On, at: { now: At }) {
  const calls: Calls = []
  const prompts: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:codebook:codebook' } }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const data =
      e.tool === 'start_story'
        ? {
            story: { story: '6KjN', reference: '#57', title: String(e.args.title) },
            factory: { factory: 'k3Vb9QmZ', name: 'Payments' },
            workflow: { workflow: 'wf12', name: 'Delivery' },
            station: { station: 'col40', name: 'Plan' },
            run: { run: 810, state: 'queued' },
            url: 'https://app.codebook.work/workspace/ws1/factory/k3Vb9QmZ?card=6KjN',
          }
        : e.tool === 'factory_board'
          ? BOARD
          : e.tool === 'story_status'
            ? status(at.now)
            : e.tool === 'approve_station'
              ? { decided: 'approved', run: 812, next: 'Review approved; the story moves on.' }
              : e.tool === 'heartbeat_work'
                ? { run: 811, lease: { fence: 3, expires_at: '2026-11-01T10:20:00Z', seconds: 900, heartbeat_every_seconds: 300 } }
                : e.tool === 'list_factories'
                  ? { factories: [{ factory: 'k3Vb9QmZ', name: 'Payments', workspace: { name: 'Claims' }, may_start_stories: true }], total: 1 }
                  : e.tool === 'set_run_location'
                  ? { next: "The story's agent stations now run in CodeBook." }
              : { error: { code: 'NOT_FOUND', message: 'no such tool here' } }
    const isError = 'error' in data
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } }
  })
  return { calls, prompts, clock }
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

test('/factory run starts a run-here story and the pane draws its stations', async ($, on) => {
  const { calls } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(typed('run Payments "Let customers refund a payment"'))
  expect(ran.text).toContain('Story #57')
  const started = calls.find(one => one.tool === 'start_story')
  expect(started?.args).toEqual({ factory: 'Payments', title: 'Let customers refund a payment', run_location: 'here' })

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

test('a station waiting here is handed to the factory-worker once', async ($, on) => {
  const { prompts, clock } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('run Payments "Let customers refund a payment"'))

  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  const handed = prompts.filter(text => text.includes('codebook:factory-worker'))
  expect(handed.length).toBe(1)
  expect(handed[0]).toContain('run 811')
})

test('a cloud story is started with run_location cloud', async ($, on) => {
  const { calls } = engine(on, { now: 'build' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('cloud'))
  await $.command.run(typed('run Payments "Let customers refund a payment"'))
  expect(calls.find(one => one.tool === 'start_story')?.args.run_location).toBe('cloud')
})

test('a run this person holds is kept alive with its fence', async ($, on) => {
  const { calls, clock } = engine(on, { now: 'claimed' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('run Payments "Let customers refund a payment"'))
  await clock.advance(5000)
  const beat = calls.find(one => one.tool === 'heartbeat_work')
  expect(beat?.args).toEqual({ run: 811, fence: 3 })
})

test('Run in CodeBook moves the followed story', async ($, on) => {
  const at: { now: At } = { now: 'build' }
  const { calls } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('run Payments "Let customers refund a payment"'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-cloud' })
  expect(calls.find(one => one.tool === 'set_run_location')?.args).toEqual({
    story: '6KjN',
    factory: 'k3Vb9QmZ',
    workflow: 'wf12',
    run_location: 'cloud',
  })
  await ui.unmount()
})

test('Approve in the pane approves the review with the pull request heads', async ($, on) => {
  const { calls } = engine(on, { now: 'review' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('run Payments "Let customers refund a payment"'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
  await ui.press({ key: 'approve' })
  const approved = calls.find(one => one.tool === 'approve_station')
  expect(approved?.args).toEqual({
    story: '6KjN',
    factory: 'k3Vb9QmZ',
    workflow: 'wf12',
    heads: [{ pull_request_id: 5, head_sha: 'abc' }],
  })
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
