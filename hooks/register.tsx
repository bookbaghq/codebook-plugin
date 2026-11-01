// The CodeBook plugin's hooks: the /factory command, the Factory pane beside the chat, and the
// timer that follows the story, hands run-here stations to the factory-worker agent and keeps
// their leases alive.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodebookActive, CodebookLink, CodebookMode, CodebookStory } from '../types'
import { call, words } from './connector'
import {
  follow,
  loadFactories,
  refresh,
  setLink,
  setMode,
  startStory,
  STORE_ACTIVE,
  STORE_MODE,
  unfollow,
} from './factory'
import type { Status } from './factory'
import { drawPane, PANE } from './pane'

// The pane's values, declared again here: the engine reads state only through atoms written in the same file.
// Keep each tag as factory.ts has it.
const mode = atom({ plugin: 'codebook', key: 'mode' } as const, 'here' as CodebookMode)
const active = atom({ plugin: 'codebook', key: 'active' } as const, null, { shape: 'active-1' })
const story = atom({ plugin: 'codebook', key: 'story' } as const, null, { shape: 'story-2' })
const factories = atom({ plugin: 'codebook', key: 'factories' } as const, null, { shape: 'factories-1' })
const link = atom({ plugin: 'codebook', key: 'link' } as const, { state: 'idle' } as CodebookLink, {
  shape: 'link-1',
})
const handed = atom({ plugin: 'codebook', key: 'handed' } as const, [] as number[])

const POLL_MS = 4000
const QUIET_POLL_MS = 30000
// The connector asks for one every 300 s (lease.heartbeat_every_seconds); the worker beats too.
const HEARTBEAT_MS = 120000

// Module memory: rebuilt after a reload from the next poll.
let lastPoll = 0
let lastBeat: Record<number, number> = {}
let hasHeartbeat = true
let isPolling = false

function workerPrompt(a: CodebookActive, s: CodebookStory): string {
  const at = s.stations.find(one => one.isCurrent)?.name ?? 'its station'
  return [
    `CodeBook: story ${a.reference} "${a.title}" (${a.factoryName}) is waiting at ${at} for an agent here (run ${s.waitingRun}).`,
    `Use the codebook:factory-worker agent to claim run ${s.waitingRun}, do the station's work in this checkout, open a draft pull request, and report the outcome to CodeBook.`,
  ].join(' ')
}

/** Hands a run-here station to this session once, as a prompt the person sees. */
async function handOff($: EngineInterface): Promise<void> {
  const a = await read($, active)
  const s = await read($, story)
  if (a === null || s === null || s.waitingRun === null || s.waitingClaimed) return
  // A run-here run waits for THIS person's runner; an outside-agent station is taken here only in "Run here" mode.
  const isMine = s.waitingOn === 'runner' && s.waitingOnYou
  const isOpen = s.waitingOn === 'outside_agent' && (await read($, mode)) === 'here'
  if (!isMine && !isOpen) return
  const run = s.waitingRun
  if ((await read($, handed)).includes(run)) return
  await update($, handed, list => [...list, run].slice(-50))
  await $.prompt.submit({ text: workerPrompt(a, s) })
}

/** Keeps the lease of a run this person holds alive while the worker works it, with the claim's fence (G2 §9). */
async function heartbeat($: EngineInterface, now: number): Promise<void> {
  if (!hasHeartbeat) return
  const s = await read($, story)
  if (s === null || !s.waitingClaimedByYou || s.waitingRun === null || s.waitingFence === null) return
  const run = s.waitingRun
  if (now - (lastBeat[run] ?? 0) < HEARTBEAT_MS) return
  lastBeat = { ...lastBeat, [run]: now }
  const beat = await call($, 'heartbeat_work', { run, fence: s.waitingFence })
  if (!beat.ok && /unknown tool|-32601|-32602|method not found/i.test(beat.message)) hasHeartbeat = false
}

async function tick($: EngineInterface): Promise<void> {
  if (isPolling) return
  const a = await read($, active)
  if (a === null) return
  const s = await read($, story)
  const now = await $.clock.now()
  const isQuiet = s !== null && s.finished !== null
  if (now - lastPoll < (isQuiet ? QUIET_POLL_MS : POLL_MS) - 200) return
  isPolling = true
  try {
    lastPoll = now
    await refresh($)
    await handOff($)
    await heartbeat($, now)
  } finally {
    isPolling = false
  }
}

async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Factory' })
  return opened.isPlaced
}

const HELP = [
  '/factory — open the Factory pane (pick a factory, follow a story)',
  '/factory run <factory> "<story title>" [--here | --cloud] — start a story and follow it',
  '/factory status — where the followed story is',
  '/factory follow <story> [<factory>] — follow a story already on the board (#57 needs the factory)',
  '/factory here | cloud — where agent stations of the next story run',
  '/factory stop — stop following the story',
].join('\n')

async function statusText($: EngineInterface): Promise<{ text: string; context?: string[] }> {
  const a = await read($, active)
  if (a === null) return { text: 'No story is followed. Start one with /factory run <factory> "<title>".' }
  await refresh($)
  const s = await read($, story)
  const l = await read($, link)
  if (l.state === 'signin' || l.state === 'error') return { text: l.message }
  if (s === null) return { text: `Following ${a.reference} in ${a.factoryName}; no status yet.` }
  const lines = s.stations.map(one => `${one.isCurrent ? '▸' : ' '} ${one.name}: ${one.state.replace(/_/g, ' ')}`)
  const where = s.finished
    ? `finished (${s.finished})`
    : s.waitingOn === 'person'
      ? s.waitingOnYou
        ? 'waiting for you: Approve or Send back in the Factory pane'
        : 'waiting for a person'
      : s.waitingOn === 'outside_agent' || s.waitingOn === 'runner'
        ? s.waitingClaimedByYou
          ? 'being worked here'
          : 'waiting for an agent here'
        : 'moving'
  const text = [`${a.reference} "${a.title}" (${a.factoryName}) — ${where}`, ...lines, a.url ?? ''].join('\n').trim()
  return { text, context: [JSON.stringify({ codebook_story: a, stations: s.stations, waiting: s.waitingOn })] }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'factory',
      description: 'CodeBook factories: open the Factory pane, start a story (run), or show its status',
      argumentHint: '[run <factory> "<story>" | status | follow <story> | here | cloud | stop]',
    })
    const storedMode = await $.store.get(STORE_MODE)
    if (storedMode === 'here' || storedMode === 'cloud') await update($, mode, () => storedMode)
    const storedActive = (await $.store.get(STORE_ACTIVE)) as CodebookActive | undefined
    if (storedActive && typeof storedActive.story === 'string' && (await read($, active)) === null) {
      await update($, active, () => storedActive)
    }
    $.clock.every(1000, () => {
      void tick($)
    })
    return next(e)
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const [verb = '', ...rest] = words(e.args.trim())
    const lower = verb.toLowerCase()

    if (lower === '' || lower === 'open') {
      const isPlaced = await openPane($)
      if ((await read($, active)) === null && (await read($, factories)) === null) {
        const failed = await loadFactories($)
        if (failed) return { text: failed }
      } else {
        void refresh($)
      }
      return {
        text: isPlaced
          ? 'The Factory pane is open beside the chat.'
          : 'The Factory pane is ready; widen the window (or open the pane from the panes menu) to see it.',
      }
    }

    if (lower === 'help') return { text: HELP }

    if (lower === 'run' || lower === 'start') {
      let where = await read($, mode)
      const args = rest.filter(word => {
        if (word === '--here') where = 'here'
        else if (word === '--cloud') where = 'cloud'
        else return true
        return false
      })
      if (args.length < 2) return { text: `Usage: /factory run <factory> "<story title>"\n\n${HELP}` }
      const [factory = '', ...title] = args
      const started = await startStory($, factory, title.join(' '), where)
      if (!started.ok) return { text: started.text }
      await openPane($)
      return {
        text: started.text,
        context: [
          `The CodeBook story ${started.active.reference} (story id ${started.active.story}, factory ${started.active.factory}) is followed in the Factory pane. ` +
            (where === 'here'
              ? 'When one of its agent stations waits here, the pane asks you to work it with the codebook:factory-worker agent.'
              : "Its agent stations run in CodeBook's cloud; nothing to do here unless the person asks."),
        ],
      }
    }

    if (lower === 'status') return statusText($)

    if (lower === 'follow') {
      const [storyRef = '', factory = ''] = rest
      if (!storyRef) return { text: 'Usage: /factory follow <story> [<factory>]' }
      const args: Record<string, unknown> = { story: storyRef }
      if (factory) args.factory = factory
      const got = await call<Status>($, 'story_status', { ...args, limit: 1 })
      await setLink($, got)
      if (!got.ok) return { text: got.message }
      const s = got.data
      await follow($, {
        story: s.story.story,
        factory: s.factory.factory,
        factoryName: s.factory.name,
        workflow: s.workflow?.workflow ?? null,
        reference: s.story.reference,
        title: s.story.title,
        url: s.url ?? null,
      })
      await openPane($)
      return { text: `Following ${s.story.reference} "${s.story.title}" in ${s.factory.name}.` }
    }

    if (lower === 'here' || lower === 'cloud') {
      const moved = await setMode($, lower)
      const next =
        lower === 'here'
          ? 'Agent stations of the stories you start run here, with your Claude, in this checkout.'
          : "Agent stations of the stories you start run in CodeBook's cloud."
      return { text: moved ? `${next}\n${moved}` : next }
    }

    if (lower === 'stop') {
      await unfollow($)
      return { text: 'Stopped following the story. It keeps moving on app.codebook.work.' }
    }

    return { text: `I don't know "/factory ${verb}".\n\n${HELP}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'codebook-factory' }, async ($, e) => drawPane($, e))
}
