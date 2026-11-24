// Read-only lifecycle observation. A wake asks the owning manager to check readiness; it grants no authority.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { CodebookContinuation } from '../types'
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

async function save($: EngineInterface): Promise<void> {
  // Serialize storage writes so an older observation cannot overwrite a later stop.
  saving = saving.catch(() => {}).then(async () => {
    const current = await read($, state)
    const key = CONTINUATION_STORE + await $.session.id()
    if (!Object.keys(current.stories).length && !Object.keys(current.orders).length && !Object.keys(current.pending).length) await $.store.delete(key)
    else await $.store.set(key, { at: await $.clock.now(), value: current })
  })
  await saving
}

export async function continuationGeneration($: EngineInterface): Promise<number> { return (await read($, state)).generation }
export async function continuationCurrent($: EngineInterface, generation: number): Promise<boolean> { return (await continuationGeneration($)) === generation }
export async function hasContinuation($: EngineInterface): Promise<boolean> {
  const current = await read($, state)
  return Object.keys(current.stories).length > 0 || Object.keys(current.orders).length > 0 || Object.keys(current.pending).length > 0
}

export async function restoreContinuation($: EngineInterface): Promise<void> {
  const kept = await $.store.get(CONTINUATION_STORE + await $.session.id()) as { at?: number; value?: CodebookContinuation } | undefined
  if (typeof kept?.at === 'number' && kept.at > await $.clock.now() - 30 * 24 * 3600 * 1000 && kept.value?.stories && kept.value.orders && kept.value.pending) {
    await update($, state, () => ({ ...kept.value!, checkedAt: 0 }))
  }
}

export async function stopContinuation($: EngineInterface): Promise<void> {
  await update($, state, current => empty(current.generation + 1))
  await save($)
}

export async function watchContinuation($: EngineInterface, story: string, reference: string, factory = '', fresh = false): Promise<void> {
  await update($, state, current => {
    if (current.stories[story] || Object.keys(current.stories).length >= MAX_STORIES) return current
    return { ...current, stories: { ...current.stories, [story]: { factory, reference, order: null, state: fresh ? 'moving' : null, event: 0 } } }
  })
  await save($)
}

/** Only a successful confirmation in this session establishes ownership of this proposal. */
export async function adoptContinuation($: EngineInterface, data: unknown): Promise<void> {
  const result = data as { proposal?: { proposal?: string; reference?: string }; created?: { story: string; reference: string }[] } | null
  if (!result?.created?.length) return
  await update($, state, current => {
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
  await save($)
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
  await save($)
}

type Feed = { events?: { id: number; kind: string; outcome?: string; run?: number; card?: { key?: string }; work_order?: { reference?: string } }[]; last_event?: number | null }
type ReadFailure = { ok: false; message: string; isSignIn: boolean }
type Order = { order?: string; work_order?: { reference?: string; status?: string }; milestones?: { milestone: number; state?: string; check?: { latest?: { id?: number; status?: string } | null } | null }[] }

/** One page and one owned-order snapshot per quiet interval, round robin. No catch-up loop or model on empty reads. */
export async function pollContinuation($: EngineInterface): Promise<ReadFailure | void> {
  if (polling) return
  const before = await read($, state), now = await $.clock.now()
  if (before.checkedAt && now - before.checkedAt < QUIET_MS) return
  const factories = [...new Set([...Object.values(before.stories), ...Object.values(before.orders)].map(one => one.factory).filter(Boolean))]
  if (!factories.length) return
  polling = true
  const generation = before.generation
  try {
    const factory = factories[before.nextFactory % factories.length]!
    await update($, state, current => current.generation === generation ? { ...current, checkedAt: now, nextFactory: current.nextFactory + 1 } : current)
    const feed = await call<Feed>($, 'factory_events', { factory, after: before.feeds[factory] ?? 0, limit: 50 })
    let failure: ReadFailure | undefined = feed.ok ? undefined : feed
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
    await save($)
    if (await continuationCurrent($, generation)) return failure
  } finally { polling = false }
}

/** Only the timer calls this. Consume once before submit; an uncertain submission never causes a retry storm. */
export async function flushContinuation($: EngineInterface): Promise<boolean> {
  if (flushing) return false
  flushing = true
  try {
    const before = await read($, state), lines = Object.values(before.pending)
    if (!lines.length) return false
    await update($, state, current => {
      if (current.generation !== before.generation) return current
      const pending = { ...current.pending }
      for (const [key, line] of Object.entries(before.pending)) if (pending[key] === line) delete pending[key]
      return { ...current, pending }
    })
    await save($)
    if (!await continuationCurrent($, before.generation)) return false
    const text = `CodeBook: ${lines.slice(0, 8).join(' ')}${lines.length > 8 ? ` ${lines.length - 8} other owned stories/orders changed.` : ''} ` +
      'Use the codebook:factory-manager skill: inspect this session\'s queued runs first, open proposals and the separate Backlog, then continue eligible authorized work. ' +
      'Preserve current approvals, capacity, budgets and deadlines; suggest policy still asks before new unapproved stories. Leave other sessions\' work alone. ' +
      'Keep true blockers visible, inspect independent ready work, and do not repeat unchanged blocked tests or proof requests. This notice grants no approval to claim, confirm, merge or change settings.'
    void $.prompt.submit({ text }).catch(() => {})
    return true
  } finally { flushing = false }
}
