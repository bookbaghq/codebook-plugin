// Read-only lifecycle observation. A wake asks the owning manager to check readiness; it grants no authority.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { CodebookContinuation, CodebookWorkflowWatch } from '../types'
import type { Status } from './factory'
import { call } from './connector'

export const CONTINUATION_STORE = 'continuation-1:'
const empty = (generation = 0): CodebookContinuation => ({ generation, stories: {}, orders: {}, feeds: {}, pending: {}, nextFactory: 0, nextOrder: 0, checkedAt: 0 })
const state = atom({ plugin: 'codebook', key: 'continuation' } as const, empty(), { shape: 'continuation-1' })
const MAX_STORIES = 200
const MAX_ORDERS = 40
const QUIET_MS = 30000
let saving = Promise.resolve()
let polling = false
let flushing = false

async function save($: EngineInterface, generation: number): Promise<void> {
  // Serialize storage writes so an older observation cannot overwrite a later stop.
  saving = saving.catch(() => {}).then(async () => {
    const key = CONTINUATION_STORE + await $.session.id(), now = await $.clock.now()
    const current = await read($, state)
    if (current.generation !== generation) return
    if (!current.manager && !Object.keys(current.stories).length && !Object.keys(current.orders).length && !Object.keys(current.pending).length) await $.store.delete(key)
    else await $.store.set(key, { at: now, value: current })
  })
  await saving
}

export async function continuationGeneration($: EngineInterface): Promise<number> { return (await read($, state)).generation }
export async function continuationCurrent($: EngineInterface, generation: number): Promise<boolean> { return (await continuationGeneration($)) === generation }
export async function hasContinuation($: EngineInterface): Promise<boolean> {
  const current = await read($, state)
  return !!current.manager || Object.keys(current.stories).length > 0 || Object.keys(current.orders).length > 0 || Object.keys(current.pending).length > 0
}

export async function restoreContinuation($: EngineInterface, generation: number): Promise<void> {
  const kept = await $.store.get(CONTINUATION_STORE + await $.session.id()) as { at?: number; value?: CodebookContinuation } | undefined
  if (typeof kept?.at === 'number' && kept.at > await $.clock.now() - 30 * 24 * 3600 * 1000 && kept.value?.stories && kept.value.orders && kept.value.pending) {
    const restored = kept.value
    await update($, state, current => {
      if (current.generation !== generation) return current
      return { ...restored, generation, checkedAt: 0, ...(restored.manager && { manager: { ...restored.manager, scannedAt: 0, offset: 0, seen: [] } }) }
    })
  }
}

type ManagerBrief = {
  factory?: { factory: string }
  workflow?: { workflow: string; name: string }
  you?: { may_run_here?: boolean; run_here_refusal?: string }
  backlog?: { next_offset?: number | null; stories?: { story: string; reference?: string; workflow: string; ready: boolean; start_with?: string }[] }
}

export const manageUsage = '/factory manage <factory> [--workflow <name or ID>]'

function observeReady(next: CodebookContinuation, watch: CodebookWorkflowWatch, brief: ManagerBrief, now: number): void {
  const seen = new Set(watch.seen)
  // Older checkpoints kept a single sentence containing the references that had failed to deliver.
  const prefix = `Independent backlog work is ready in ${watch.name} (${watch.factory}, ${watch.workflow}): `
  const suffix = '. Read the current manager brief and its readiness pages.'
  const legacy = next.pending.workflow
  const previous = legacy?.startsWith(prefix) && legacy.endsWith(suffix)
    ? legacy.slice(prefix.length, -suffix.length).split(', ') : []
  for (const row of brief.backlog?.stories ?? []) {
    if (!row.ready || !row.start_with || row.workflow !== watch.name) continue
    const label = row.reference || row.story
    if ((!watch.ready.includes(row.story) && !seen.has(row.story)) || previous.includes(label)) {
      next.pending[`workflow:${row.story}`] = prefix + label + suffix
    }
    seen.add(row.story)
  }
  const offset = brief.backlog?.next_offset
  watch.offset = typeof offset === 'number' && offset > watch.offset ? offset : 0
  watch.seen = watch.offset ? [...seen] : []
  if (!watch.offset) {
    delete next.pending.workflow
    for (const key of Object.keys(next.pending)) {
      if (key.startsWith('workflow:') && !seen.has(key.slice('workflow:'.length))) delete next.pending[key]
    }
    watch.ready = [...seen]
    watch.scannedAt = now
  }
}

export async function watchWorkflow($: EngineInterface, words: string[]): Promise<string> {
  const option = words.indexOf('--workflow'), factory = words.slice(0, option < 0 ? words.length : option).join(' ')
  if (!factory || words.some(word => word.startsWith('--') && word !== '--workflow') ||
      (option >= 0 && (option !== words.lastIndexOf('--workflow') || !words[option + 1]))) return 'Usage: ' + manageUsage
  const workflow = option < 0 ? undefined : words.slice(option + 1).join(' ')
  const generation = await continuationGeneration($)
  const got = await call<ManagerBrief>($, 'manager_brief', { factory, ...(workflow && { workflow }) })
  if (!got.ok) return got.message
  const brief = got.data
  if (!brief.factory?.factory || !brief.workflow?.workflow || !Array.isArray(brief.backlog?.stories) || !brief.you?.may_run_here)
    return brief.you?.run_here_refusal || 'CodeBook did not grant Run here access and return readiness for this workflow.'
  const selected = brief.workflow, id = brief.factory.factory, now = await $.clock.now()
  await update($, state, current => {
    if (current.generation !== generation || current.manager) return current
    const next = structuredClone(current)
    next.manager = { factory: id, workflow: selected.workflow, name: selected.name, cursor: 0, scannedAt: 0, offset: 0, ready: [], seen: [] }
    observeReady(next, next.manager, brief, now)
    return next
  })
  await save($, generation)
  const watch = (await read($, state)).manager
  if (!watch) return 'The workflow watch was stopped.'
  if (watch.factory !== id || watch.workflow !== selected.workflow) return 'This session already watches a different workflow. Use /factory stop before changing workflows.'
  return `Watching ${watch.name} (${watch.factory}, ${watch.workflow}) for local manager work. Use /factory stop to stop watching.`
}

export async function workflowStatus($: EngineInterface): Promise<string> {
  const current = await read($, state), watch = current.manager
  const checked = current.checkedAt ? new Date(current.checkedAt).toISOString() : 'awaiting first poll'
  const readError = watch?.readError ? ` Last readiness read failed (${watch.readError}).` : ''
  const delivery = current.deliveryFailures ? ` Last prompt submission failed. Retry after ${new Date(current.retryAt ?? 0).toISOString()}.` : ''
  return watch ? `Watching workflow ${watch.name} (${watch.factory}, ${watch.workflow}) for local manager work. Last poll: ${checked}. Pending notices: ${Object.keys(current.pending).length}.${readError}${delivery}` : ''
}

export async function stopContinuation($: EngineInterface): Promise<void> {
  await update($, state, current => empty(current.generation + 1))
  await save($, await continuationGeneration($))
}

export async function watchContinuation($: EngineInterface, story: string, reference: string, factory: string, fresh: boolean, generation: number): Promise<void> {
  await update($, state, current => {
    if (current.generation !== generation || current.stories[story] || Object.keys(current.stories).length >= MAX_STORIES) return current
    return { ...current, stories: { ...current.stories, [story]: { factory, reference, order: null, state: fresh ? 'moving' : null, event: 0 } } }
  })
  await save($, generation)
}

/** Only a successful confirmation in this session establishes ownership of this proposal. */
export async function adoptContinuation($: EngineInterface, data: unknown, generation: number): Promise<void> {
  const result = data as { proposal?: { proposal?: string; reference?: string }; created?: { story: string; reference: string }[] } | null
  if (!result?.created?.length) return
  await update($, state, current => {
    if (current.generation !== generation) return current
    const next = { ...current, stories: { ...current.stories }, orders: { ...current.orders } }
    const id = result.proposal?.proposal, reference = result.proposal?.reference
    const order = typeof id === 'string' && typeof reference === 'string' && (next.orders[id] || Object.keys(next.orders).length < MAX_ORDERS) ? id : null
    if (order && !next.orders[order]) next.orders[order] = { factory: '', reference: reference!, passes: null }
    for (const one of result.created!) {
      if (!one.story || !one.reference || (!next.stories[one.story] && Object.keys(next.stories).length >= MAX_STORIES)) continue
      next.stories[one.story] = { factory: '', reference: one.reference, state: 'moving', event: 0, ...next.stories[one.story], order }
    }
    return next
  })
  await save($, generation)
}

function notice(current: CodebookContinuation, story: string, outcome: string): void {
  const one = current.stories[story]
  if (!one || outcome === one.state) return
  current.pending[`story:${story}`] = outcome.startsWith('blocked')
    ? `${one.reference} is blocked; inspect independent ready work.`
    : `${one.reference} ${outcome === 'dropped' ? 'was dropped' : 'finished'}.`
  one.state = outcome
}

/** Called only for an explicitly followed story; arbitrary read calls do not adopt ownership. */
export async function observeContinuation($: EngineInterface, story: string, status: Status, generation: number): Promise<void> {
  await update($, state, current => {
    if (current.generation !== generation || !current.stories[story]) return current
    const next = structuredClone(current), one = next.stories[story]!
    one.factory = status.factory.factory
    if (one.order && next.orders[one.order]) next.orders[one.order]!.factory = one.factory
    const outcome = status.finished || (status.run?.state === 'blocked' ? `blocked:${status.run.run}` : null)
    const watch = next.manager, waiting = status.waiting
    if (watch && watch.factory === one.factory && watch.workflow === status.workflow?.workflow) {
      const readyRun = !outcome && status.run?.where === 'here' && waiting?.on === 'runner' && waiting.on_you === true &&
        waiting.claimed === false && status.run.run === waiting.run ? waiting.run : undefined
      if (readyRun && readyRun !== one.waitingRun) next.pending[`runner:${story}`] = `${one.reference} has local run ${readyRun} waiting for its owner.`
      if (!readyRun) delete next.pending[`runner:${story}`]
      one.waitingRun = readyRun
    }
    const initialized = one.state !== null
    for (const event of status.events ?? []) {
      if (event.id <= one.event) continue
      if (initialized && event.kind === 'run.blocked') notice(next, story, `blocked:${event.run ?? status.run?.run ?? event.id}`)
      one.event = Math.max(one.event, event.id)
    }
    if (outcome) {
      if (initialized) notice(next, story, outcome)
      else one.state = outcome
    } else if (!one.state?.startsWith('blocked') || status.run?.run !== Number(one.state.split(':')[1])) one.state = 'moving'
    one.event = Math.max(one.event, status.last_event ?? 0)
    // The separate order watch survives this story; completed cards need no continuing feed subscription.
    if (status.finished) delete next.stories[story]
    return next
  })
  await save($, generation)
}

type Feed = { events?: { id: number; kind: string; outcome?: string; run?: number; card?: { key?: string }; work_order?: { reference?: string } }[]; last_event?: number | null }
type ReadFailure = { ok: false; code: string; message: string; isSignIn: boolean }
type Order = { order?: string; work_order?: { reference?: string; status?: string }; milestones?: { milestone: number; state?: string; check?: { latest?: { id?: number; status?: string } | null } | null }[] }

// Read the most recent event, not the event history. A changed cursor asks for current readiness.
// Reconcile periodically as well: operator actions on older servers need not emit an event.
async function pollWorkflow($: EngineInterface, before: CodebookContinuation, now: number): Promise<ReadFailure | void> {
  const watch = before.manager
  if (!watch) return
  const args = { factory: watch.factory, workflow: watch.workflow }
  const feed = await call<Feed>($, 'factory_events', { ...args, limit: 1, kinds: ['card.created', 'card.moved', 'card.finished', 'work_order.created', 'work_order.replanned', 'work_order.milestone_failed', 'work_order.milestone_passed'] })
  if (!feed.ok) return feed
  const cursor = feed.data.last_event ?? 0
  if (!watch.offset && watch.scannedAt && cursor === watch.cursor && now - watch.scannedAt < 300000) return
  if (!await continuationCurrent($, before.generation)) return
  const got = await call<ManagerBrief>($, 'manager_brief', { ...args, ...(watch.offset > 0 && { backlog_offset: watch.offset }) })
  if (!got.ok) return got
  if (got.data.factory?.factory !== watch.factory || got.data.workflow?.workflow !== watch.workflow || !Array.isArray(got.data.backlog?.stories)) return
  let persist = false
  await update($, state, current => {
    if (current.generation !== before.generation || !current.manager) return current
    const next = structuredClone(current), manager = next.manager!
    if (!got.data.you?.may_run_here) {
      for (const key of Object.keys(next.pending)) {
        if (key === 'workflow' || key.startsWith('workflow:')) delete next.pending[key]
      }
      manager.ready = []
      manager.seen = []
      manager.offset = 0
      manager.scannedAt = now
    } else observeReady(next, manager, got.data, now)
    manager.cursor = cursor
    // A resume always scans again from page one. In-memory scan timing and partial pages need no checkpoint.
    persist = current.manager.cursor !== cursor || JSON.stringify(current.manager.ready) !== JSON.stringify(manager.ready)
      || JSON.stringify(current.pending) !== JSON.stringify(next.pending)
    return next
  })
  if (persist) await save($, before.generation)
}

/** One page and one owned-order snapshot per quiet interval, round robin. No catch-up loop or model on empty reads. */
export async function pollContinuation($: EngineInterface): Promise<ReadFailure | void> {
  if (polling) return
  const before = await read($, state), now = await $.clock.now()
  if (before.checkedAt && now - before.checkedAt < QUIET_MS) return
  const factories = [...new Set([...Object.values(before.stories), ...Object.values(before.orders)].map(one => one.factory).filter(Boolean))]
  if (!factories.length && !before.manager) return
  polling = true
  const generation = before.generation
  try {
    const factory = factories.length ? factories[before.nextFactory % factories.length] : undefined
    await update($, state, current => current.generation === generation ? { ...current, checkedAt: now, nextFactory: current.nextFactory + 1 } : current)
    const workflowFailure = await pollWorkflow($, before, now) || undefined
    if (!await continuationCurrent($, generation)) return
    if (before.manager && before.manager.readError !== workflowFailure?.code) {
      await update($, state, current => current.generation === generation && current.manager
        ? { ...current, manager: { ...current.manager, readError: workflowFailure?.code } } : current)
      await save($, generation)
    }
    if (!factory) return workflowFailure
    const feed = await call<Feed>($, 'factory_events', { factory, after: before.feeds[factory] ?? 0, limit: 50 })
    let failure: ReadFailure | undefined = feed.ok ? workflowFailure || undefined : feed
    if (!await continuationCurrent($, generation)) return
    if (feed.ok) await update($, state, current => {
      const next = structuredClone(current)
      if (next.generation !== generation) return current
      for (const event of feed.data.events ?? []) {
        const story = event.card?.key, owned = story ? next.stories[story] : null
        if (!story || !owned || owned.factory !== factory || event.id <= owned.event) continue
        // On first observation, baseline historical events; status reads detect current transitions.
        if (owned.state !== null) {
          if (event.kind === 'card.finished') { notice(next, story, event.outcome === 'dropped' ? 'dropped' : 'done'); delete next.stories[story] }
          if (event.kind === 'run.blocked') notice(next, story, `blocked:${event.run ?? event.id}`)
        }
        owned.event = Math.max(owned.event, event.id)
      }
      next.feeds[factory] = Math.max(next.feeds[factory] ?? 0, feed.data.last_event ?? 0)
      return next
    })
    // A current snapshot also covers events missed while offline and late milestones after story polling ends.
    const current = await read($, state), orders = Object.entries(current.orders).filter(([, order]) => order.factory)
    const entry = orders[current.nextOrder % Math.max(1, orders.length)]
    if (entry) {
      const [id, owned] = entry
      await update($, state, value => value.generation === generation ? { ...value, nextOrder: value.nextOrder + 1 } : value)
      const got = await call<Order>($, 'work_orders', { factory: owned.factory, order: id })
      if (!got.ok) failure = got
      if (!await continuationCurrent($, generation)) return
      if (got.ok && got.data.work_order?.reference === owned.reference && Array.isArray(got.data.milestones)) await update($, state, value => {
        if (value.generation !== generation || !value.orders[id]) return value
        const next = structuredClone(value), order = next.orders[id]!
        const passes = got.data.milestones!.filter(m => ['passed', 'waived', 'ruled'].includes(m.state ?? ''))
          .map(m => `${m.milestone}:${m.check?.latest?.id ?? m.state}`)
        // Confirmation owns the whole plan, so a pass seen on the first read may already have unlocked its next items.
        const added = passes.filter(pass => !(order.passes ?? []).includes(pass))
        if (added.length) next.pending[`order:${id}`] = `${order.reference} milestone ${added.map(pass => pass.split(':')[0]).join(', ')} passed; inspect its next eligible work.`
        order.passes = [...new Set([...(order.passes ?? []), ...passes])].slice(-100)
        if (['done', 'cancelled'].includes(got.data.work_order!.status ?? '')) {
          delete next.orders[id]
          for (const [key, story] of Object.entries(next.stories)) if (story.order === id) delete next.stories[key]
        }
        const liveFactories = new Set([...Object.values(next.stories), ...Object.values(next.orders)].map(one => one.factory))
        for (const name of Object.keys(next.feeds)) if (!liveFactories.has(name)) delete next.feeds[name]
        return next
      })
    }
    await save($, generation)
    if (await continuationCurrent($, generation)) return failure
  } finally { polling = false }
}

/** Keep notices until the host accepts the prompt. A persisted delay bounds retries across a restart. */
export async function flushContinuation($: EngineInterface): Promise<boolean> {
  if (flushing) return false
  flushing = true
  try {
    const before = await read($, state), now = await $.clock.now(), generation = before.generation
    const entries = Object.entries(before.pending).filter(([key]) => {
      if (key === 'workflow') return false // Reconcile a legacy sentence into current story identities first.
      if (!key.startsWith('workflow:')) return true
      const watch = before.manager
      return watch && !watch.readError && !watch.offset && watch.scannedAt > 0 && watch.ready.includes(key.slice('workflow:'.length))
    })
    if (!entries.length || (before.retryAt ?? 0) > now) return false
    const lines = entries.map(([, line]) => line)
    const failures = Math.min(before.deliveryFailures ?? 0, 5)
    const retryAt = now + Math.min(QUIET_MS * 2 ** failures, 15 * 60000)
    await update($, state, current => current.generation === before.generation ? { ...current, retryAt } : current)
    await save($, generation)
    if (!await continuationCurrent($, before.generation)) return false
    const text = `CodeBook: ${lines.slice(0, 8).join(' ')}${lines.length > 8 ? ` ${lines.length - 8} other owned stories/orders changed.` : ''} ` +
      'Use the codebook:factory-manager skill: inspect this session\'s queued runs first, open proposals and the separate Backlog, then continue eligible authorized work. ' +
      'Preserve current approvals, capacity, budgets and deadlines; suggest policy still asks before new unapproved stories. Leave other sessions\' work alone. ' +
      (before.manager ? 'Use Run here only. Check current readiness and ownership before acting. ' : '') +
      'Keep true blockers visible, inspect independent ready work, and do not repeat unchanged blocked tests or proof requests. This notice grants no approval to claim, confirm, merge or change settings.'
    try {
      await $.prompt.submit({ text })
    } catch {
      await update($, state, current => current.generation === before.generation ? { ...current, deliveryFailures: failures + 1 } : current)
      await save($, generation)
      return false
    }
    await update($, state, current => {
      if (current.generation !== before.generation) return current
      const pending = { ...current.pending }
      for (const [key, line] of entries) if (pending[key] === line) delete pending[key]
      return { ...current, pending, retryAt: 0, deliveryFailures: 0 }
    })
    await save($, generation)
    return true
  } finally { flushing = false }
}
