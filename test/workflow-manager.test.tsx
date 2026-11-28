import { expect, mock, test } from 'claude-code/testing'
import { CONTINUATION_STORE } from '../hooks/continuation'
import { register } from '../hooks/register'
import type { EngineInterface } from 'claude-code'
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

import milestoneCases from './fixtures/milestone-check-routes.mjs'
import type { ProofResult, Route } from '../hooks/milestone'

type ToolPermission = (engine: EngineInterface, event: {tool: string; input: unknown},
  next: {origin: {plugin?: string}} & (() => {decision: string})) => Promise<{decision: string}> | {decision: string}

// The native test transport supplies MCP replies directly. Apply the installed permission callback at that boundary.
function registeredPermission(): ToolPermission {
  let permission: ToolPermission | undefined
  register(((event: string, ...args: unknown[]) => {
    if (event === 'tool.check' && args.length === 1 && !permission) permission = args[0] as ToolPermission
    return {catch() {}}
  }) as never)
  if (!permission) throw Error('The plugin has no connector permission callback.')
  return permission
}

function milestoneTransport(on: Parameters<Parameters<typeof test>[1]>[1], ids: string[], autoMode = false) {
  const permission = autoMode ? registeredPermission() : undefined
  const selected = milestoneCases.filter(c => ids.includes(c.id))
  const clock = mock.clock(on, {now: 1_000_000}), store = new Map<string, unknown>()
  const factory = 'fixtureFactory', key = CONTINUATION_STORE + 'milestone-fixture'
  const prompts: string[] = [], writes: Record<string, unknown>[] = []
  const states = {F1: 'fixing', F2: 'checking', F3: 'held', F4: 'ruled', F5: 'needs_person', F6: 'fixing', F7: 'passed', F8: 'checking'}
  const views = new Map(selected.map(c => {
    const r = c.route as Route | null, order = r?.order ?? 'wo39'
    return [order, {order, work_order: {reference: 'WO-' + order.slice(2), status: 'open', title: c.scenario},
      factory_paused: false, questions: [], money: null, milestones: [{milestone: 1, label: c.scenario, state: states[c.id as keyof typeof states],
        fixes: (r?.recovery?.kind === 'repair' ? [{item_id:r.recovery.item, check_id:r.check, card:{public_id:r.recovery.story}}]
          : c.id === 'F1' ? [{check_id:26, card:{public_id:'fix-one'}}] : []) as {item_id?:number;check_id:number;state?:string;card:{public_id:string}}[],
        check: {route: r, needs_person: r?.owner === 'person', check_cannot_run: c.id.startsWith('R') ? 'manager_recovery' : 'ask', history: [] as Record<string, unknown>[],
          latest: {id: r?.check ?? 70, attempt: 2}}}]}]
  }))
  const owned = Object.fromEntries([...views].map(([id, v]) => [id, {factory, reference: v.work_order.reference, passes: []}]))
  store.set(key, {at: 999900, value: {generation: 0, stories: {}, orders: owned, feeds: {}, pending: {}, nextFactory: 0, nextOrder: 0, checkedAt: 0}})
  const checks: string[] = []
  const claims: number[] = [], reports: {run:number; commit:string; exit_code:number}[] = []
  const fixture = {clock, views, prompts, writes, checks, claims, reports, lost: false,
    queue: 'ready' as 'ready' | 'empty' | 'unavailable', peeks:0, loseProofReply:false,
    receipt: {proof:0, finished:false} as ProofResult, attentionRoute: (route: Route) => route, afterAttention: () => {},
    legacy: [] as {kind: string; factory: string; order: string; check_id: number; why: string; on_you: boolean}[],
    ledger: (order: string) => (store.get(key) as {value: CodebookContinuation}).value.orders[order]?.milestones}
  on('session.id', () => ({value: 'milestone-fixture'}))
  on('session.start', (_, e) => ({cwd: e.cwd}))
  on('ui.open', () => ({value: {isPlaced: true}}))
  on('command.register', () => ({value: {command: 'factory'}}))
  on('store.keys', () => ({value: [...store.keys()]}))
  on('store.get', (_, e) => ({value: store.get(e.key)}))
  on('store.set', (_, e) => { store.set(e.key, e.value); return {value: undefined} })
  on('store.delete', (_, e) => { store.delete(e.key); return {value: undefined} })
  on('mcp.connect', () => ({value: {isConnected: true, server: 'codebook'}}))
  on('mcp.call', async ($, e) => {
    if (permission) {
      const below = Object.assign(() => ({decision: 'ask'}), {origin: {plugin: $.plugin.name}})
      const event = {tool: 'mcp__plugin_codebook_codebook__' + e.tool, input: e.args}
      // The host separates the test plugin from CodeBook. Bind the registered callback to the session's fixture store.
      const permissionEngine = {plugin: $.plugin, session: {id: () => 'milestone-fixture'},
        store: {get: (k: string) => store.get(k)}, clock: {now: () => 1_000_000}} as unknown as EngineInterface
      const verdict = await permission(permissionEngine, event, below)
      checks.push(e.tool + ':' + verdict.decision)
      if (verdict.decision !== 'allow') throw Error('Auto mode classifier gave no verdict for ' + e.tool)
      if (e.tool === 'needs_you') {
        const model = Object.assign(() => ({decision:'ask'}), {origin:{}})
        expect((await permission(permissionEngine, event, model)).decision).toBe('ask')
        expect((await permission(permissionEngine, {...event, input:{factory:'another-factory'}}, below)).decision).toBe('ask')
        expect((await permission(permissionEngine, {...event, input:{factory, view:'person'}}, below)).decision).toBe('ask')
        const foreign = {...permissionEngine, session:{id: () => 'another-session'}} as unknown as EngineInterface
        expect((await permission(foreign, event, below)).decision).toBe('ask')
        expect((await permission(permissionEngine, {...event, tool:'mcp__plugin_codebook_codebook__decide_milestone_check'}, below)).decision).toBe('ask')
      }
    }
    let data: unknown
    if (e.tool === 'factory_events') data = {events: [], last_event: 1}
    else if (e.tool === 'work_orders') data = views.get(String(e.args.order).toLowerCase().replace('-', ''))
    else if (e.tool === 'needs_you') {
      const routes = [...views.values()].flatMap(v => v.milestones.map(m => m.check.route).filter((r): r is Route => !!r))
      const rows = (owner: string) => routes.filter(r => r.owner === owner).map(route => ({kind: 'milestone_check', route:fixture.attentionRoute(route), on_you: owner === 'person'}))
      data = {for_person: [...rows('person'), ...fixture.legacy], for_manager: rows('manager')}
      fixture.afterAttention()
    } else if (e.tool === 'claim_proof') {
      if (e.args.peek) {
        fixture.peeks++
        if (fixture.queue === 'unavailable') return {deny:'Temporary native queue transport failure.'} as never
        data = {waiting:fixture.queue === 'empty' ? [] : [{proof:701,repository:'acme/shop',commit:'a'.repeat(40),commands:['test']}]}
      } else {
        expect(e.args.proof).toBe(701)
        claims.push(701)
        expect(Object.values(fixture.ledger('wo46')!.recovery!)[0]!.native?.phase).toBe('submitted')
        if (fixture.loseProofReply) return {deny:'Native claim accepted; response lost.'} as never
        data = {proof:701, repository:{full_name:'acme/shop'}, expected_commit:'a'.repeat(40),
          token:'synthetic',report_url:'https://app.codebook.work/kanban/api/proof/report',
          recipe:{revision:1, install:'',network:'loopback'}, steps:[{run:701,name:'test',line:'node test.js',timeout_seconds:30,baseline:false}]}
      }
    } else if (e.tool === 'proof_result') {
      expect(e.args.factory).toBe(factory)
      expect(e.args.story).toBe('fixtureMember')
      data = fixture.receipt
    } else if (e.tool === 'list_my_work') {
      data = {work: [{story:'fixtureRepair', run:73, where:'here', claimed:false, factory:{factory}},{story:'fix-one', run:71, where:'here', claimed:false, factory:{factory}},
        {story:'unrelated', run:72, where:'here', claimed:false, factory:{factory}}]}
    } else if (e.tool === 'decide_milestone_check') {
      writes.push({...e.args})
      const ledger = fixture.ledger(String(e.args.order))
      expect(Object.values(ledger?.retries ?? {})[0]?.state).toBe('pending')
      if (fixture.lost) throw Error('lost response')
      data = {...e.args, requested_check: e.args.check, check: {id: 88}, started: {check_id: 88}}
    } else throw Error('Unexpected milestone transport: ' + e.tool)
    return {value: {structuredContent: data, content: []}} as never
  })
  if (ids.some(id => id.startsWith('R'))) {
    on('env.get', (_, e) => ({value:e.name === 'HOME' ? '/fixture' : '/usr/bin:/bin'}) as never)
    on('process.run', (_, e) => {
      const args = [...e.argv], command = args.join(' ')
      let stdout = ''
      if (command.includes('rev-parse --show-toplevel')) stdout = '/fixture/shop'
      else if (command.includes('remote get-url origin')) stdout = 'https://github.com/acme/shop.git'
      else if (command.includes('worktree list --porcelain')) stdout = 'worktree /fixture/shop\nHEAD '+ 'a'.repeat(40) +'\nbranch refs/heads/main\n'
      else if (command.includes('rev-parse HEAD')) stdout = 'a'.repeat(40)
      else if (args[0] === 'uname') stdout = 'Darwin'
      else if (command.includes('node test.js')) stdout = 'ok 1 - synthetic member test'
      return {value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}} as never
    })
    on('http.fetch', (_, e) => {
      reports.push(JSON.parse(String(e.init?.body ?? '{}')))
      return {value:{status:200,ok:true,headers:{},text:JSON.stringify({data:true,recorded:true,status:'passed',tests:1})}}
    })
  }
  on('prompt.submit', (_, e) => { prompts.push(e.text); return {text: e.text, context: e.context} as never })
  return fixture
}

test('Claude wakes follow the exact milestone route', async ($, on) => {
  const f = milestoneTransport(on, milestoneCases.filter(c => c.id.startsWith('F')).map(c => c.id))
  await $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  for (let i = 0; i < 16; i++) await f.clock.advance(35000)
  const questions = f.prompts.filter(text => text.includes('Ask the operator once'))
  expect(f.prompts.filter(t => t.includes('existing repair work')).length).toBe(1)
  expect(f.prompts.find(t => t.includes('existing repair work'))).toContain('fix-one (run 71)')
  expect(questions.length).toBe(1)
  expect(questions[0]).toContain('fixtureFactory / WO-36 (wo36), check #43')
  expect(f.writes).toEqual([{factory: 'fixtureFactory', order: 'wo37', check: 44, authority: 'manager', decision: 'retry', expected_policy: 'ask'}])
  expect(Object.values(f.ledger('wo37')!.retries)[0]?.state).toBe('confirmed')
  for (const [id, expected] of [['wo32','Repairs in progress'], ['wo33','Waiting for proof'], ['wo34','Held'], ['wo35','Factory rule applied'], ['wo36','Owner review'], ['wo37','Manager retry available'], ['wo38','Check settled']]) {
    const report = await $.command.run(typed('report fixtureFactory ' + id))
    expect(report.text).toContain(expected)
  }
  const waived = f.views.get('wo38')!.milestones[0]!
  waived.state = 'waived'
  expect((await $.command.run(typed('report fixtureFactory wo38'))).text).toContain('Passed by the owner')
  expect(f.writes.length).toBe(1)
})

test('repeated milestone wakes cannot replay a decision', async ($, on) => {
  const f = milestoneTransport(on, ['F5','F6'])
  f.lost = true
  const start = () => $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  await start()
  await Promise.all([f.clock.advance(35000), f.clock.advance(35000)])
  for (let i = 0; i < 4; i++) await f.clock.advance(35000)
  expect(f.writes.length).toBe(1)
  expect(Object.values(f.ledger('wo37')!.retries)[0]?.state).toBe('pending')
  await start()
  const human = f.views.get('wo36')!.milestones[0]!.check
  const route = human.route!
  human.route = {...route, owner:'none', action:'hold'}
  human.needs_person = false
  const retry = f.views.get('wo37')!.milestones[0]!.check
  const original = retry.route!
  retry.route = {...original, check: 88, action:'wait', owner:'none'}
  retry.latest.id = 88
  for (let i = 0; i < 3; i++) await f.clock.advance(35000)
  expect(Object.keys(f.ledger('wo36')!.questions)).toEqual([])
  expect(Object.values(f.ledger('wo37')!.retries)[0]?.state).toBe('pending')
  retry.history = [{id: 44, attempt: 1, decision: 'manager_retry', status:'fixed', decided_at: '2026-11-26', retry_note:'Repairs finished'}]
  human.route = {...route, check: 100}
  human.needs_person = true // A stale check ID does not open a replacement question.
  for (let i = 0; i < 3; i++) await f.clock.advance(35000)
  expect(Object.values(f.ledger('wo37')!.retries)[0]).toMatchObject({state:'confirmed', requested:44, check:88, actor:'manager', reason:'Repairs finished'})
  expect(f.prompts.filter(t => t.includes('Ask the operator')).length).toBe(1)
  human.latest.id = 100
  let changed = false
  f.afterAttention = () => {
    if (changed || retry.route?.action !== 'retry') return
    changed = true
    retry.route = {...original, check: 88, action:'hold', owner:'none'}
    retry.check_cannot_run = 'hold'
  }
  retry.route = {...original, check:88}
  for (let i = 0; i < 4; i++) await f.clock.advance(35000)
  expect(f.prompts.filter(t => t.includes('Ask the operator')).length).toBe(2)
  expect(f.writes.length).toBe(1)
})

test('legacy milestone attention must address the current operator and attempt', async ($, on) => {
  const f = milestoneTransport(on, ['F8'])
  const check = f.views.get('wo39')!.milestones[0]!.check
  check.needs_person = true
  const item = {kind: 'milestone_check', factory:'fixtureFactory', order:'wo39', check_id:70, on_you:false, why:'A recorded owner request'}
  f.legacy = [item]
  await $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  await f.clock.advance(35000)
  f.legacy = [{...item, on_you:true, check_id:61}]
  await f.clock.advance(35000)
  expect(f.prompts).toEqual([])
  f.legacy = [{...item, on_you:true}]
  await f.clock.advance(35000)
  await f.clock.advance(35000)
  expect(f.prompts.length).toBe(1)
  expect(f.prompts[0]).toContain('check #70')
  expect(f.writes).toEqual([])
})

test('Claude Auto mode reads only owned milestone attention before asking the exact owner', async ($, on) => {
  const f = milestoneTransport(on, ['F1', 'F2', 'F5'], true)
  // The repair has no available local fix run. The outstanding human request is the only wake.
  f.views.get('wo32')!.milestones[0]!.fixes = []
  await $.session.start({cwd: '/', surface: 'desktop', isInteractive: true})
  for (let i = 0; i < 6; i++) await f.clock.advance(35000)
  expect(f.checks).toContain('work_orders:allow')
  expect(f.checks).toContain('needs_you:allow')
  expect(f.prompts.length).toBe(1)
  expect(f.prompts[0]).toContain('fixtureFactory / WO-36 (wo36), check #43')
  expect(f.writes).toEqual([])
})

test('Claude and Codex follow the same authorized manager recovery target', async ($, on) => {
  const f = milestoneTransport(on, ['R1'], true)
  const start = () => $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  await start()
  for (let i=0; i<4; i++) await f.clock.advance(35000)
  expect(f.claims).toEqual([701])
  expect(f.reports).toMatchObject([{run:701,commit:'a'.repeat(40),exit_code:0}])
  const milestone = f.views.get('wo46')!.milestones[0]!
  const next = milestoneCases.find(c => c.id === 'R2')!.route as Route
  milestone.check.route = next
  milestone.fixes = [{item_id:502,check_id:61,card:{public_id:'fixtureRepair'}}]
  await f.clock.advance(35000)
  await start()
  await f.clock.advance(35000)
  expect(f.prompts.filter(t => t.includes('fixtureRepair (run 73)')).length).toBe(1)
  expect(f.prompts.some(t => t.includes('unrelated'))).toBe(false)
  expect(f.writes).toEqual([])
})

test('both local managers retry only the authorized current attempt', async ($, on) => {
  const f = milestoneTransport(on, ['F6'])
  const check = f.views.get('wo37')!.milestones[0]!.check
  check.check_cannot_run = 'manager_recovery'
  const retry = check.route!
  f.afterAttention = () => {
    check.route = {...retry,owner:'none',action:'hold',reason:'Connect the registered executor.'}
    f.afterAttention = () => {}
  }
  await $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  for (let i=0; i<3; i++) await f.clock.advance(35000)
  expect(f.writes).toEqual([])
  expect(Object.values(f.ledger('wo37')!.prerequisites!)).toEqual(['WO-37, check #44: Connect the registered executor.'])
  expect(f.prompts).toEqual([])
  check.route = retry
  await f.clock.advance(35000)
  await f.clock.advance(35000)
  expect(f.writes).toEqual([{factory:'fixtureFactory',order:'wo37',check:44,authority:'manager',decision:'retry',expected_policy:'manager_recovery'}])
})

test('manager recovery reconciles duplicate wakes and uncertain responses', async ($, on) => {
  const f = milestoneTransport(on, ['R3'])
  const start = () => $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  await start()
  await Promise.all([f.clock.advance(35000), f.clock.advance(35000)])
  const record = () => Object.values(f.ledger('wo46')!.recovery!)[0]!
  expect(record().state).toBe('pending')
  const check = f.views.get('wo46')!.milestones[0]!.check
  check.route = {...check.route!, owner:'none', action:'wait', recovery:undefined}
  const command = {run:702,name:'test',verified:true,status:'passed',commit:'b'.repeat(40)}
  f.receipt = {proof:702,finished:true,commands:[command]}
  await start()
  await f.clock.advance(35000)
  expect(record().state).toBe('pending')
  command.commit = 'a'.repeat(40)
  await f.clock.advance(35000)
  expect(record()).toMatchObject({state:'completed',check:61,target:{kind:'proof',proof:702,member_story:'fixtureMember',executor:'runner'}})
  expect(f.claims).toEqual([])
  expect(f.writes).toEqual([])
})

test('legacy and unknown milestone routes stay safe in both clients', async ($, on) => {
  const f = milestoneTransport(on, ['R1'])
  const check = f.views.get('wo46')!.milestones[0]!.check
  const route = check.route!
  check.check_cannot_run = 'unrecognized_policy'
  await $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  await f.clock.advance(35000)
  for (const policy of ['ask','hold','pass_on_story_tests']) {
    check.check_cannot_run = policy
    await f.clock.advance(35000)
  }
  check.check_cannot_run = 'manager_recovery'
  check.route = {...route,recovery:undefined}
  await f.clock.advance(35000)
  check.route = route
  f.attentionRoute = r => ({...r,recovery:{...r.recovery!,commit:'b'.repeat(40)}})
  await f.clock.advance(35000)
  expect(f.claims).toEqual([])
  expect(f.prompts).toEqual([])
  expect(f.writes).toEqual([])
  expect(f.ledger('wo46')?.recovery ?? {}).toEqual({})
})

test('a missed native proof queue recovers after restart with one exact claim', async ($, on) => {
  const f = milestoneTransport(on, ['R1'], true)
  const start = () => $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  f.queue = 'empty'
  await start()
  await f.clock.advance(35000)
  expect(f.peeks).toBe(1)
  expect(f.claims).toEqual([])
  expect(Object.values(f.ledger('wo46')!.recovery!)[0]!.native?.phase).toBe('preparing')
  f.queue = 'ready'
  await start()
  for (let i=0; i<5; i++) await f.clock.advance(35000)
  expect(f.peeks).toBe(2)
  expect(f.claims).toEqual([701])
  expect(f.reports).toMatchObject([{run:701,commit:'a'.repeat(40),exit_code:0}])
  expect(f.writes).toEqual([])
  expect(f.prompts).toEqual([])
})

test('temporary read failures back off and existing native claims stay with their owner', async ($, on) => {
  const f = milestoneTransport(on, ['R1'], true)
  const start = () => $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  f.queue = 'unavailable'
  await start()
  await f.clock.advance(35000)
  expect(f.peeks).toBe(1)
  await f.clock.advance(5000)
  expect(f.peeks).toBe(1)
  await start()
  await f.clock.advance(65000)
  expect(f.peeks).toBe(2)
  f.queue = 'ready'
  f.receipt = {proof:701,finished:false,commands:[{run:701,name:'test',status:'claimed'}]}
  for (let i=0; i<6; i++) await f.clock.advance(35000)
  expect(f.peeks).toBe(2)
  expect(f.claims).toEqual([])
  expect(f.prompts).toEqual([])
})

test('a lost native claim reply stays single flight across restart', async ($, on) => {
  const f = milestoneTransport(on, ['R1'], true)
  const start = () => $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  f.loseProofReply = true
  await start()
  await f.clock.advance(35000)
  expect(f.claims).toEqual([701])
  await start()
  for (let i=0; i<6; i++) await f.clock.advance(35000)
  expect(f.peeks).toBe(1)
  expect(f.claims).toEqual([701])
  expect(f.reports).toEqual([])
  f.receipt = {proof:701,finished:true,commands:[{run:701,name:'test',status:'passed',verified:true,commit:'a'.repeat(40)}]}
  await f.clock.advance(35000)
  expect(Object.values(f.ledger('wo46')!.recovery!)[0]!.state).toBe('completed')
})

test('a Claude subscription manages web-started stations only for its selected connection', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const factory = {factory: 'pay'}, workflow = {workflow: 'wf1', name: 'Ship'}
  const store = new Map<string, unknown>(), submitted: string[] = []
  let selected = false, subscription = false, beats = 0
  const source = {kind: 'claude_code', connection_id: 2}
  on('session.id', () => ({value:'paired-fixture'}))
  on('session.start', (_, e) => ({cwd:e.cwd}))
  on('ui.open', () => ({value:{isPlaced:true}}))
  on('command.register', () => ({value:{command:'factory'}}))
  on('store.keys', () => ({value:[...store.keys()]}))
  on('store.get', (_, e) => ({value:store.get(e.key)}))
  on('store.set', (_, e) => { store.set(e.key, e.value); return {value:undefined} })
  on('store.delete', (_, e) => { store.delete(e.key); return {value:undefined} })
  on('mcp.connect', () => ({value:{isConnected:true,server:'codebook'}}))
  on('process.run', (_, e) => {
    const auth = e.argv.join(' ') === 'claude auth status --json'
    const status = {loggedIn:true, authMethod:subscription ? 'claude.ai' : 'api-key', apiProvider:'firstParty', subscriptionType:'max'}
    return {value:{exitCode:auth ? 0 : 1, stdout:auth ? JSON.stringify(status) : '', stderr:'', isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('mcp.call', (_, e) => {
    let data: unknown
    if (e.tool === 'manager_brief') data = {factory, workflow, you:{may_run_here:true, local_harness:{version:1,register:'connect_factory_harness'}}, backlog:{stories:[]}}
    else if (e.tool === 'connect_factory_harness') {
      expect(e.args).toEqual({factory:'pay',kind:'claude_code',capabilities:['station']})
      beats++
      data = {registered:true,selected,source:selected ? source : {kind:'codex',connection_id:3}}
    } else if (e.tool === 'factory_events') data = {events:[],last_event:1}
    else if (e.tool === 'list_my_work') data = {work:[
      {story:'chosen',reference:'#7',run:77,claimed:false,where:'here',factory,workflow,execution_source:source},
      {story:'foreign',reference:'#8',run:78,claimed:false,where:'here',factory,workflow,execution_source:{...source,connection_id:4}},
    ]}
    else if (e.tool === 'story_status') data = {story:{story:e.args.story},factory,workflow,station:null, in_backlog:false,finished:null,
      run_location:{where:'here',execution_source:source}, run:{run:77,state:'with_outside_agent',where:'here'},
      waiting:{on:'runner',run:77,on_you:true,claimed:false},stations:[],events:[],last_event:1}
    else throw Error('Unexpected connector call: '+e.tool)
    return {value:{structuredContent:data,content:[]}} as never
  })
  on('prompt.submit', (_, e) => { submitted.push(e.text); return {text:e.text, context:e.context} as never })
  await $.session.start({cwd:'/',surface:'desktop',isInteractive:true})
  await $.command.run(typed('manage pay --workflow wf1'))
  await clock.advance(65000)
  expect(beats).toBe(0)
  expect(submitted.length).toBe(0)
  subscription = true
  await clock.advance(65000)
  expect(beats > 0).toBe(true)
  expect(submitted.length).toBe(0)
  selected = true
  await clock.advance(65000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#7 has local run 77')
  expect(submitted[0]).not.toContain('#8')
})
