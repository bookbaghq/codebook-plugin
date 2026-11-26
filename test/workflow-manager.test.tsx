import { expect, mock, test } from 'claude-code/testing'
import { CONTINUATION_STORE } from '../hooks/continuation'
import type { Status } from '../hooks/factory'
import type { CodebookContinuation } from '../types'

const typed = (args: string) => ({
  command: 'factory', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 },
})

test('local workflow manager resumes ready work after its last order and stays quiet on unchanged holds', async ($, on) => {
  const session = 'local-manager', key = CONTINUATION_STORE + session, store = new Map<string, unknown>()
  const factory = { factory: 'payments', name: 'Payments' }, workflow = { workflow: 'wf12', name: 'Delivery' }
  const pendingRun: Status = {
    story: { story: 'my-card', reference: '#17', title: 'Export' }, factory, workflow, station: null,
    in_backlog: false, finished: null, run: { run: 819, state: 'with_outside_agent', where: 'here' },
    waiting: { on: 'runner', run: 819, on_you: true, claimed: false }, stations: [], events: [], last_event: 98,
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  let event = 100, ready = false, reject = true, claimed = true
  const calls: string[] = [], submitted: string[] = [], delivered: string[] = []
  // Restoring the previous manager process also restores its last owned order.
  store.set(key, { at: 999000, value: { generation: 0, stories: {}, orders: { wo1: { factory: 'payments', reference: 'WO-1', passes: [] } },
    feeds: {}, pending: {}, nextFactory: 0, nextOrder: 0, checkedAt: 0 } })
  on('session.id', () => ({ value: session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'codebook' } }))
  on('mcp.call', (_, e) => {
    calls.push(e.tool)
    let data: unknown
    if (e.tool === 'work_orders') data = { work_order: { reference: 'WO-1', status: 'done' }, milestones: [] }
    else if (e.tool === 'factory_events') data = { events: [], last_event: event }
    else if (e.tool === 'story_status') data = { ...pendingRun, waiting: { ...pendingRun.waiting!, claimed } }
    else if (e.tool === 'factory_board') data = { ...factory, workflow, stations: [] }
    else if (e.tool === 'story_trail') data = { comments: [], artifacts: [] }
    else if (e.tool === 'manager_brief') data = { factory, workflow, you: { may_run_here: true }, backlog: e.args.backlog_offset === 1
      ? { next_offset: null, stories: [{ story: 'independent', workflow: 'Delivery', ready, start_with: ready ? 'confirm_stories' : null }] }
      : { next_offset: 1, stories: [{ story: 'person-parked', workflow: 'Delivery', ready: false }, { story: 'elsewhere', workflow: 'Different', ready: true, start_with: 'confirm_stories' }] } }
    else throw Error('Unexpected connector request: ' + e.tool)
    return { value: { structuredContent: data, content: [] } } as never
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    if (reject) throw Error('Host session disconnected')
    delivered.push(e.text)
    return { text: e.text, context: e.context } as never
  })
  const start = () => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const checkpoint = () => (store.get(key) as { value: CodebookContinuation }).value

  await start()
  expect((await $.command.run(typed('manage Payments --workflow wf12'))).text).toContain('Watching Delivery')
  await clock.advance(65000)
  expect(Object.keys(checkpoint().orders)).toEqual([])
  expect(checkpoint().manager?.workflow).toBe('wf12')
  expect(submitted).toEqual([])
  const briefCount = calls.filter(name => name === 'manager_brief').length
  await clock.advance(65000)
  expect(calls.filter(name => name === 'manager_brief').length).toBe(briefCount)

  ready = true
  event++
  await clock.advance(61000)
  expect(submitted.length).toBe(1)
  expect(checkpoint().pending['workflow:independent']).toContain('Independent backlog work')
  expect(checkpoint().deliveryFailures).toBe(1)

  reject = false
  await start()
  await clock.advance(65000)
  expect(delivered.length).toBe(1)
  expect(delivered[0]).toContain('Use Run here only')
  expect(delivered[0]).toContain("Leave other sessions' work alone")
  expect(Object.keys(checkpoint().pending)).toEqual([])
  event++
  await clock.advance(65000)
  expect(delivered.length).toBe(1)

  // Only a locally owned, currently unclaimed station qualifies, including a newly released run.
  expect((await $.command.run(typed('follow my-card Payments'))).text).toContain('Following #17')
  await clock.advance(5000)
  expect(delivered.length).toBe(1)
  claimed = false
  await clock.advance(5000)
  expect(delivered[1]).toContain('#17 has local run 819')
  await clock.advance(5000)
  expect(delivered.length).toBe(2)

  await $.command.run(typed('stop'))
  expect(store.has(key)).toBe(false)
  const afterStop = calls.length
  await clock.advance(65000)
  expect(calls.length).toBe(afterStop)
  expect(delivered.length).toBe(2)
})

test('a restarted manager reconciles each undelivered story, stays quiet and fences a stopped scan', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 }), store = new Map<string, unknown>()
  const submitted: string[] = [], writes: string[] = []
  let cursor = 1, a = false, b = true, reject = false
  let blockedRead: { entered: () => void; wait: Promise<void> } | undefined
  const session = 'resumed-manager', key = CONTINUATION_STORE + session
  on('session.id', () => ({ value: session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { if (e.key === key) writes.push('set'); store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { if (e.key === key) writes.push('delete'); store.delete(e.key); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'codebook' } }))
  on('mcp.call', async (_, e) => {
    if (e.tool === 'factory_events') return { value: { structuredContent: { events: [], last_event: cursor }, content: [] } } as never
    if (e.tool !== 'manager_brief') throw Error('Unexpected connector request: ' + e.tool)
    if (blockedRead) { blockedRead.entered(); await blockedRead.wait }
    const group = { factory: { factory: 'pay' }, workflow: { name: 'Ship', workflow: 'wf1' }, you: { may_run_here: true }, backlog: { stories: [
      { story: 'a', reference: '#1', workflow: 'Ship', ready: a, start_with: 'confirm_stories' },
      { story: 'b', reference: '#2', workflow: 'Ship', ready: b, start_with: 'confirm_stories' },
    ] } }
    return { value: { structuredContent: group, content: [] } } as never
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    if (reject) throw Error('Disconnected')
    return { text: e.text, context: e.context } as never
  })

  const start = () => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await start()
  await $.command.run(typed('manage pay --workflow wf1'))
  await clock.advance(65000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#2')
  a = true; reject = true; cursor++
  // Stop at the first rejected submission, before even one delivery retry.
  for (let i = 0; i < 10 && submitted.length < 2; i++) await clock.advance(5000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('#1')

  a = false; reject = false
  await start()
  await clock.advance(65000)
  expect(submitted.length).toBe(2)

  b = false; cursor++
  await clock.advance(65000)
  const settled = writes.length
  for (let i = 0; i < 2; i++) await clock.advance(305000)
  expect(writes.length).toBe(settled)

  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  blockedRead = { entered, wait: new Promise<void>(resolve => { release = resolve }) }
  a = true; cursor++
  const unfinished = clock.advance(65000)
  await started
  await $.command.run(typed('stop'))
  const stopped = writes.length
  release()
  await unfinished
  await clock.advance(65000)
  expect(writes.length).toBe(stopped)
  expect(submitted.length).toBe(2)
})

test('a moving page, a held followed card and a newly claimed local run do not wake the manager', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 }), session = 'changing-readiness', key = CONTINUATION_STORE + session
  const saved = new Map<string, unknown>(), delivered: string[] = [], rejected: string[] = []
  const factory = { factory: 'pay', name: 'Payments' }, workflow = { workflow: 'wf1', name: 'Ship' }
  let writes = 0, cursor = 1, firstReads = 0, reject = false, claimed = false, localReads = 0
  on('session.id', () => ({ value: session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', (_, e) => ({ value: saved.get(e.key) }))
  on('store.set', (_, e) => { if (e.key === key) writes++; saved.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { if (e.key === key) writes++; saved.delete(e.key); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'codebook' } }))
  on('mcp.call', (_, e) => {
    let data: unknown
    if (e.tool === 'factory_events') data = { events: [], last_event: cursor }
    else if (e.tool === 'manager_brief') {
      const first = !e.args.backlog_offset
      data = { factory, workflow, you: { may_run_here: true }, backlog: { next_offset: first ? 1 : null, stories: [
        { story: first ? 'parked' : 'ready', reference: first ? '#900' : '#901', ready: first ? cursor === 1 : true,
          workflow: 'Ship', start_with: 'confirm_stories' },
      ] } }
      // The server moved the first-page story after returning that page; the next feed read sees the new cursor.
      if (first && ++firstReads === 2) cursor++
    } else if (e.tool === 'story_status') {
      const local = e.args.story === 'local'
      if (local) localReads++
      data = { story: { story: local ? 'local' : 'held', reference: local ? '#17' : '#18', title: 'Work' }, factory, workflow,
        in_backlog: false, finished: null, station: null, stations: [], events: [], last_event: 43,
        run: { run: local ? 819 : 820, state: 'with_outside_agent', where: 'here' },
        waiting: local ? { on: 'runner', run: 819, on_you: true, claimed } : { on: 'person', run: 820, on_you: false } }
    } else if (e.tool === 'factory_board') data = { ...factory, workflow, stations: [] }
    else if (e.tool === 'story_trail') data = { comments: [], artifacts: [] }
    else throw Error('Unexpected connector request: ' + e.tool)
    return { value: { structuredContent: data, content: [] } } as never
  })
  on('prompt.submit', (_, e) => {
    if (reject) { rejected.push(e.text); throw Error('Disconnected') }
    delivered.push(e.text)
    return { text: e.text, context: e.context } as never
  })
  const start = () => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await start()
  await $.command.run(typed('manage pay --workflow wf1'))
  await clock.advance(155000)
  expect(delivered.length).toBe(1)
  expect(delivered[0]).toContain('#901')
  expect(delivered[0]).not.toContain('#900')

  await $.command.run(typed('follow held pay'))
  await clock.advance(65000)
  const idle = writes
  await clock.advance(20000)
  expect(writes).toBe(idle)
  expect(delivered.length).toBe(1)

  reject = true
  await $.command.run(typed('follow local pay'))
  await $.command.run(typed('follow held pay'))
  for (let i = 0; i < 10 && !rejected.length; i++) await clock.advance(5000)
  expect(rejected.length).toBe(1)
  expect(rejected[0]).toContain('local run 819')
  const oldReads = localReads
  claimed = true; reject = false
  await start()
  await clock.advance(65000)
  expect(localReads).toBeGreaterThan(oldReads)
  expect(delivered.length).toBe(1)

  // The previous story is still explicitly owned although the pane remains on the human-held story.
  // There is no pending notice to revalidate: the manager must discover the new release itself.
  const readsWhileClaimed = localReads
  claimed = false
  await start()
  await clock.advance(305000)
  expect(localReads).toBeGreaterThan(readsWhileClaimed)
  expect(delivered.length).toBe(2)
  expect(delivered[1]).toContain('#17 has local run 819')
  await clock.advance(65000)
  expect(delivered.length).toBe(2)
  await $.command.run(typed('stop'))
})
