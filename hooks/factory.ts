// The Factory's values and the actions on them, shared by the hooks module and the pane.
// Every CodeBook call goes through the connector (connector.ts).

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  CodebookActive,
  CodebookEvent,
  CodebookFactory,
  CodebookLink,
  CodebookMode,
  CodebookStation,
  CodebookStory,
} from '../types'
import { call } from './connector'

// Change a tag when that value's fields change: it declines what an earlier version stored.
export const mode = atom({ plugin: 'codebook', key: 'mode' } as const, 'here' as CodebookMode)
export const active = atom({ plugin: 'codebook', key: 'active' } as const, null, { shape: 'active-1' })
export const story = atom({ plugin: 'codebook', key: 'story' } as const, null, { shape: 'story-2' })
export const events = atom({ plugin: 'codebook', key: 'events' } as const, [], { shape: 'events-1' })
export const factories = atom({ plugin: 'codebook', key: 'factories' } as const, null, { shape: 'factories-1' })
export const picked = atom({ plugin: 'codebook', key: 'picked' } as const, null, { shape: 'factories-1' })
export const link = atom({ plugin: 'codebook', key: 'link' } as const, { state: 'idle' } as CodebookLink, {
  shape: 'link-1',
})
export const busy = atom({ plugin: 'codebook', key: 'busy' } as const, null as string | null)
export const sendingBack = atom({ plugin: 'codebook', key: 'sendingBack' } as const, false)
export const handed = atom({ plugin: 'codebook', key: 'handed' } as const, [] as number[])
export const notice = atom({ plugin: 'codebook', key: 'notice' } as const, null as string | null)

export const STORE_ACTIVE = 'active-1'
export const STORE_MODE = 'mode'

// Wire shapes of the connector (docs/MCP-CONNECTOR.md in codebook-app), as far as the pane reads them.
type Worker = { type?: string; name?: string; person?: { name?: string; is_you?: boolean } | null }
type BoardStation = { station: string; name: string; ends_work?: string | null; worker?: Worker | null }
type Board = {
  factory: string
  name: string
  url?: string
  workflow?: { workflow: string; name: string } | null
  stations: BoardStation[]
}
type StatusStation = { station: string; name: string; run?: number; state?: string; summary?: string | null }
type WireEvent = {
  id: number
  kind: string
  occurred_at: string
  station?: string | null
  to_station?: string | null
  subject?: string | null
  detail?: string | null
  outcome?: string | null
  actor?: string | null
}
type Lease = { fence: number; expires_at?: string; expired?: boolean }
type RunLocation = {
  where: 'here' | 'cloud'
  person?: { name?: string; is_you?: boolean } | null
  changeable?: boolean
  stations?: { station: string; name: string; runs: string }[]
}
export type Status = {
  story: { story: string; reference: string; title: string }
  factory: { factory: string; name: string }
  workflow?: { workflow: string; name: string } | null
  station: { station: string; name: string; worker?: Worker } | null
  in_backlog: boolean
  finished: string | null
  run: { run: number; state: string; where?: string } | null
  run_location?: RunLocation | null
  waiting:
    | null
    | {
        on: 'person' | 'outside_agent' | 'runner'
        run: number
        on_you?: boolean
        claimed?: boolean
        claimed_by_you?: boolean
        lease?: Lease | null
        pull_requests?: { pull_request_id: number; head_sha: string; number?: number; html_url?: string }[]
      }
  stations: StatusStation[]
  events: WireEvent[]
  last_event: number | null
  url?: string
}
type Started = {
  story: { story: string; reference: string; title: string }
  factory: { factory: string; name: string }
  workflow?: { workflow: string; name: string } | null
  station?: { station: string; name: string } | null
  run?: { run: number; state: string } | null
  run_location?: RunLocation | null
  url?: string
  next?: string
}
type FactoryList = {
  factories: {
    factory: string
    name: string
    workspace?: { name?: string }
    organization?: { name?: string } | null
    may_start_stories?: boolean
    url?: string
  }[]
}

// Module memory: rebuilt after a reload from the next poll.
let board: { key: string; stations: BoardStation[]; url: string | null } | null = null

function boardKey(a: CodebookActive): string {
  return `${a.factory}/${a.workflow ?? ''}`
}

export async function setLink($: EngineInterface, result: { ok: boolean; isSignIn?: boolean; message?: string }) {
  const next: CodebookLink = result.ok
    ? { state: 'ok' }
    : result.isSignIn
      ? { state: 'signin', message: result.message ?? '' }
      : { state: 'error', message: result.message ?? '' }
  await update($, link, () => next)
}

export async function loadFactories($: EngineInterface): Promise<string | null> {
  const listed = await call<FactoryList>($, 'list_factories', {})
  await setLink($, listed)
  if (!listed.ok) return listed.message
  const rows: CodebookFactory[] = listed.data.factories.map(f => ({
    factory: f.factory,
    name: f.name,
    workspace: f.workspace?.name ?? '',
    organization: f.organization?.name ?? null,
    mayStart: f.may_start_stories !== false,
    url: f.url ?? null,
  }))
  await update($, factories, () => rows)
  return null
}

async function loadBoard($: EngineInterface, a: CodebookActive): Promise<void> {
  if (board?.key === boardKey(a)) return
  const args: Record<string, unknown> = { factory: a.factory }
  if (a.workflow) args.workflow = a.workflow
  const got = await call<Board>($, 'factory_board', args)
  if (got.ok) board = { key: boardKey(a), stations: got.data.stations, url: got.data.url ?? null }
}

function workerOf(w: Worker | null | undefined): { type: string; name: string; isYou: boolean } {
  return {
    type: w?.type ?? 'none',
    name: w?.person?.name ?? w?.name ?? '',
    isYou: w?.person?.is_you === true,
  }
}

function eventText(e: WireEvent): string {
  const said = e.subject ?? e.outcome ?? e.detail
  if (said) return said
  switch (e.kind) {
    case 'card.created':
      return 'story added'
    case 'card.moved':
      return e.to_station ? `moved to ${e.to_station}` : 'moved'
    case 'run.queued':
      return 'queued'
    case 'run.started':
      return 'started'
    case 'run.external_sent':
      return 'waiting for an agent to take it'
    case 'run.passed':
      return 'passed'
    case 'run.failed':
      return 'failed'
    case 'run.blocked':
      return 'blocked'
    case 'human.approved':
      return `approved${e.actor ? ` by ${e.actor}` : ''}`
    case 'human.rejected':
      return `sent back${e.actor ? ` by ${e.actor}` : ''}`
    case 'card.finished':
      return 'story finished'
    default:
      return e.kind.replace(/[._]/g, ' ')
  }
}

/** Asks story_status for the followed story and folds it into the pane's values. */
export async function refresh($: EngineInterface): Promise<void> {
  const a = await read($, active)
  if (a === null) return
  await loadBoard($, a)
  const before = await read($, story)
  const args: Record<string, unknown> = { story: a.story, factory: a.factory, limit: 50 }
  if (a.workflow) args.workflow = a.workflow
  if (before?.lastEvent != null) args.after = before.lastEvent
  const got = await call<Status>($, 'story_status', args)
  await setLink($, got)
  if (!got.ok) return
  const s = got.data
  const byStation = new Map(s.stations.map(one => [one.station, one]))
  const runsAt = new Map((s.run_location?.stations ?? []).map(one => [one.station, one.runs]))
  const fromBoard: BoardStation[] = board?.stations ?? s.stations.map(one => ({ station: one.station, name: one.name }))
  const listed = fromBoard.filter(one => one.ends_work == null)
  const stations: CodebookStation[] = listed.map(one => {
    const ran = byStation.get(one.station)
    const isCurrent = s.station?.station === one.station
    const worker = workerOf(one.worker)
    const state = isCurrent && s.run ? s.run.state : (ran?.state ?? 'idle')
    return {
      station: one.station,
      name: one.name,
      workerType: worker.type,
      workerName: worker.name,
      isYou: worker.isYou,
      state,
      run: isCurrent && s.run ? s.run.run : (ran?.run ?? null),
      summary: ran?.summary ?? null,
      runs: runsAt.get(one.station) ?? null,
      isCurrent,
    }
  })
  const w = s.waiting
  const next: CodebookStory = {
    stations,
    finished: s.finished,
    inBacklog: s.in_backlog,
    runHere: s.run_location ? s.run_location.where === 'here' : null,
    canMove: s.run_location?.changeable !== false,
    waitingOn: w?.on ?? null,
    waitingRun: w?.run ?? null,
    waitingOnYou: w?.on_you === true,
    waitingClaimed: w?.claimed === true,
    waitingClaimedByYou: w?.claimed_by_you === true,
    waitingFence: w?.lease?.fence ?? null,
    leaseExpired: w?.lease?.expired === true,
    pullRequests: (w?.pull_requests ?? []).map(pr => ({
      pull_request_id: pr.pull_request_id,
      head_sha: pr.head_sha,
      number: pr.number ?? null,
      html_url: pr.html_url ?? null,
    })),
    lastEvent: s.last_event ?? before?.lastEvent ?? null,
    checkedAt: await $.clock.now(),
  }
  await update($, story, () => next)
  if (s.events.length > 0) {
    const rows: CodebookEvent[] = s.events.map(e => ({
      id: e.id,
      kind: e.kind,
      station: e.station ?? null,
      text: eventText(e),
      at: e.occurred_at,
    }))
    await update($, events, list => {
      const seen = new Set(list.map(one => one.id))
      return [...list, ...rows.filter(one => !seen.has(one.id))].slice(-40)
    })
  }
  if (s.url && s.url !== a.url) await update($, active, () => ({ ...a, url: s.url ?? null }))
}

/** Starts following a story: the pane, the timer and later sessions all read it. */
export async function follow($: EngineInterface, a: CodebookActive): Promise<void> {
  board = null
  await update($, active, () => a)
  await update($, story, () => null)
  await update($, events, () => [])
  await update($, sendingBack, () => false)
  await $.store.set(STORE_ACTIVE, a)
  await refresh($)
}

export async function unfollow($: EngineInterface): Promise<void> {
  board = null
  await update($, active, () => null)
  await update($, story, () => null)
  await update($, events, () => [])
  await $.store.delete(STORE_ACTIVE)
}

/** Sets where the next stories run and, when a story is followed, moves that story there too (set_run_location). */
// Writes go through the person and Claude, never straight from the pane: the desktop's auto mode judges each write
// against the request that asked for it, and a button press is no request. So a press puts the request, in plain
// words, into the person's prompt box; they send it with Enter, Claude makes the call, and adopt() below folds the
// answer back into the pane. Where the box cannot take it, the words are copied for them to paste.

/** Offers the person's request in their prompt box (or on the clipboard); the person sends it. */
async function offer($: EngineInterface, text: string, what: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) {
    await update($, notice, () => `${what} is in your prompt box: press Enter to send it.`)
    return
  }
  const copied = await $.ui.copy({ text })
  await update($, notice, () =>
    copied.isCopied ? `${what} is copied: paste it into the chat and send it.` : `Send this in the chat: ${text}`,
  )
}

function storyRef(a: CodebookActive): string {
  return `CodeBook story ${a.reference} "${a.title}" (story id ${a.story}, factory ${a.factoryName}, factory id ${a.factory}${a.workflow ? `, workflow ${a.workflow}` : ''})`
}

/** Sets where the next stories run and, when a story is followed, offers the request that moves it too. */
export async function setMode($: EngineInterface, to: CodebookMode): Promise<string | null> {
  await update($, mode, () => to)
  await $.store.set(STORE_MODE, to)
  const a = await read($, active)
  const s = await read($, story)
  const next =
    to === 'here'
      ? 'Agent stations run here, with your Claude, in this checkout.'
      : "Agent stations run in CodeBook's cloud."
  if (a === null || s === null || s.finished !== null || s.runHere === (to === 'here')) {
    await update($, notice, () => next)
    return null
  }
  if (!s.canMove) {
    const said = 'A station of this story is being worked here right now; it can move once that run is reported.'
    await update($, notice, () => said)
    return said
  }
  await offer(
    $,
    `Move the agent stations of ${storyRef(a)} to ${to === 'here' ? 'run here, on my computer (set_run_location "here")' : 'run in CodeBook\'s cloud (set_run_location "cloud")'}.`,
    'The request to move the story',
  )
  return null
}

/** The words that ask Claude to start a story; with run here, CodeBook leaves its agent stations to this Claude. */
export function startRequest(factory: string, title: string, where: CodebookMode): string {
  return (
    `Start a story in the CodeBook factory "${factory}" titled "${title.replace(/"/g, "'")}", ` +
    (where === 'here'
      ? 'with its agent stations run here, on my computer (start_story with run_location "here").'
      : 'with its agent stations run in CodeBook\'s cloud (start_story with run_location "cloud").')
  )
}

/** Offers the start request from the pane. */
export async function startStory($: EngineInterface, factory: string, title: string, where: CodebookMode): Promise<void> {
  await offer($, startRequest(factory, title, where), 'The request to start the story')
}

/** Folds the answer of a connector call Claude made back into the pane: a started story is followed, others refresh. */
export async function adopt($: EngineInterface, tool: string, data: unknown): Promise<void> {
  if (tool === 'start_story') {
    const s = data as Started | null
    if (!s?.story?.story) return
    await follow($, {
      story: s.story.story,
      factory: s.factory.factory,
      factoryName: s.factory.name,
      workflow: s.workflow?.workflow ?? null,
      reference: s.story.reference,
      title: s.story.title,
      url: s.url ?? null,
    })
    await update($, notice, () => (s.next ? s.next : `Following ${s.story.reference}.`))
    return
  }
  const said = (data as { next?: unknown } | null)?.next
  if (typeof said === 'string') await update($, notice, () => said)
  if ((await read($, active)) !== null) await refresh($)
}

export async function approve($: EngineInterface): Promise<void> {
  const a = await read($, active)
  const s = await read($, story)
  if (a === null || s === null) return
  const station = s.stations.find(one => one.isCurrent)?.name ?? 'current'
  const heads = s.pullRequests.map(pr => ({ pull_request_id: pr.pull_request_id, head_sha: pr.head_sha }))
  await offer(
    $,
    `Approve the ${station} station of ${storyRef(a)} with approve_station` +
      (heads.length > 0 ? `, binding the pull request heads ${JSON.stringify(heads)}.` : '.'),
    'The approval',
  )
}

export async function sendBack($: EngineInterface, reason: string): Promise<void> {
  const a = await read($, active)
  const s = await read($, story)
  if (a === null || reason.trim() === '') return
  const station = s?.stations.find(one => one.isCurrent)?.name ?? 'current'
  await update($, sendingBack, () => false)
  await offer(
    $,
    `Send the ${station} station of ${storyRef(a)} back with send_back, reason: "${reason.trim().replace(/"/g, "'")}".`,
    'The send-back',
  )
}
