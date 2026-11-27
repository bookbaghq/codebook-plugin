import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { splitRun, waitOf } from '../hooks/factory'
import type { Status } from '../hooks/factory'
import { CONTINUATION_STORE } from '../hooks/continuation'

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

type At = 'build' | 'claimed' | 'review' | 'done' | 'asks' | 'escalated' | 'blocked' | 'numericMine' | 'numericManager' | 'numericReadOnly' | 'numericRunner' | 'numericNext' | 'numericUnavailable'
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
  if (at.startsWith('numeric')) return {
    ...status('build'),
    waiting: at === 'numericRunner' ? { on: 'runner', run: 899, on_you: true } : null,
    question: {question: at === 'numericNext' ? 42 : 41, asked: 'Authorize this cost?', tools: at === 'numericReadOnly' ? [] : ['answer_question']},
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
  if (at === 'blocked') return { ...status('build'), run: { run: 811, state: 'blocked', where: 'here' }, events: [{ id: 9006, kind: 'run.blocked', run: 811 }], last_event: 9006 }
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
type Lifecycle = { passed?: boolean; terminal?: boolean; events?: Record<string, unknown>[]; holdFeed?: Promise<void>; feedError?: boolean;
  holdStore?: Promise<void>; storeEntered?: () => void; storePrefix?: string; storeSkip?: number; afterStore?: boolean;
  holdStatus?: Promise<void>; statusEntered?: () => void }
function engine(on: On, at: { now: At; asks58?: boolean; done58?: boolean; session?: string; stored?: Record<string, unknown>; controls?: boolean; backlog?: boolean; lifecycle?: Lifecycle }) {
  const calls: Calls = []
  const prompts: string[] = []
  const filled: string[] = []
  const logged: string[] = []
  // $.store in memory, as mock.store keeps it, recording what is removed.
  const kept = new Map<string, unknown>(Object.entries(at.stored ?? {}))
  const deleted: string[] = []
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', async (_, e) => {
    const latch = at.lifecycle
    const held = e.key.startsWith(latch?.storePrefix ?? CONTINUATION_STORE) && latch?.holdStore && !(latch.storeSkip && latch.storeSkip-- > 0) ? latch.holdStore : undefined
    if (held) {
      delete latch!.holdStore
      if (latch!.afterStore) kept.set(e.key, e.value)
      latch!.storeEntered?.()
      await held
    }
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
    return { text: e.text, context: e.context } as never
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
    if (tool === 'needs_you' && args.view === 'person') {
      if (at.now === 'numericUnavailable') return {error: {code: 'UNREACHABLE', message: 'Temporarily offline'}}
      const base = {kind: 'question', for: 'person', on_you: true, story: {story: '6KjN'}}
      return {items: at.now === 'asks' ? [{...base, question_id: 811, run: 811, question: ASKED}]
        : ['numericMine', 'numericRunner', 'numericNext'].includes(at.now) ? [{...base, question_id: at.now === 'numericNext' ? 42 : 41, run: null, question: 'Authorize this cost?'}] : []}
    }
    if (tool === 'factory_events') {
      if (at.lifecycle?.feedError) return { error: { code: 'UNREACHABLE', message: 'Temporarily offline' } }
      const events = (at.lifecycle?.events ?? []).filter(e => Number(e.id) > Number(args.after ?? 0))
      return { events, last_event: events.at(-1)?.id ?? args.after ?? 0 }
    }
    if (tool === 'work_orders' && at.lifecycle) return {
      order: 'wo7', work_order: { reference: 'WO-7', status: at.lifecycle.terminal ? 'done' : 'open' },
      milestones: [{ milestone: 1, state: at.lifecycle.passed ? 'passed' : 'checking', check: { latest: { id: 91, status: at.lifecycle.passed ? 'passed' : 'running' } } }],
    }

    if (tool === 'factory_board' && at.backlog && typeof args.backlog_offset === 'number') {
      const stories = Array.from({ length: 17 }, (_, i) => ({ story: `s${i + 1}`, reference: `#${i + 1}`, title: `Story ${i + 1}`,
        proposal: i === 0 ? { reference: 'WO-6', item: 3, waiting_for_proceed: true } : null }))
      if (args.workflow === 'Empty workflow') stories.length = 0
      const offset = args.backlog_offset
      return { ...BOARD, backlog_count: stories.length, backlog: { offset, limit: 15, next_offset: offset + 15 < stories.length ? offset + 15 : null,
        stories: stories.slice(offset, offset + 15) } }
    }
    if (tool === 'story_status' && args.story === 's1') return { ...status('build'), story: { story: 's1', reference: '#1', title: 'Story 1' }, in_backlog: true, run: null, station: null, waiting: null }
    if (tool === 'work_orders') return { work_order: { reference: 'WO-7', title: 'Migrate exporter', status: 'open', paused: true,
      ...(at.controls && { execution_limits: { max_usd: '25.0000', deadline: '2030-05-15T12:00:00.000Z', deadline_reached: true, last_refusal: 'This model has no configured price.' } }) }, factory_paused: false,
      ...(at.controls && { spend_balance: { available_usd: '17.2500', reserved_usd: '5.0000', spent_usd: '2.7500' } }),
      milestones: [{ milestone: 1, label: 'Needs a person', check: { needs_person: true, latest: { steps: [{ status: 'failed', title: 'Amounts agree', commit_sha: '0123456789abcdef', run_id: 32, detail: 'Expected 100, saw 99.' }] } } }],
      questions: [{ question: 'Include refunds?' }], money: { total_usd: 0.25, complete: false, tokens: 90, sandbox: { seconds: 30, usd: null } } }
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
              ? at.done58 ? { ...status58(false), finished: 'done', run: null, waiting: null, events: [{ id: 9007, kind: 'card.finished' }], last_event: 9007 } : status58(at.asks58 === true)
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
  on('mcp.call', async (_, e) => {
    if (e.tool === 'factory_events' && at.lifecycle?.holdFeed) await at.lifecycle.holdFeed
    if (e.tool === 'story_status' && at.lifecycle?.holdStatus) {
      const held = at.lifecycle.holdStatus
      delete at.lifecycle.holdStatus
      at.lifecycle.statusEntered?.()
      await held
    }
    calls.push({ tool: e.tool, args: e.args })
    const data = answer(e.tool, e.args)
    const isError = typeof data === 'object' && data !== null && 'error' in data
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } }
  })
  return { calls, prompts, filled, logged, clock, deleted, kept }
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
  expect(calls.every(one => ['factory_board', 'story_status', 'story_trail', 'factory_events', 'start_story'].includes(one.tool))).toBe(true)
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

test('backlog pages are read-only, followable, scoped to the selected workflow, and distinguish empty pages', async ($, on) => {
  const { calls, filled, prompts } = engine(on, { now: 'build', backlog: true })
  const first = await $.command.run(typed('backlog Platform Payments --workflow "Release QA"'))
  expect(first.text).toContain('Showing 1–15 of 17.')
  expect(first.text).toContain('#1 Story 1 · WO-6 item 3 (waiting for proceed) · /factory follow s1')
  const next = '/factory backlog k3Vb9QmZ --workflow wf12 --offset 15'
  expect(first.text).toContain(next)
  const last = await $.command.run(typed(next.slice('/factory '.length)))
  expect(last.text).toContain('Showing 16–17 of 17.')
  expect(last.text).not.toContain('Next page')
  expect((await $.command.run(typed('backlog Payments --workflow wf12 --offset 35'))).text).toContain('No stories at offset 35. Start again: /factory backlog k3Vb9QmZ --workflow wf12')
  expect((await $.command.run(typed('backlog Payments --workflow "Empty workflow"'))).text).toContain('No stories in this backlog.')
  expect(calls.map(c => c.tool)).toEqual(Array(4).fill('factory_board'))
  expect(calls[0].args).toEqual({ factory: 'Platform Payments', workflow: 'Release QA', backlog_offset: 0 })
  expect(calls[1].args).toEqual({ factory: 'k3Vb9QmZ', workflow: 'wf12', backlog_offset: 15 })
  expect([...prompts, ...filled]).toEqual([])
})

test('backlog reports older servers and rejects invalid options before contacting CodeBook', async ($, on) => {
  const { calls } = engine(on, { now: 'build' })
  for (const args of ['', '--offset 3', 'Payments --offset -1', 'Payments --offset 2.3', 'Payments --offset 9007199254740992',
    'Payments --offset', 'Payments --offset 0 --offset 4', 'Payments --workflow', 'Payments --workflow --offset 0', 'Payments --wrong 2'])
    expect((await $.command.run(typed('backlog ' + args))).text).toContain('Usage:')
  expect(calls.length).toBe(0)
  const old = await $.command.run(typed('backlog Payments'))
  expect(old.text).toContain('server did not return backlog pages')
  expect(old.text).not.toContain('No stories')
  expect(calls).toEqual([{ tool: 'factory_board', args: { factory: 'Payments', backlog_offset: 0 } }])
})

test('the picker can read the backlog without starting a story or calling a model', async ($, on) => {
  const { calls, filled, prompts } = engine(on, { now: 'build', backlog: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'load' })
  await ui.press({ key: 'pick-k3Vb9QmZ' })
  await ui.press({ key: 'backlog' })
  expect(await ui.find({ type: 'Text', text: /^Showing 1–15 of 17/ })).toBeDefined()
  expect(calls.at(-1)).toEqual({ tool: 'factory_board', args: { factory: 'k3Vb9QmZ', backlog_offset: 0 } })
  await ui.press({ key: 'next-backlog' })
  expect(await ui.find({ type: 'Text', text: /^Showing 16–17 of 17/ })).toBeDefined()
  expect(calls.at(-1)).toEqual({ tool: 'factory_board', args: { factory: 'k3Vb9QmZ', workflow: 'wf12', backlog_offset: 15 } })
  await ui.press({ key: 'back-to-factory' })
  expect(await ui.find({ type: 'Button', key: 'backlog' })).toBeDefined()
  expect([...filled, ...prompts]).toEqual([])
  await ui.unmount()
})

test('follow sends the full factory name and status identifies a story waiting in the backlog', async ($, on) => {
  const { calls } = engine(on, { now: 'build' })
  await $.command.run(typed('follow s1 Platform Payments'))
  expect(calls[0]).toEqual({ tool: 'story_status', args: { story: 's1', factory: 'Platform Payments', limit: 1 } })
  const result = await $.command.run(typed('status'))
  expect(result.text).toContain('in the backlog')
  expect(result.text).not.toContain('moving')
})

test('a new terminal can read an overnight report without approving, resuming or running a model', async ($, on) => {
  const { calls, prompts, filled } = engine(on, { now: 'build' })
  const bad = await $.command.run(typed('report Payments'))
  expect(bad.text).toContain('Usage:')
  const r = await $.command.run(typed('report Platform Payments WO-7'))
  expect(calls).toEqual([{ tool: 'work_orders', args: { factory: 'Platform Payments', order: 'WO-7' } }])
  expect(r.text).not.toContain('Work-order spend limit')
  expect(r.text).not.toContain('Production watch')
  for (const detail of ['paused', 'A person needs to decide', 'failed: Amounts agree', 'commit 0123456789abcdef', 'run #32', 'Expected 100, saw 99.', 'Include refunds?', '$0.2500 (partial)', 'Unpriced sandbox time: 30s']) expect(r.text).toContain(detail)
  expect([...prompts, ...filled].length).toBe(0)
})

test('report reads order limits, reserved funds and a held operation', async ($, on) => {
  const { calls, prompts, filled } = engine(on, { now: 'build', controls: true })
  const report = await $.command.run(typed('report Payments WO-7'))
  for (const text of ['spend limit at configured rates: $25.0000', '$17.2500 available', '$5.0000 reserved', '$2.7500 recorded', '2030-05-15T12:00:00.000Z (reached', 'This model has no configured price.']) expect(report.text).toContain(text)
  expect(report.text).not.toContain('Production')
  expect(calls).toEqual([{ tool: 'work_orders', args: { factory: 'Payments', order: 'WO-7' } }])
  expect([...prompts, ...filled].length).toBe(0)
})

test('overnight passes explicit order limits to the new proposal and refuses an ambiguous or invalid option', async ($, on) => {
  const { calls, filled } = engine(on, { now: 'build' })
  await $.command.run(typed('overnight Payments "Modernize exporter" --max-usd=25 --deadline 2099-05-15T08:00:00-04:00'))
  expect(filled[0]).toContain('The goal is "Modernize exporter".')
  expect(filled[0]).toContain('{"max_usd":25,"deadline":"2099-05-15T08:00:00-04:00"}')
  expect(filled[0]).toContain('proposal.execution_limits')
  await $.command.run(typed('overnight Payments "Modernize exporter" --max-usd 0.01'))
  expect(filled[1]).toContain('{"max_usd":0.01}')
  await $.command.run(typed('overnight Payments "Modernize exporter" --deadline=2099-05-15T12:00:00Z'))
  expect(filled[2]).toContain('{"deadline":"2099-05-15T12:00:00Z"}')
  for (const bad of ['--max-usd 0', '--max-usd 100000.01', '--max-usd', '--deadline tomorrow', '--deadline 2099-05-15T08:00', '--deadline 2000-01-01T12:00:00Z', '--max-usd 20 --max-usd 50', '--max-us 25']) {
    const result = await $.command.run(typed('overnight Payments "Modernize exporter" ' + bad))
    expect(result.text).toContain('--')
  }
  expect(filled.length).toBe(3)
  expect(calls.some(c => c.tool === 'propose_stories' || c.tool === 'confirm_stories')).toBe(false)
})

test('overnight proposes a cloud work order even when this session normally runs here', async ($, on) => {
  const { filled, calls } = engine(on, { now: 'build' })
  await $.command.run(typed('overnight Payments "Modernize the invoice exporter"'))
  expect(filled[0]).toContain('Modernize the invoice exporter')
  expect(filled[0]).toContain('Omit each unspecified limit')
  expect(filled[0]).not.toContain('Pass these explicit proposal fields')
  expect(filled[0]).toContain('propose_stories with run_location "cloud"')
  expect(filled[0]).toContain('ask "proceed?" before confirm_stories')
  expect(filled[0]).toContain('manager’s token ceiling')
  expect(filled[0]).toContain('open_sub_manager in fresh mode')
  expect(calls.some(c => ['propose_stories', 'confirm_stories', 'open_sub_manager'].includes(c.tool))).toBe(false)
  const refused = await $.command.run(typed('overnight Payments "Upgrade the worker" --here'))
  expect(refused.text).toContain('Overnight work runs in CodeBook')
  expect(filled.length).toBe(1)
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

test("workers' calls do not each poll: the timer stays the only poll, and the pane still catches up", async ($, on) => {
  const { calls, clock } = engine(on, { now: 'build', session: 'session-a', stored: { 'session-1:session-a': { at: 1_000_000, active: FOLLOWED, watched: [] } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const polled = () => calls.filter(one => one.tool === 'story_status').length
  const before = polled()
  for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__run_note', run: 8, fence: 1, note: `step ${i}` } as never)
  expect(polled()).toBe(before)
  await clock.advance(5000)
  expect(polled()).toBe(before + 1)
})

test('a call on a story that looks finished is caught up within the short poll, not the quiet one', async ($, on) => {
  const { calls, clock } = engine(on, { now: 'done', session: 'session-a', stored: { 'session-1:session-a': { at: 1_000_000, active: FOLLOWED, watched: [] } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const polled = () => calls.filter(one => one.tool === 'story_status').length
  const before = polled()
  await clock.advance(10000)
  expect(polled()).toBe(before)
  await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__send_back', story: 'st_57' } as never)
  await clock.advance(5000)
  expect(polled()).toBe(before + 1)
})

/** #147: the plugin's files, as `.claude-plugin/plugin.json` says its version; a test moves it as an update would. */
function versioned(on: On, version: { now: string }) {
  on('fs.read', (_, e) => (String((e as { path?: unknown }).path).replace(/\\/g, '/').endsWith('/.claude-plugin/plugin.json')
    ? { value: JSON.stringify({ name: 'codebook', version: version.now }) }
    : { error: 'ENOENT' }) as never)
}
// The engine can supply a Windows root with either native or mixed separators.
test('P5: the version-file double accepts POSIX, Windows and mixed paths', () => {
  let read: (_: unknown, e: { path: string }) => unknown = () => null
  const version = { now: '0.27.0' }
  versioned(((_event: string, handler: typeof read) => { read = handler }) as On, version)
  for (const path of [
    '/plugins/codebook/.claude-plugin/plugin.json',
    'C:\\plugins\\codebook\\.claude-plugin\\plugin.json',
    'C:\\plugins\\codebook/.claude-plugin/plugin.json',
  ]) {
    expect(read(null, { path })).toEqual({ value: JSON.stringify({ name: 'codebook', version: version.now }) })
  }
  expect(read(null, { path: 'C:\\plugins\\codebook\\other.json' })).toEqual({ error: 'ENOENT' })
})

const contextOf = async ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text = 'go on') =>
  (((await $.prompt.submit({ text } as never)) as { context?: string[] }).context ?? []).filter(line => line.startsWith('CodeBook plugin:'))

test('P5: a mid-session plugin update is named on the next prompt', async ($, on) => {
  engine(on, { now: 'build' })
  const version = { now: '0.24.1' }
  versioned(on, version)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // claude plugin update in the middle of the session: the hooks are reloaded from 0.27.0, the skills are not.
  version.now = '0.27.0'
  const lines = await contextOf($)
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('hooks are now version 0.27.0')
  expect(lines[0]).toContain('loaded from version 0.24.1')
  expect(lines[0]).toContain('/reload-plugins')
})

test('P5: the version notice is given once and never when the versions match', async ($, on) => {
  engine(on, { now: 'build' })
  const version = { now: '0.27.0' }
  versioned(on, version)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The same version: nothing, prompt after prompt.
  expect(await contextOf($)).toEqual([])
  expect(await contextOf($)).toEqual([])
  // One update: one line, on the first prompt after it only.
  version.now = '0.28.0'
  expect((await contextOf($)).length).toBe(1)
  expect(await contextOf($)).toEqual([])
  // Another update: told again, once.
  version.now = '0.29.0'
  const again = await contextOf($)
  expect(again.length).toBe(1)
  expect(again[0]).toContain('hooks are now version 0.29.0')
  expect(await contextOf($)).toEqual([])
  // A new session starts on what it loads: nothing to say.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await contextOf($)).toEqual([])
})

test('P5: /factory status shows a version mismatch', async ($, on) => {
  engine(on, { now: 'build' })
  const version = { now: '0.24.1' }
  versioned(on, version)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(typed('status'))).text).not.toContain('CodeBook plugin:')
  version.now = '0.27.0'
  // While it lasts, even after the prompt's notice was given.
  await contextOf($)
  const status = (await $.command.run(typed('status'))).text
  expect(status).toContain('hooks are now version 0.27.0')
  expect(status).toContain('loaded from version 0.24.1')
  expect(status).toContain('/reload-plugins')
  // After a restart on the new version, it is gone.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(typed('status'))).text).not.toContain('CodeBook plugin:')
})


const continuationPrompts = (prompts: string[]) => prompts.filter(text => text.includes('continue eligible authorized work'))

for (const tool of ['start_story', 'confirm_stories']) {
  for (const [storePrefix, storeSkip] of [[CONTINUATION_STORE, 0], [CONTINUATION_STORE, 1], ['session-1:', 0], ...(tool === 'confirm_stories' ? [['session-1:', 1]] : [])] as [string, number][]) {
    for (const afterStore of [false, true]) {
      test(`stop fences ${tool} adoption at ${storePrefix} write ${storeSkip + 1} ${afterStore ? 'after' : 'before'} persistence`, async ($, on) => {
        const at: { now: At; asks58?: boolean; lifecycle: Lifecycle } = { now: 'build', lifecycle: {} }
        const { prompts, clock, kept, calls } = engine(on, at)
        await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
        let release!: () => void
        let entered!: () => void
        const inStore = new Promise<void>(resolve => { entered = resolve })
        Object.assign(at.lifecycle, { storePrefix, storeSkip, afterStore, storeEntered: entered, holdStore: new Promise<void>(resolve => { release = resolve }) })
        const starting = tool === 'start_story' ? claudeStarts($) : $.tool.call({ tool: 'mcp__plugin_codebook_codebook__confirm_stories', proposal: 'wo7' } as never)
        await inStore
        const stopping = $.command.run(typed('stop'))
        await new Promise(resolve => setTimeout(resolve, 10))
        release()
        await Promise.all([starting, stopping])
        at.now = 'done'
        at.asks58 = true
        await clock.advance(65000)
        expect(kept.has(CONTINUATION_STORE + 'session-a')).toBe(false)
        expect(kept.has('session-1:session-a')).toBe(false)
        expect(prompts).toEqual([])
        const reads = calls.length
        await clock.advance(65000)
        expect(calls.length).toBe(reads)
        // Cancellation fences old operations, not a new explicit follow after stop has completed.
        at.now = 'build'
        await $.command.run(typed('follow 6KjN Payments'))
        at.now = 'done'
        await clock.advance(5000)
        expect(continuationPrompts(prompts).length).toBe(1)
      })
    }
  }
}

test('stop fences an explicit follow whose status response is still in flight', async ($, on) => {
  const at: { now: At; lifecycle: Lifecycle } = { now: 'build', lifecycle: {} }
  const { prompts, clock, kept } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  let release!: () => void
  let entered!: () => void
  const inStatus = new Promise<void>(resolve => { entered = resolve })
  at.lifecycle.holdStatus = new Promise<void>(resolve => { release = resolve })
  at.lifecycle.statusEntered = entered
  const following = $.command.run(typed('follow 6KjN Payments'))
  await inStatus
  await $.command.run(typed('stop'))
  release()
  expect((await following).text).toContain('cancelled')
  at.now = 'done'
  await clock.advance(65000)
  expect(kept.has(CONTINUATION_STORE + 'session-a')).toBe(false)
  expect(kept.has('session-1:session-a')).toBe(false)
  expect(prompts).toEqual([])
})

test('owned story completion wakes continuation once', async ($, on) => {
  const at: { now: At; done58?: boolean; lifecycle: Lifecycle } = { now: 'build', lifecycle: {} }
  const { prompts, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__confirm_stories', proposal: 'wo7' } as never)
  await clock.advance(5000)
  at.now = 'done'
  at.done58 = true
  await clock.advance(5000)
  const wakes = continuationPrompts(prompts)
  expect(wakes.length).toBe(1)
  expect(wakes[0]).toContain('#57 finished.')
  expect(wakes[0]).toContain('#58 finished.')
  await clock.advance(65000)
  expect(continuationPrompts(prompts).length).toBe(1)
  // A newly created story can finish before its first timer read; that completion is still new work for this session.
  await $.command.run(typed('stop'))
  await $.tool.call({ tool: 'mcp__plugin_codebook_codebook__confirm_stories', proposal: 'wo7' } as never)
  await clock.advance(5000)
  const fast = continuationPrompts(prompts).slice(1).join(' ')
  expect(fast.split('#57 finished.').length - 1).toBe(1)
  expect(fast.split('#58 finished.').length - 1).toBe(1)
})

test('owned milestone pass remains observable after its stories finish', async ($, on) => {
  // This is the persisted shape left by the previous session after its stories finished.
  const saved = { generation: 0, stories: {}, orders: { wo7: { factory: 'k3Vb9QmZ', reference: 'WO-7', passes: [] } },
    feeds: { k3Vb9QmZ: 9007 }, pending: {}, nextFactory: 0, nextOrder: 0, checkedAt: 990000 }
  const at = { now: 'done' as At, lifecycle: { passed: true, events: [{ id: 9008, kind: 'work_order.milestone_passed', work_order: { reference: 'WO-7' } }] },
    stored: { [CONTINUATION_STORE + 'session-a']: { at: 999000, value: saved } } }
  const { prompts, clock, calls, kept } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(continuationPrompts(prompts).length).toBe(1)
  expect(continuationPrompts(prompts)[0]).toContain('WO-7 milestone 1 passed')
  expect(calls.filter(c => c.tool === 'story_status').length).toBe(0)
  await clock.advance(65000)
  expect(continuationPrompts(prompts).length).toBe(1)
  const persisted = kept.get(CONTINUATION_STORE + 'session-a') as { value: { orders: { wo7: { passes: string[] } } } }
  expect(persisted.value.orders.wo7.passes).toEqual(['1:91'])
  expect(calls.filter(c => c.tool === 'factory_events').length).toBeLessThanOrEqual(3)
  expect(calls.filter(c => c.tool === 'work_orders').length).toBeLessThanOrEqual(3)
})

test('blocked branch wakes a search for independent ready work', async ($, on) => {
  const at: { now: At; lifecycle: Lifecycle } = { now: 'build', lifecycle: {} }
  const { prompts, calls, clock } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  at.now = 'blocked'
  await clock.advance(5000)
  expect(continuationPrompts(prompts).length).toBe(1)
  expect(continuationPrompts(prompts)[0]).toContain('#57 is blocked; inspect independent ready work.')
  expect(continuationPrompts(prompts)[0]).toContain('do not repeat unchanged blocked tests or proof requests')
  await clock.advance(65000)
  expect(continuationPrompts(prompts).length).toBe(1)
  expect(calls.some(c => ['claim_work', 'request_proof', 'approve_station', 'confirm_stories'].includes(c.tool))).toBe(false)
})

test('continuation preserves approvals ownership and bounded wakeups', async ($, on) => {
  const at: { now: At; lifecycle: Lifecycle; stored: Record<string, unknown> } = { now: 'build', lifecycle: {}, stored: {
    [CONTINUATION_STORE + 'session-other']: { at: 999000, value: { orders: { wo8: { factory: 'foreign', reference: 'WO-8', passes: [] } } } },
  } }
  const { prompts, calls, clock, kept } = engine(on, at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await claudeStarts($)
  await clock.advance(5000)
  at.lifecycle.events = [{ id: 9010, kind: 'card.finished', card: { key: 'not-owned' } }, { id: 9011, kind: 'work_order.milestone_passed', work_order: { reference: 'WO-8' } }]
  await clock.advance(30000)
  expect(continuationPrompts(prompts)).toEqual([])
  at.lifecycle.feedError = true
  await clock.advance(30000)
  expect(continuationPrompts(prompts)).toEqual([])
  at.lifecycle.feedError = false
  at.now = 'done'
  await clock.advance(5000)
  const text = continuationPrompts(prompts)[0]!
  expect(text).toContain('queued runs first, open proposals and the separate Backlog')
  expect(text).toContain('current approvals, capacity, budgets and deadlines')
  expect(text).toContain('suggest policy still asks before new unapproved stories')
  expect(text).toContain("Leave other sessions' work alone")
  expect(calls.some(c => c.args.factory === 'foreign' || c.args.order === 'wo8')).toBe(false)
  // A read in flight at /factory stop must not restore state or submit a late wake.
  let release!: () => void
  at.lifecycle.holdFeed = new Promise<void>(resolve => { release = resolve })
  await clock.advance(30000)
  await $.command.run(typed('stop'))
  const count = prompts.length
  release()
  await clock.advance(65000)
  expect(prompts.length).toBe(count)
  expect(kept.has(CONTINUATION_STORE + 'session-a')).toBe(false)
  expect(kept.has(CONTINUATION_STORE + 'session-other')).toBe(true)
  const afterStop = calls.length
  await clock.advance(65000)
  expect(calls.length).toBe(afterStop)
})

test('only a confirmed personal wait may ask from the Factory pane', async () => {
  const base = status('build') as Status
  expect(waitOf({ ...base, question: 'Unassigned' })).toBeNull()
  expect(waitOf({ ...base, question: { text: 'Unassigned' } })).toBeNull()
  expect(waitOf({ ...base, question: { text: 'Managed', on_you: true, decided_by: 'manager' } })).toBeNull()
  expect(waitOf({ ...base, waiting: { on: 'runner', run: 811, on_you: true, question: 'Runner work' } })).toBeNull()
  const waiting = { on: 'person' as const, run: 811, on_you: true }
  expect(waitOf({ ...base, waiting: { ...waiting, question: { text: 'Managed', for: 'manager' } } })).toBeNull()
  expect(waitOf({ ...base, waiting: { ...waiting, question: { text: 'Another person', on_you: false } } })).toBeNull()
  expect(waitOf({ ...base, waiting: { ...waiting, question: 'Actual personal wait' } })?.question).toBe('Actual personal wait')
  expect(waitOf({ ...base, question: { text: 'Assigned to me', on_you: true } })?.question).toBe('Assigned to me')
})

test('a live numeric question id wakes only the viewer assigned its personal decision', async ($, on) => {
  const at: {now: At} = {now: 'numericReadOnly'}
  const {prompts, calls, clock} = engine(on, at)
  await $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  await claudeStarts($)
  await clock.advance(5000)
  expect(prompts).toEqual([])
  expect(calls.some(row => row.tool === 'needs_you' && row.args.view === 'person')).toBe(false)
  at.now = 'numericManager'
  await clock.advance(5000)
  expect(prompts).toEqual([])
  at.now = 'numericMine'
  await clock.advance(5000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Authorize this cost?')
  at.now = 'numericUnavailable'
  await clock.advance(5000)
  at.now = 'numericRunner'
  await clock.advance(5000)
  expect(prompts.length).toBe(1)
  at.now = 'numericNext'
  await clock.advance(5000)
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('Authorize this cost?')
})

test('an ownership outage before delivery parks a queued personal question until it is confirmed again', async ($, on) => {
  const at: {now: At} = {now: 'build'}
  const {prompts, clock} = engine(on, at)
  await $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  await claudeStarts($)
  await clock.advance(5000)
  at.now = 'numericMine'
  await $.command.run(typed('status'))
  expect(prompts.length).toBe(0)
  at.now = 'numericUnavailable'
  await $.command.run(typed('status'))
  await clock.advance(5000)
  expect(prompts.length).toBe(0)
  at.now = 'numericRunner'
  await clock.advance(10000)
  expect(prompts.length).toBe(1)
})
