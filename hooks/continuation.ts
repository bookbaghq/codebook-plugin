// Observe owned work. A manager retry requires independent, current CodeBook authority for that attempt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { CodebookContinuation, CodebookWorkflowWatch } from '../types'
import type { Status } from './factory'
import { call } from './connector'
import { blankJournal, confirmedRetry, decisions, proofOutcome, recoverRetries } from './milestone'
import type { Needs, OrderView, ProofResult, Recovery, RecoveryRecord } from './milestone'

export const CONTINUATION_STORE = 'continuation-1:'
const empty = (generation = 0): CodebookContinuation => ({ generation, stories: {}, orders: {}, feeds: {}, pending: {}, nextFactory: 0, nextOrder: 0, checkedAt: 0 })
const state = atom({ plugin: 'codebook', key: 'continuation' } as const, empty(), { shape: 'continuation-1' })
const MAX_STORIES = 200
const MAX_ORDERS = 40
const QUIET_MS = 30000
const MAX_CHECKPOINT_AGE_MS = 30 * 24 * 3600 * 1000
let saving = Promise.resolve()
let polling = false
const NOTICE_BATCH = 8
type Delivery = 'completion' | 'current'
const flushing = new Set<Delivery>()
let lastBackgroundStory: string | undefined
let previousCheckpoint: { key: string; value: string | null } | undefined

// These counters schedule work in this process. A resumed manager reconciles from the first page.
function checkpoint(current: CodebookContinuation): CodebookContinuation {
  return { ...current, checkedAt: 0, nextOrder: 0, nextFactory: 0,
    ...(current.manager && { manager: { ...current.manager, offset: 0, seen: [], scannedAt: 0, harnessReadyAt: 0 } }) }
}

async function save($: EngineInterface, generation: number): Promise<void> {
  // Serialize storage writes so an older observation cannot overwrite a later stop.
  saving = saving.catch(() => {}).then(async () => {
    const key = CONTINUATION_STORE + await $.session.id(), now = await $.clock.now()
    const current = await read($, state)
    if (current.generation !== generation) return
    const value = !current.manager && !Object.keys(current.stories).length && !Object.keys(current.orders).length && !Object.keys(current.pending).length
      ? null : checkpoint(current)
    const signature = value ? JSON.stringify(value) : null
    if (previousCheckpoint?.key === key && previousCheckpoint.value === signature) return
    if (value) await $.store.set(key, { at: now, value })
    else await $.store.delete(key)
    previousCheckpoint = { key, value: signature }
  })
  await saving
}

export async function continuationGeneration($: EngineInterface): Promise<number> { return (await read($, state)).generation }
export async function continuationCurrent($: EngineInterface, generation: number): Promise<boolean> { return (await continuationGeneration($)) === generation }
export async function hasContinuation($: EngineInterface): Promise<boolean> {
  const current = await read($, state)
  return !!current.manager || Object.keys(current.stories).length > 0 || Object.keys(current.orders).length > 0 || Object.keys(current.pending).length > 0
}

/** A timer may read milestone attention only for the factory of an order owned by this session. */
export async function ownsMilestoneRead($: EngineInterface, tool: string, input: unknown): Promise<boolean> {
  if (!input || typeof input !== 'object' || !('factory' in input) || typeof input.factory !== 'string') return false
  const keys = Object.keys(input).sort().join(',')
  if (tool === 'needs_you' ? keys !== 'factory' : tool !== 'proof_result' || keys !== 'factory,proof,story') return false
  const saved = await $.store.get(CONTINUATION_STORE + await $.session.id()) as {at?: number; value?: CodebookContinuation} | undefined
  if (typeof saved?.at !== 'number' || saved.at <= await $.clock.now() - MAX_CHECKPOINT_AGE_MS) return false
  const orders = Object.values(saved.value?.orders ?? {}).filter(order => order.factory === input.factory)
  if (tool === 'needs_you') return orders.length > 0
  if (!('proof' in input) || !('story' in input)) return false
  return orders.some(order => Object.values(order.milestones?.recovery ?? {}).some(({target}) =>
    target.kind === 'proof' && target.proof === input.proof && target.member_story === input.story))
}

export async function restoreContinuation($: EngineInterface, generation: number): Promise<void> {
  const key = CONTINUATION_STORE + await $.session.id()
  const kept = await $.store.get(key) as { at?: number; value?: CodebookContinuation } | undefined
  if (typeof kept?.at === 'number' && kept.at > await $.clock.now() - MAX_CHECKPOINT_AGE_MS && kept.value?.stories && kept.value.orders && kept.value.pending) {
    const restored = kept.value
    previousCheckpoint = { key, value: JSON.stringify(checkpoint(restored)) }
    await update($, state, current => {
      if (current.generation !== generation) return current
      // Earlier checkpoints keyed both terminal and blocked notices by story and shared a retry deadline.
      let migrated = false
      const pending = Object.fromEntries(Object.entries(restored.pending).map(([key, line]) => {
        if (key.startsWith('story:') && (line.endsWith(' finished.') || line.endsWith(' was dropped.'))) {
          migrated = true
          return ['completion:' + key.slice('story:'.length), line]
        }
        return [key, line]
      }))
      return { ...restored, pending, generation, checkedAt: 0,
        ...(migrated && { completionRetryAt: restored.retryAt, completionFailures: restored.deliveryFailures }),
        ...(restored.manager && { manager: { ...restored.manager, scannedAt: 0, offset: 0, seen: [] } }) }
    })
  }
}

type ManagerBrief = {
  factory?: { factory: string; name?: string }
  workflow?: { workflow: string; name: string }
  you?: { may_run_here?: boolean; run_here_refusal?: string; local_harness?: {version: number; register: string} }
  backlog?: { next_offset?: number | null; stories?: { story: string; reference?: string; workflow: string; ready: boolean; start_with?: string }[] }
}

export const manageUsage = '/factory manage <factory> [--workflow <name or ID>]'

function observeReady(next: CodebookContinuation, watch: CodebookWorkflowWatch, brief: ManagerBrief, now: number): void {
  if (brief.you?.local_harness) {
    watch.registerHarness = brief.you.local_harness.version === 1 && brief.you.local_harness.register === 'connect_factory_harness'
  }
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

/** Why a watch cannot start, naming the one thing the brief lacks (#293); null when nothing is missing. */
function cannotWatch(brief: ManagerBrief | null, factory: string, workflow: string | undefined): string | null {
  const said = `CodeBook's answer for "${factory}"`
  if (!brief || typeof brief !== 'object') return `${said} was empty, so there is no factory to watch.`
  // The server's own sentence comes first: it says why, and what to do about it.
  if (brief.you?.run_here_refusal) return brief.you.run_here_refusal
  if (!brief.factory?.factory) return `CodeBook did not find the factory "${factory}": its answer names no factory. /factory list shows the names and IDs you can use.`
  const name = brief.factory.name || brief.factory.factory
  if (!brief.workflow?.workflow) {
    return `${name} has no workflow${workflow ? ` "${workflow}"` : ''} in CodeBook's answer, so there are no stations to watch here.`
  }
  if (!brief.you) return `${said} does not say what you may do in ${name} (it has no "you" part), so Run here was not granted.`
  if (!brief.you.may_run_here) {
    return `CodeBook does not let you run ${name}'s work here, and gave no reason: you may read this factory but not start its stories. Ask an owner of its workspace for write access.`
  }
  if (!Array.isArray(brief.backlog?.stories)) return `${said} has no backlog list for ${brief.workflow.name || brief.workflow.workflow}, so there is no readiness to watch.`
  return null
}

export async function watchWorkflow($: EngineInterface, words: string[]): Promise<string> {
  const option = words.indexOf('--workflow'), factory = words.slice(0, option < 0 ? words.length : option).join(' ')
  if (!factory || words.some(word => word.startsWith('--') && word !== '--workflow') ||
      (option >= 0 && (option !== words.lastIndexOf('--workflow') || !words[option + 1]))) return 'Usage: ' + manageUsage
  const workflow = option < 0 ? undefined : words.slice(option + 1).join(' ')
  const generation = await continuationGeneration($)
  // The start check needs to know that there is a backlog, not to read a page of it: the watch's polls read the pages.
  const got = await call<ManagerBrief>($, 'manager_brief', { factory, ...(workflow && { workflow }), backlog_limit: 1 })
  if (!got.ok) return got.message
  const missing = cannotWatch(got.data, factory, workflow)
  if (missing !== null) return missing
  // cannotWatch found a factory and a workflow in it.
  const brief = got.data as ManagerBrief & Required<Pick<ManagerBrief, 'factory' | 'workflow'>>
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
  const readError = watch?.readError ? ` Last readiness read failed (${watch.readError}).`
    : watch?.registerHarness !== undefined && !watch.harnessReadyAt ? ' Waiting for a selected, signed-in local subscription.' : ''
  const retry = Math.min(current.deliveryFailures ? current.retryAt ?? 0 : Infinity,
    current.completionFailures ? current.completionRetryAt ?? 0 : Infinity)
  const delivery = Number.isFinite(retry) ? ` Last prompt submission failed. Retry after ${new Date(retry).toISOString()}.` : ''
  const questions = Object.values(current.orders).flatMap(order => Object.values(order.milestones?.questions ?? {})).join('\n')
  const watching = watch ? `Watching workflow ${watch.name} (${watch.factory}, ${watch.workflow}) for local manager work. Last poll: ${checked}. Pending notices: ${Object.keys(current.pending).length}.${readError}${delivery}` : ''
  const recovery = Object.values(current.orders).flatMap(order => [
    ...Object.values(order.milestones?.prerequisites ?? {}),
    ...Object.values(order.milestones?.recovery ?? {}).filter(r => r.state === 'pending' && r.current !== false).map(r => r.note),
  ]).join('\n')
  return [watching, questions, recovery].filter(Boolean).join('\n')
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

function boardOnlyWait(status: Status): boolean {
  return status.waiting?.delivery === 'board_only' || (typeof status.question === 'object' && status.question?.delivery === 'board_only')
}

function notice(current: CodebookContinuation, story: string, outcome: string): void {
  const one = current.stories[story]
  if (!one || outcome === one.state) return
  if (outcome.startsWith('blocked')) {
    current.pending[`story:${story}`] = `${one.reference} is blocked; inspect independent ready work.`
  } else {
    delete current.pending[`story:${story}`]
    current.pending[`completion:${story}`] = `${one.reference} ${outcome === 'dropped' ? 'was dropped' : 'finished'}.`
  }
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
      const readyRun = !outcome && claudeSource(status.run_location) && status.run?.where === 'here' && waiting?.on === 'runner' && waiting.on_you === true &&
        waiting.claimed === false && status.run.run === waiting.run ? waiting.run : undefined
      if (readyRun && readyRun !== one.waitingRun) next.pending[`runner:${story}`] = `${one.reference} has local run ${readyRun} waiting for its owner.`
      if (!readyRun) delete next.pending[`runner:${story}`]
      one.waitingRun = readyRun
    }
    const quiet = boardOnlyWait(status)
    if (quiet && !status.finished) delete next.pending[`story:${story}`]
    const initialized = one.state !== null
    for (const event of status.events ?? []) {
      if (event.id <= one.event) continue
      if (initialized && !quiet && event.kind === 'run.blocked') notice(next, story, `blocked:${event.run ?? status.run?.run ?? event.id}`)
      one.event = Math.max(one.event, event.id)
    }
    if (outcome) {
      if (initialized && (!quiet || status.finished)) notice(next, story, outcome)
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
type Order = OrderView

function milestoneQuestion(factory: string, reference: string, id: string, check: number, reason: string) {
  return `${factory} / ${reference} (${id}), check #${check}: ${reason} What would you like to do with this check?`
}

function claudeSource(row?: {execution_source?: {kind: string} | null} | null): boolean {
  return row?.execution_source == null || row.execution_source.kind === 'claude_code'
}

type LocalRun = {execution_source?: {kind: string; connection_id: number} | null; reference?: string; story: string; run: number; claimed: boolean; where: string; factory?: {factory?: string}; workflow?: {workflow?: string}}

async function readyRepairs($: EngineInterface, view: Order, factory: string, check: number, workflow?: string, target?: Recovery) {
  const fixes = view.milestones?.find(m => m.check?.latest?.id === check)?.fixes ?? []
  const stories = new Set(fixes.filter(f => f.check_id === check
    && (!target || (target.kind === 'repair' && f.item_id === target.item && f.card?.public_id === target.story))).map(f => f.card?.public_id).filter(Boolean))
  if (!stories.size) return []
  const work = await call<{work?: LocalRun[]}>($, 'list_my_work', {factory})
  if (!work.ok || !Array.isArray(work.data?.work)) return []
  return work.data.work.filter(r => r.where === 'here' && claudeSource(r) && r.claimed === false && r.factory?.factory === factory
    && (!workflow || r.workflow?.workflow === workflow) && stories.has(r.story) && Number.isSafeInteger(r.run) && r.run > 0)
}

type RunRecovery = (target: Extract<Recovery, {kind: 'proof'}>, authorized: () => Promise<boolean>) => Promise<{isRun: boolean; text: string}>

// A checkpoint without a preparation fence may already have sent a claim in an older session.
function canPrepareProof(record: RecoveryRecord | undefined, now: number): boolean {
  return !record || (record.state === 'pending' && record.native?.phase === 'preparing' && record.native.nextReadAt <= now)
}

async function reconcileRecovery($: EngineInterface, generation: number, factory: string, id: string, view: Order) {
  const prior = (await read($, state)).orders[id]?.milestones?.recovery ?? {}
  for (const [key, record] of Object.entries(prior)) {
    if (record.state !== 'pending') continue
    const target = record.target
    let outcome: 'completed' | 'failed' | undefined
    let claimed = false
    if (target.kind === 'proof') {
      const got = await call<ProofResult>($, 'proof_result', {factory, story:target.member_story, proof:target.proof})
      if (got.ok && got.data?.proof === target.proof) {
        outcome = proofOutcome(target, got.data)
        claimed = got.data.commands?.some(command => command.run === target.proof && command.name === 'test'
          && ['claimed', 'running', 'passed', 'failed'].includes(command.status ?? '')) === true
      }
    } else {
      const fix = view.milestones?.flatMap(m => m.fixes ?? []).find(f => f.check_id === record.check && f.item_id === target.item && f.card?.public_id === target.story)
      if (fix?.state === 'finished') outcome = 'completed'
    }
    if (outcome || (claimed && record.native?.phase === 'preparing')) await update($, state, current => {
      if (current.generation !== generation || !current.orders[id]?.milestones?.recovery?.[key]) return current
      const next = structuredClone(current)
      const saved = next.orders[id]!.milestones!.recovery![key]!
      if (outcome) saved.state = outcome
      if (claimed && saved.native) saved.native.phase = 'submitted'
      return next
    })
  }
}

// Persist intent before either transport accepts a question or operation. An ambiguous reply stays pending.
async function routeMilestones($: EngineInterface, generation: number, factory: string, id: string, view: Order, runProof: RunRecovery) {
  if (view.order !== id || !Array.isArray(view.milestones)) return
  const owned = (await read($, state)).orders[id]
  if (!owned || owned.factory !== factory || owned.reference !== view.work_order?.reference) return
  if (!owned.milestones && !view.milestones.some(m => m.check?.route || m.check?.needs_person)) return
  const result = await call<Needs>($, 'needs_you', {factory})
  if (!result.ok || !Array.isArray(result.data?.for_person) || !Array.isArray(result.data.for_manager)) return
  await reconcileRecovery($, generation, factory, id, view)
  const actions = decisions(view, result.data, factory, id)
  await update($, state, current => {
    if (current.generation !== generation || !current.orders[id]) return current
    const next = structuredClone(current), journal = next.orders[id]!.milestones ??= blankJournal()
    recoverRetries(view, journal)
    for (const [key, r] of Object.entries(journal.recovery ?? {})) r.current = actions.has(key)
    journal.prerequisites = Object.fromEntries([...actions].filter(([, a]) => a.route.action === 'hold')
      .map(([key, a]) => [key, owned.reference + ', check #' + a.route.check + ': ' + a.route.reason]))
    for (const key of Object.keys(journal.questions)) if (!actions.has(key)) delete journal.questions[key]
    for (const [key, {route}] of actions) {
      if (route.action === 'review' && journal.seen.includes(key))
        journal.questions[key] = milestoneQuestion(factory, owned.reference, id, route.check, route.reason)
    }
    return next
  })
  for (const [key, {route, policy}] of actions) {
    const before = await read($, state), journal = before.orders[id]?.milestones
    if (before.generation !== generation || !journal || journal.seen.includes(key) || journal.retries[key] || route.action === 'hold') continue
    const target = route.recovery
    const time = await $.clock.now()
    if (target?.kind === 'proof' && !canPrepareProof(journal.recovery?.[key], time)) continue
    let repairs: LocalRun[] = []
    if (route.action === 'repair' && target?.kind !== 'proof') {
      repairs = (await readyRepairs($, view, factory, route.check, before.manager?.workflow, target))
        .filter(r => !journal.seen.includes(key + ':' + r.run))
      if (!repairs.length) continue
    }
    // The initial snapshot may have raced a preference change. Re-read both surfaces immediately before dispatch.
    const order = await call<Order>($, 'work_orders', {factory, order: id})
    if (!order.ok || order.data?.work_order?.reference !== owned.reference) continue
    const attention = await call<Needs>($, 'needs_you', {factory})
    const fresh = attention.ok && decisions(order.data, attention.data, factory, id).get(key)
    if (!fresh || fresh.route.reason !== route.reason || fresh.policy !== policy) continue
    if (route.action === 'repair' && target?.kind !== 'proof') {
      const available = await readyRepairs($, order.data, factory, route.check, before.manager?.workflow, target)
      repairs = repairs.filter(r => available.some(a => a.run === r.run && a.story === r.story))
      if (!repairs.length) continue
    }
    const question = milestoneQuestion(factory, owned.reference, id, route.check, route.reason)
    let reserved = false, preparation = 0
    await update($, state, current => {
      const ledger = current.orders[id]?.milestones
      if (current.generation !== generation || !ledger || ledger.seen.includes(key) || ledger.retries[key]) return current
      const next = structuredClone(current), entry = next.orders[id]!.milestones!
      if (route.action === 'review') { entry.seen.push(key); entry.questions[key] = question }
      else if (route.action === 'repair') {
        if (target) {
          entry.recovery ??= {}
          const previous = entry.recovery[key]
          if (target.kind === 'proof' && !canPrepareProof(previous, time)) return current
          preparation = (previous?.native?.attempt ?? 0) + 1
          entry.recovery[key] = {target, check:route.check, state:'pending', run:repairs[0]?.run,
            ...(target.kind === 'proof' && target.executor === 'here' && {native:{
              phase:'preparing', attempt:preparation, nextReadAt:time + Math.min(300_000, 60_000 * 2 ** Math.min(preparation - 1, 3)),
            }}),
            note: target.kind === 'proof' ? owned.reference + ' is waiting for proof ' + target.proof + ' on its ' + target.executor + ' executor.'
              : owned.reference + ' is following repair ' + target.story + '.'}
        }
        entry.seen.push(...repairs.map(r => key + ':' + r.run))
      }
      else entry.retries[key] = {requested: route.check, state: 'pending', reason: route.reason}
      reserved = true
      return next
    })
    if (!reserved) continue
    await save($, generation)
    if (!await continuationCurrent($, generation)) return
    if (route.action === 'review') {
      try { await $.prompt.submit({text: 'CodeBook: Ask the operator once, in their own session: ' + question +
        ' Continue independent work. An answer applies only to this exact attempt; recheck its current route before recording any decision.'}) } catch { /* The exact question remains visible in /factory status. */ }
    } else if (target?.kind === 'proof') {
      if (target.executor === 'here') {
        // The native claim is exclusive across sessions. Keep other orders moving while the test runs.
        const authorized = async () => {
          if (!await continuationCurrent($, generation)) return false
          const viewNow = await call<Order>($, 'work_orders', {factory, order:id})
          if (!viewNow.ok || viewNow.data.work_order?.reference !== owned.reference) return false
          const needsNow = await call<Needs>($, 'needs_you', {factory})
          const now = needsNow.ok && decisions(viewNow.data, needsNow.data, factory, id).get(key)
          if (!now || now.policy !== policy || now.route.reason !== route.reason) return false
          // This callback runs immediately before the native claim. Persist its single-use fence before allowing the RPC.
          let submit = false
          await update($, state, current => {
            const record = current.orders[id]?.milestones?.recovery?.[key]
            if (current.generation !== generation || record?.state !== 'pending' || record.native?.phase !== 'preparing'
              || record.native.attempt !== preparation) return current
            const next = structuredClone(current)
            next.orders[id]!.milestones!.recovery![key]!.native!.phase = 'submitted'
            submit = true
            return next
          })
          if (submit) await save($, generation)
          return submit && await continuationCurrent($, generation)
        }
        void runProof(target, authorized).catch(() => ({isRun:false, text:'The native proof result is pending.'})).then(async result => {
          if (result.isRun) return
          await update($, state, current => {
            const record = current.orders[id]?.milestones?.recovery?.[key]
            if (current.generation !== generation || record?.state !== 'pending' || record.native?.attempt !== preparation) return current
            const next = structuredClone(current)
            next.orders[id]!.milestones!.recovery![key]!.note = result.text
            return next
          })
          await save($, generation)
        })
      }
    } else if (route.action === 'repair') {
      const runs = repairs.map(r => r.story + ' (run ' + r.run + ')').join(', ')
      try { await $.prompt.submit({text: `CodeBook: ${owned.reference}, check #${route.check} has existing repair work: ${runs}. Recheck the local assignment, claim only an eligible run, and continue independent work. This repair needs no milestone decision.`}) } catch { /* Normal readiness remains available. */ }
    } else {
      const response = await call<Parameters<typeof confirmedRetry>[0]>($, 'decide_milestone_check', {
        factory, order: id, check: route.check, authority: 'manager', decision: 'retry', ...(policy && {expected_policy: policy}),
      })
      if (response.ok && confirmedRetry(response.data, route)) await update($, state, current => {
        if (current.generation !== generation || !current.orders[id]?.milestones?.retries[key]) return current
        const next = structuredClone(current)
        Object.assign(next.orders[id]!.milestones!.retries[key]!, {state: 'confirmed', actor: 'manager', check: response.data.check!.id})
        return next
      })
      // A refused, stale or lost response never triggers another write for this attempt.
    }
  }
  await save($, generation)
}


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
  // Offsets refer to the backlog at one cursor. A move between pages invalidates all preceding pages.
  const restart = watch.offset > 0 && watch.cursor !== cursor
  const offset = restart ? 0 : watch.offset
  const got = await call<ManagerBrief>($, 'manager_brief', { ...args, ...(offset > 0 && { backlog_offset: offset }) })
  if (!got.ok) return got
  if (got.data.factory?.factory !== watch.factory || got.data.workflow?.workflow !== watch.workflow || !Array.isArray(got.data.backlog?.stories)) return
  let persist = false
  await update($, state, current => {
    if (current.generation !== before.generation || !current.manager) return current
    const next = structuredClone(current), manager = next.manager!
    if (restart) { manager.offset = 0; manager.seen = [] }
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

// Manual follow can replace the pane while the previous story remains owned by this session.
// Probe one such story per quiet interval, including after a restart or missed release event.
async function pollBackgroundStory($: EngineInterface, before: CodebookContinuation, monitored: Set<string>): Promise<void> {
  const watch = before.manager
  if (!watch) return
  const owned = Object.entries(before.stories).filter(([story, item]) => !monitored.has(story) && item.factory === watch.factory)
  if (!owned.length) return
  const previous = owned.findIndex(([story]) => story === lastBackgroundStory)
  const [story] = owned[(previous + 1) % owned.length]!
  lastBackgroundStory = story
  const got = await call<Status>($, 'story_status', { factory: watch.factory, workflow: watch.workflow, story, limit: 1 })
  if (!got.ok || !await continuationCurrent($, before.generation)) return
  const status = got.data
  if (status.story.story === story && status.factory.factory === watch.factory && status.workflow?.workflow === watch.workflow) {
    await observeContinuation($, story, status, before.generation)
  }
}

export async function ownsHarnessRegistration($: EngineInterface, input: unknown): Promise<boolean> {
  if (!input || typeof input !== 'object' || !('factory' in input) || !('kind' in input) || !('capabilities' in input)
    || Object.keys(input).sort().join(',') !== 'capabilities,factory,kind' || input.kind !== 'claude_code'
    || !Array.isArray(input.capabilities) || input.capabilities.join(',') !== 'station') return false
  const watch = (await read($, state)).manager
  return watch?.registerHarness === true && watch.factory === input.factory
}

async function registerHarness($: EngineInterface, watch: CodebookWorkflowWatch, generation: number): Promise<boolean> {
  // A Claude API key can run the same plugin. Register only a signed-in Claude subscription.
  const result = await $.process.run(['claude', 'auth', 'status', '--json'], { timeoutMs: 5000 })
  if (result.exitCode !== 0) return false
  try {
    const auth = JSON.parse(result.stdout)
    if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' || !auth.subscriptionType) return false
  } catch { return false }
  const got = await call<{registered?: boolean; selected?: boolean | null; source?: {kind: string; connection_id: number} | null}>(
    $, 'connect_factory_harness', {factory: watch.factory, kind: 'claude_code', capabilities: ['station']})
  if (!got.ok || got.data?.registered !== true) return false
  if (got.data.selected === null && got.data.source === null) return true
  const source = got.data.source
  if (got.data.selected !== true || source?.kind !== 'claude_code' || !Number.isSafeInteger(source.connection_id)) return false
  const listed = await call<{work?: LocalRun[]}>($, 'list_my_work', {factory: watch.factory})
  if (listed.ok && Array.isArray(listed.data?.work)) await update($, state, current => {
    if (current.generation !== generation || current.manager?.factory !== watch.factory) return current
    const next = structuredClone(current)
    for (const row of listed.data.work!) {
      if (row.where !== 'here' || row.claimed !== false || row.factory?.factory !== watch.factory
        || row.workflow?.workflow !== watch.workflow || row.execution_source?.kind !== 'claude_code'
        || row.execution_source.connection_id !== source.connection_id || typeof row.story !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(row.story) || !Number.isSafeInteger(row.run) || row.run <= 0) continue
      if (!next.stories[row.story] && Object.keys(next.stories).length >= MAX_STORIES) continue
      const ref = /^#[0-9]+$/.test(row.reference ?? '') ? row.reference! : row.story
      const owned = next.stories[row.story] ??= {factory: watch.factory, reference: ref, order: null, state: 'moving', event: 0}
      if (owned.waitingRun === row.run) continue
      owned.waitingRun = row.run
      next.pending[`runner:${row.story}`] = `${ref} has local run ${row.run} waiting for its owner.`
    }
    return next
  })
  return true
}

/** One page and one owned-order snapshot per quiet interval, round robin. No catch-up loop or model on empty reads. */
export async function pollContinuation($: EngineInterface, monitored: Set<string>, runProof: RunRecovery): Promise<ReadFailure | void> {
  if (polling) return
  polling = true
  try {
    const before = await read($, state), now = await $.clock.now()
    if (before.checkedAt && now - before.checkedAt < QUIET_MS) return
    const factories = [...new Set([...Object.values(before.stories), ...Object.values(before.orders)].map(one => one.factory).filter(Boolean))]
    if (!factories.length && !before.manager) return
    const generation = before.generation
    const factory = factories.length ? factories[before.nextFactory % factories.length] : undefined
    await update($, state, current => current.generation === generation ? { ...current, checkedAt: now, nextFactory: current.nextFactory + 1 } : current)
    if (before.manager?.registerHarness !== undefined) {
      let ready = false
      try { ready = before.manager.registerHarness && await registerHarness($, before.manager, generation) } catch { /* Offline or signed out. */ }
      await update($, state, value => value.generation === generation && value.manager
        ? {...value, manager: {...value.manager, harnessReadyAt: ready ? now : 0}} : value)
      if (!ready || !await continuationCurrent($, generation)) return
    }
    const workflowFailure = await pollWorkflow($, before, now) || undefined
    if (!await continuationCurrent($, generation)) return
    if (before.manager && before.manager.readError !== workflowFailure?.code) {
      await update($, state, current => current.generation === generation && current.manager
        ? { ...current, manager: { ...current.manager, readError: workflowFailure?.code } } : current)
      await save($, generation)
    }
    await pollBackgroundStory($, before, monitored)
    if (!factory || !await continuationCurrent($, generation)) return workflowFailure
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
      if (got.ok && got.data?.work_order?.reference === owned.reference) await routeMilestones($, generation, owned.factory, id, got.data, runProof)
      if (got.ok && got.data?.work_order?.reference === owned.reference && Array.isArray(got.data.milestones)) await update($, state, value => {
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
export async function flushContinuation($: EngineInterface, delivery: Delivery = 'current'): Promise<boolean> {
  if (flushing.has(delivery)) return false
  flushing.add(delivery)
  try {
    const before = await read($, state), generation = before.generation
    const completed = delivery === 'completion'
    const candidates = Object.entries(before.pending).filter(([key]) => {
      if (completed !== key.startsWith('completion:') || key === 'workflow') return false
      if (!key.startsWith('workflow:')) return true
      const watch = before.manager
      return watch && !watch.readError && !watch.offset && watch.scannedAt > 0 && watch.ready.includes(key.slice('workflow:'.length))
    }).slice(0, NOTICE_BATCH)
    if (!candidates.length) return false
    const now = await $.clock.now()
    if (before.manager?.registerHarness !== undefined && (!before.manager.registerHarness || !before.manager.harnessReadyAt
      || now - before.manager.harnessReadyAt >= 2 * QUIET_MS)) return false
    const deadline = completed ? 'completionRetryAt' : 'retryAt'
    const failureCount = completed ? 'completionFailures' : 'deliveryFailures'
    if ((before[deadline] ?? 0) > now) return false
    const failures = Math.min(before[failureCount] ?? 0, 5)
    const retryAt = now + Math.min(QUIET_MS * 2 ** failures, 15 * 60000)
    await update($, state, current => current.generation === generation ? { ...current, [deadline]: retryAt } : current)
    await save($, generation)
    if (!await continuationCurrent($, before.generation)) return false
    // A different card can occupy the pane after resume. Recheck the queued run itself before delivery.
    const deliver: [string, string][] = [], stale: [string, string][] = [], deferred: [string, string][] = []
    for (const [key, line] of candidates) {
      if (key.startsWith('story:')) {
        const story = key.slice('story:'.length), owned = before.stories[story]
        if (owned?.state?.startsWith('blocked:')) {
          const got = await call<Status>($, 'story_status', {factory:owned.factory, story, limit:1})
          if (!await continuationCurrent($, generation)) return false
          if (!got.ok) { deferred.push([key, line]); continue }
          if (got.data.story?.story !== story || got.data.factory?.factory !== owned.factory || boardOnlyWait(got.data)) {
            stale.push([key, line]); continue
          }
        }
      }
      if (!key.startsWith('runner:')) { deliver.push([key, line]); continue }
      const story = key.slice('runner:'.length), owned = before.stories[story], watch = before.manager
      if (!owned?.waitingRun || !watch || owned.factory !== watch.factory) { stale.push([key, line]); continue }
      const got = await call<Status>($, 'story_status', { factory: watch.factory, workflow: watch.workflow, story, limit: 1 })
      if (!await continuationCurrent($, generation)) return false
      if (!got.ok) { deferred.push([key, line]); continue }
      const status = got.data, waiting = status.waiting
      if (status.story.story === story && status.factory.factory === watch.factory && status.workflow?.workflow === watch.workflow
          && !status.finished && !status.in_backlog && claudeSource(status.run_location) && status.run?.where === 'here' && status.run.run === owned.waitingRun
          && waiting?.on === 'runner' && waiting.on_you === true && waiting.claimed === false && waiting.run === owned.waitingRun) {
        deliver.push([key, line])
      } else stale.push([key, line])
    }
    const readFailed = deferred.length > 0
    if (stale.length || readFailed) await update($, state, current => {
      if (current.generation !== generation) return current
      const next = structuredClone(current)
      for (const [key, line] of deferred) {
        if (next.pending[key] !== line) continue
        delete next.pending[key]
        next.pending[key] = line // Rotate a failed read behind independent waiting notices.
      }
      for (const [key, line] of stale) {
        if (next.pending[key] !== line) continue
        delete next.pending[key]
        const owned = key.startsWith('runner:') && next.stories[key.slice('runner:'.length)]
        if (owned) delete owned.waitingRun
      }
      if (readFailed) next[failureCount] = failures + 1
      else if (!deliver.length) { next[failureCount] = 0; next[deadline] = 0 }
      return next
    })
    if (stale.length || readFailed) await save($, generation)
    const latest = await read($, state)
    if (latest.generation !== generation) return false
    const entries = deliver.filter(([key, line]) => latest.pending[key] === line)
    if (!entries.length) return false
    const lines = entries.map(([, line]) => line)
    const text = `CodeBook: ${lines.join(' ')} ` +
      (completed ? 'Report these results to the person now. ' : '') +
      'Use the codebook:factory-manager skill: inspect this session\'s queued runs first, open proposals and the separate Backlog, then continue eligible authorized work. ' +
      'Use the signed-in Claude plan for local stations and record actual usage. Honor provider limits, approvals, capacity and deadlines. Never ask for a CodeBook token budget or switch to a paid fallback. Suggest policy still asks before new unapproved stories. Leave other sessions\' work alone. ' +
      (before.manager ? 'Use Run here only. Check current readiness and ownership before acting. ' : '') +
      'Keep server-designated board_only waits on the board, including after resume. Preserve chat and legacy approvals. Inspect independent ready work and do not repeat unchanged blocked tests or proof requests. This notice grants no approval to claim, confirm, merge or change settings.'
    try {
      await $.prompt.submit({ text })
    } catch {
      await update($, state, current => current.generation === before.generation ? { ...current, [failureCount]: failures + 1 } : current)
      await save($, generation)
      return false
    }
    await update($, state, current => {
      if (current.generation !== before.generation) return current
      const pending = { ...current.pending }
      for (const [key, line] of entries) if (pending[key] === line) delete pending[key]
      return { ...current, pending, [deadline]: readFailed ? retryAt : 0, [failureCount]: readFailed ? failures + 1 : 0 }
    })
    await save($, generation)
    return true
  } finally { flushing.delete(delivery) }
}
