// The CodeBook plugin's hooks: the /factory command, the Factory pane beside the chat, the timer that follows the
// story, and the repository guard. The plugin itself only reads CodeBook; every write is a request the person sends
// and Claude makes (Run here: the codebook:factory-manager skill runs the stations with sub-agents).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodebookActive, CodebookClaim, CodebookLink, CodebookMode, CodebookStory } from '../types'
import { call, words } from './connector'
import { allowedOf, repoOf, targetsOf } from './guard'
import type { Target } from './guard'
import {
  adopt,
  follow,
  loadFactories,
  refresh,
  setLink,
  setMode,
  startRequest,
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
const claims = atom({ plugin: 'codebook', key: 'claims' } as const, [] as CodebookClaim[], { shape: 'claims-1' })

const POLL_MS = 4000
const QUIET_POLL_MS = 30000

// Module memory: rebuilt after a reload from the next poll.
let lastPoll = 0
let isPolling = false

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
  '/factory list — the factories you can see',
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

/** The plugin's own connector tools, as the permission check and tool.call name them. */
const OWN_TOOLS = 'mcp__plugin_codebook_codebook__'
/** The reads the pane makes by itself (following the story the person chose); writes go through the person. */
const OWN_READS = new Set(
  ['list_factories', 'factory_board', 'story_status', 'list_my_work', 'manager_brief', 'read_agent_conversations'].map(
    name => OWN_TOOLS + name,
  ),
)

/** The repository a push or pull request reaches, as `owner/name`, from the remote's address in that checkout. */
async function reaches($: EngineInterface, target: Target): Promise<string | null> {
  if (target.kind === 'pr' && target.repo) return repoOf(target.repo)
  const remote = target.kind === 'push' ? target.remote : 'origin'
  const direct = repoOf(remote)
  if (direct !== null && remote.includes('/')) return direct
  const base = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const dir = target.cwd === null ? base : target.cwd.replace(/^~/, home).replace(/^(?!\/)/, `${base}/`)
  const got = await $.process.run(['git', '-C', dir, 'remote', 'get-url', '--push', remote])
  return got.exitCode === 0 ? repoOf(got.stdout) : null
}

/** A connector result as a tool call answers it: the structured payload, else its text as JSON. */
function payloadOf(ran: { result?: unknown; text?: string }): unknown {
  const structured = (ran.result as { structuredContent?: unknown } | undefined)?.structuredContent
  if (structured !== undefined) return structured
  try {
    return ran.text ? JSON.parse(ran.text) : null
  } catch {
    return null
  }
}

export const register: Register = on => {
  // The pane's own READS of the connector (listing factories, following the story the person chose): auto mode's
  // classifier judges the model's requests and has no verdict for a timer's read, so these are allowed here. Nothing
  // else is: writes are requests the person sends, and the model's calls keep the person's permission settings.
  on('tool.check', ($, e, next) =>
    next.origin.plugin === $.plugin.name && OWN_READS.has(e.tool)
      ? { decision: 'allow', reason: 'The CodeBook Factory pane following the story you chose (read only).' }
      : next(e),
  ).catch(($, e, next) => next(e))

  // Claude's calls of the connector (the requests the pane offered, the factory-worker's reports): the pane takes
  // up a started story and refreshes after the rest.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (!tool.startsWith(OWN_TOOLS) || OWN_READS.has(tool) || ran.deny !== undefined || ran.isError) return ran
    const name = tool.slice(OWN_TOOLS.length)
    const data = payloadOf(ran) as { run?: number; brief?: unknown; recorded?: boolean } | null
    // The guard's list: a claim brings its brief's repositories, a report ends the claim.
    if (name === 'claim_work' && typeof data?.run === 'number') {
      const claim: CodebookClaim = { run: data.run, repos: allowedOf(data.brief) }
      await update($, claims, list => [...list.filter(one => one.run !== claim.run), claim])
    }
    if (name === 'complete_work' && typeof data?.run === 'number') {
      const run = data.run
      await update($, claims, list => list.filter(one => one.run !== run))
    }
    await adopt($, name, data)
    return ran
  }).catch(($, e, next) => next(e))

  // The repository guard (G5 decision 6): while this session works a CodeBook run, pushes and pull requests reach only
  // the repositories its brief lists. Outside CodeBook work it stands aside. It only ever refuses.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const held = await read($, claims)
    if (held.length === 0) return next(e)
    const allowed = [...new Set(held.flatMap(one => one.repos))]
    const targets = targetsOf(String(e.command ?? ''))
    if (targets === null) {
      return { deny: `CodeBook: this command pushes in a way the repository guard cannot read (a subshell, eval or sh -c). While CodeBook run ${held.map(one => one.run).join(', ')} is worked here, write the git push or gh pr create plainly.` }
    }
    for (const target of targets) {
      const repo = await reaches($, target)
      if (repo === null || !allowed.includes(repo)) {
        const what = target.kind === 'push' ? `git push to ${target.remote}` : 'gh pr create'
        const where = repo ?? 'a repository the guard could not tell'
        const may = allowed.length > 0 ? allowed.join(', ') : 'no repository (its brief names none)'
        return { deny: `CodeBook: ${what} reaches ${where}. While CodeBook run ${held.map(one => one.run).join(', ')} is worked here, the factory allows ${may}.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CodeBook: the repository guard failed, so the push was not made. Try again.' }))

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

    if (lower === 'list') {
      const failed = await loadFactories($)
      if (failed) return { text: failed }
      const list = (await read($, factories)) ?? []
      if (list.length === 0) return { text: 'You have no factories yet. Make one on app.codebook.work.' }
      const lines = list.map(
        f => `${f.name}${f.workspace ? ` (${f.workspace})` : ''}${f.mayStart ? '' : ' · watch only'}${f.url ? ` ${f.url}` : ''}`,
      )
      return { text: lines.join('\n') }
    }

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
      const request = startRequest(factory, title.join(' '), where)
      const filled = await $.prompt.fill({ text: request, mode: 'replace' })
      await openPane($)
      return {
        text: filled.isFilled
          ? where === 'here'
            ? 'The request is in your prompt box: press Enter. Claude, as the factory manager, will write the stories, ask "proceed?", then run the stations here.'
            : 'The request to start the story is in your prompt box: press Enter to send it. The Factory pane follows the story once CodeBook has it.'
          : `Send this in the chat to start the story: ${request}`,
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
