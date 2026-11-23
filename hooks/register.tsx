// The CodeBook plugin's hooks: the /factory command, the Factory pane beside the chat, the timer that follows the
// story, the repository guard, a checkout that knows its factory (checkout.ts) and proof runs (proof.ts: the repository's checks, run
// here and reported by the plugin itself). The plugin itself only reads CodeBook, apart from those proof results; every
// other write is a request the person sends and Claude makes (Run here: the codebook:factory-manager skill runs the
// stations with sub-agents).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodebookActive, CodebookCheckout, CodebookClaim, CodebookLink, CodebookMode, CodebookStory, CodebookWatch } from '../types'
import { call, words } from './connector'
import { claimOf, leaseOf, mayReach, readCommand } from './guard'
import { checkOne, checkShellWords, folderOf, reaches, shellState } from './resolve'
import { adoptCheckout, askAtStart, askBefore, checkoutLine, contextBlock, outsideCommand, promptNote, sweepCheckouts } from './checkout'
import type { Reach } from './checkout'
import { checkoutLines, checkoutsOf, mergeCheckouts } from './local'
import {
  adopt,
  flushAsk,
  follow,
  loadFactories,
  refresh,
  refreshWatched,
  setLink,
  setMode,
  splitRun,
  startRequest,
  STORE_MODE,
  restoreSession,
  takePollSoon,
  unfollow,
} from './factory'
import type { Status } from './factory'
import { backlogText, backlogUsage } from './backlog'
import { orderReport, type WorkOrderReport } from './work-order-report'
import { overnightArguments, overnightRequest, overnightUsage } from './overnight'
import { drawPane, PANE } from './pane'
import { hintOf, runProof, waitingProofs } from './proof'

// The pane's values, declared again here: the engine reads state only through atoms written in the same file.
// Keep each tag as factory.ts has it.
const mode = atom({ plugin: 'codebook', key: 'mode' } as const, 'here' as CodebookMode)
const active = atom({ plugin: 'codebook', key: 'active' } as const, null, { shape: 'active-1' })
const story = atom({ plugin: 'codebook', key: 'story' } as const, null, { shape: 'story-4' })
const factories = atom({ plugin: 'codebook', key: 'factories' } as const, null, { shape: 'factories-1' })
const picked = atom({ plugin: 'codebook', key: 'picked' } as const, null, { shape: 'factories-1' })
const link = atom({ plugin: 'codebook', key: 'link' } as const, { state: 'idle' } as CodebookLink, {
  shape: 'link-1',
})
const watched = atom({ plugin: 'codebook', key: 'watched' } as const, [] as CodebookWatch[], { shape: 'watched-1' })
const claims = atom({ plugin: 'codebook', key: 'claims' } as const, [] as CodebookClaim[], { shape: 'claims-1' })
const checkouts = atom({ plugin: 'codebook', key: 'checkouts' } as const, [] as CodebookCheckout[], { shape: 'checkouts-1' })

const POLL_MS = 4000
const QUIET_POLL_MS = 30000

// Module memory: rebuilt after a reload from the next poll.
let lastPoll = 0
let isPolling = false

async function tick($: EngineInterface): Promise<void> {
  flushAsk($)
  if (isPolling) return
  const a = await read($, active)
  const others = await read($, watched)
  if (a === null && others.length === 0) return
  const s = await read($, story)
  const now = await $.clock.now()
  const isQuiet = (a === null || (s !== null && s.finished !== null)) && others.length === 0
  if (now - lastPoll < POLL_MS - 200) return
  const isAsked = takePollSoon()
  if (isQuiet && !isAsked && now - lastPoll < QUIET_POLL_MS - 200) return
  isPolling = true
  try {
    lastPoll = now
    if (a !== null) await refresh($)
    await refreshWatched($)
  } finally {
    isPolling = false
  }
  flushAsk($)
}

async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Factory' })
  return opened.isPlaced
}

const HELP = [
  '/factory — open the Factory pane (pick a factory, follow a story)',
  '/factory report <factory> <WO-7> — read milestones, spending limits, production holds and evidence',
  overnightUsage + ' — propose a cloud work order with milestones',
  '/factory run <factory> "<story title>" [--here | --cloud] — start a story and follow it',
  "/factory status — where the followed story is, and where each repository's code is on this computer",
  backlogUsage + ' — list unplaced stories and pending proposals',
  '/factory list — the factories you can see',
  '/factory follow <story> [<factory>] — follow a story on the board or in the backlog (#57 needs the factory)',
  '/factory here | cloud — where agent stations of the next story run',
  '/factory stop — stop following the story',
  '/factory outside | inside — in a factory\'s checkout: work outside the factory for this session (no story first, no question before a push), or through it again',
  '/factory prove [<proof>] — run a waiting proof run here: the repository\'s checks, run and reported by the plugin itself',
].join('\n')

async function statusText($: EngineInterface): Promise<{ text: string; context?: string[] }> {
  const known = await read($, checkouts)
  const code = known.length > 0 ? ['The code on this computer:', ...(await checkoutLines($, known))].join('\n') : ''
  const followed = await storyText($)
  // Whether the folder this session is in is a factory's checkout (checkout.ts).
  const here = await checkoutLine($).catch(() => null)
  return { ...followed, text: [followed.text, here ?? '', code].filter(Boolean).join('\n\n') }
}

async function storyText($: EngineInterface): Promise<{ text: string; context?: string[] }> {
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
    : s.question !== null
      ? `waiting for your answer: "${s.question}" (Answer in the Factory pane, or in the chat)`
      : s.waitingOn === 'person'
        ? s.waitingOnYou
          ? 'waiting for you: Approve or Send back in the Factory pane'
          : 'waiting for a person'
        : s.waitingOn === 'outside_agent' || s.waitingOn === 'runner'
          ? s.waitingClaimedByYou
            ? 'being worked here'
            : 'waiting for an agent here'
          : s.inBacklog ? 'in the backlog' : 'moving'
  const text = [`${a.reference} "${a.title}" (${a.factoryName}) — ${where}`, ...lines, a.url ?? ''].join('\n').trim()
  return { text, context: [JSON.stringify({ codebook_story: a, stations: s.stations, waiting: s.waitingOn })] }
}

/** The plugin's own connector tools, as the permission check and tool.call name them. */
const OWN_TOOLS = 'mcp__plugin_codebook_codebook__'
/** The plugin's own taking of a proof run (proof.ts): its answer carries the token the result is reported with, so the model never makes this call. */
const OWN_CLAIM = `${OWN_TOOLS}claim_proof`
const CLAIM_REFUSED = 'This is the CodeBook plugin\'s own call: it takes a proof run and reports the result itself. Ask for a proof with request_proof; you cannot run or report one.'
/** The reads the pane makes by itself (following the story the person chose); writes go through the person. */
const OWN_READS = new Set(
  [
    'list_factories',
    'factory_board',
    'work_orders',
    'story_status',
    'list_my_work',
    'manager_brief',
    'read_agent_conversations',
    'story_trail',
    'factory_events',
    // Which of the person's factories work on the repository this session is in (checkout.ts): asked by the plugin itself.
    'checkout_factory',
  ].map(
    name => OWN_TOOLS + name,
  ),
)

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

export const register: Register = (on, options) => {
  // The person's own list of hosts a proof run may reach beyond this computer (the `proof_hosts` option; egress.ts).
  const proofHosts = options?.proof_hosts ?? null
  // The pane's own READS of the connector (listing factories, following the story the person chose): auto mode's
  // classifier judges the model's requests and has no verdict for a timer's read, so these are allowed here. Nothing
  // else is: writes are requests the person sends, and the model's calls keep the person's permission settings.
  on('tool.check', ($, e, next) =>
    next.origin.plugin === $.plugin.name && OWN_READS.has(e.tool)
      ? { decision: 'allow', reason: 'The CodeBook Factory pane following the story you chose (read only).' }
      : next.origin.plugin === $.plugin.name && e.tool === OWN_CLAIM
        ? { decision: 'allow', reason: 'The CodeBook plugin taking a proof run you or your agent asked for, to run the repository\'s checks here.' }
        : e.tool === OWN_CLAIM
          ? { decision: 'deny', reason: CLAIM_REFUSED }
          : next(e),
  ).catch(($, e, next) => next(e))

  // Claude's calls of the connector (the requests the pane offered, the factory-worker's reports): the pane takes
  // up a started story and refreshes after the rest.
  on('tool.call', async ($, e, next) => {
    // The model never takes a proof run: the answer holds the token its result is reported with (proof.ts).
    if (String(e.tool) === OWN_CLAIM && next.origin.plugin !== $.plugin.name) return { deny: CLAIM_REFUSED }
    const ran = await next(e)
    const tool = String(e.tool)
    if (!tool.startsWith(OWN_TOOLS) || ran.deny !== undefined || ran.isError) return ran
    const name = tool.slice(OWN_TOOLS.length)
    const data = payloadOf(ran) as { run?: number; brief?: unknown; recorded?: boolean } | null
    // Where each repository's code is on this computer, for /factory status.
    const local = checkoutsOf(name, data)
    if (local !== null) await update($, checkouts, list => mergeCheckouts(list, local))
    // What CodeBook said about a repository's factory, or that the person's own switch for it changed (checkout.ts).
    try { await adoptCheckout($, name, e, data) } catch { /* the next prompt asks again */ }
    if (OWN_READS.has(tool)) return ran
    // The guard's list: a claim brings its brief's repositories and the loop that holds it (its lease is that loop's,
    // not the whole session's), a declaration its worktree and branch (where its proof runs), a report ends the claim.
    if (name === 'claim_work' && typeof data?.run === 'number') {
      const claim: CodebookClaim = claimOf(data.run, data.brief, e.agentId)
      await update($, claims, list => [...list.filter(one => one.run !== claim.run), claim])
    }
    if (name === 'declare_work') {
      const asked = e as { run?: unknown; worktree?: unknown; branch?: unknown }
      const recorded = (data as { run?: unknown; recorded?: { worktree?: unknown; branch?: unknown } } | null)
      const run = typeof recorded?.run === 'number' ? recorded.run : Number(asked.run)
      const said = (one: unknown, other: unknown) => (typeof one === 'string' && one.trim() ? one.trim() : typeof other === 'string' && other.trim() ? other.trim() : undefined)
      const worktree = said(recorded?.recorded?.worktree, asked.worktree)
      const branch = said(recorded?.recorded?.branch, asked.branch)
      if (Number.isSafeInteger(run)) await update($, claims, list => list.map(one => (one.run === run ? { ...one, ...(worktree ? { worktree } : {}), ...(branch ? { branch } : {}) } : one)))
    }
    if (name === 'complete_work' && typeof data?.run === 'number') {
      const run = data.run
      await update($, claims, list => list.filter(one => one.run !== run))
    }
    await adopt($, name, data)
    // A proof the model asked for is run here and now, by the plugin: the commands, the sandbox and the report are
    // proof.ts's, and the model reads only what CodeBook recorded. A failure to run it never fails the model's call.
    if (name === 'request_proof') {
      const asked = (data as { proof?: unknown } | null)?.proof
      if (typeof asked === 'number') {
        let told: string
        try {
          // The run that asked (its `run`, else the run this loop holds): its worktree, at its pull request's head, is
          // where the proof runs, never the person's own checkout on another branch (P1).
          const repository = (data as { repository?: unknown } | null)?.repository
          const hint = hintOf(await read($, claims), (e as { run?: unknown }).run, e.agentId, typeof repository === 'string' ? repository : null)
          told = (await runProof($, { proof: asked, known: await read($, checkouts), hosts: proofHosts, hint })).text
        } catch (error) {
          told = `The CodeBook plugin could not run proof ${asked} here: ${error instanceof Error ? error.message : String(error)}. It is still waiting; /factory prove tries again.`
        }
        return { ...ran, context: [...(ran.context ?? []), told] }
      }
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : String(e.tool) === OWN_CLAIM ? { deny: CLAIM_REFUSED } : next(e)))

  // The repository guard (G5 decision 6), per run (P2): a run's lease is the agent loop's that claimed it. That loop
  // (the station's worker) pushes and opens pull requests only in the repositories its brief lists; any other loop of
  // the session reaches anything but the repositories held runs work on. With no run held it stands aside. It only
  // ever refuses.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const held = await read($, claims)
    const lease = leaseOf(held, e.agentId)
    if (lease.kind === 'free') return next(e)
    const reading = readCommand(String(e.command ?? ''))
    const runs = lease.runs.join(', ')
    if (reading === null) {
      return { deny: `CodeBook: the repository guard cannot tell where this command pushes or opens a pull request, so it was not run while CodeBook run ${runs} is worked here. Run the push on its own, plainly: git -C <checkout> push <remote> <branch>, and open the pull request with gh pr create --repo <owner/name>.` }
    }
    const say = (why: string) => ({ deny: `CodeBook: the repository guard did not run this while CodeBook run ${runs} is worked here: ${why}` })
    // The person's own shell aliases and functions (`gp` for `git push fork`), probed once every ten minutes.
    const shell = await shellState($)
    const ownWords = await checkShellWords($, reading.programs, shell)
    if (ownWords) return say(ownWords.deny)
    // What may push without saying so: an alias, an extension, a script, a make target, the hooks (resolve.ts).
    for (const check of reading.checks) {
      const refused = await checkOne($, check, reading.pushLike)
      if (refused) return say(refused.deny)
    }
    const targets = reading.targets
    if (targets.length > 0 && !shell.ok) return say("the guard could not read this session's shell (its GH_REPO and GIT_* settings) in time, so it cannot tell where this goes. Try again; if it keeps failing, check that your shell starts without waiting for input.")
    const env = shell.env
    for (const target of targets) {
      const found = await reaches($, target, env)
      if (!Array.isArray(found)) return { deny: `CodeBook: the repository guard did not run this while CodeBook run ${runs} is worked here: ${found.deny}` }
      for (const repo of found) {
        if (mayReach(lease, repo)) continue
        const what = target.kind === 'push' ? `git push to ${target.remote ?? 'the branch\'s default remote'}` : 'gh pr create'
        const where = repo ?? 'a repository the guard could not tell'
        if (lease.kind === 'bystander') {
          return { deny: repo === null
            ? `CodeBook: ${what} reaches ${where}, and CodeBook run ${runs} is worked in this session on ${lease.held.join(', ')}, so the guard cannot tell it is not one of those. Push with a GitHub address or remote it can read, plainly: git -C <checkout> push <remote> <branch>.`
            : `CodeBook: ${what} reaches ${where}, which CodeBook run ${held.filter(one => one.repos.includes(repo)).map(one => one.run).join(', ')} works on in this session. Only that run's worker (the agent that claimed it) pushes there while it is held; any other repository is not the guard's.` }
        }
        const may = lease.allowed.length > 0 ? lease.allowed.join(', ') : 'no repository (its brief names none)'
        return { deny: `CodeBook: ${what} reaches ${where}. While CodeBook run ${runs} is worked here, the factory allows ${may}.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CodeBook: the repository guard failed, so the push was not made. Try again.' }))

  // A checkout that knows its factory (checkout.ts). In a factory's checkout, outside a station's run, a push, a pull
  // request or a merge is put to the person: they allow it ("myself, this once") or refuse it and have the factory do the
  // work. It only ever asks, it never refuses, and in any other folder it does nothing. /factory outside turns it off
  // for the session. A failure here stands aside: the engine's own decision is the answer.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e.input as { command?: unknown } | null)?.command ?? '')
    const below = await next(e)
    if (below.decision === 'deny' || !/\bpush\b|\bpr\s+(?:create|new|merge)\b/.test(command)) return below
    // While this loop holds a run, the repository guard decides: its pushes are the station's own. Another loop's push
    // is asked about as it would be with nothing held (and the guard still refuses it a held run's repository).
    if (leaseOf(await read($, claims), (e as { agentId?: string }).agentId).kind === 'worker') return below
    const reading = readCommand(command)
    const reaches: Reach[] = []
    if (reading === null) reaches.push({ what: 'push', dir: await $.session.cwd() })
    else {
      for (const target of reading.targets) reaches.push({ what: target.kind, dir: await folderOf($, target.cwd) })
      for (const merge of reading.merges) reaches.push({ what: 'merge', dir: await folderOf($, merge.cwd) })
    }
    if (reaches.length === 0) return below
    const why = await askBefore($, reaches, 2500)
    return why === null ? below : { decision: 'ask', reason: why }
  }).catch(($, e, next) => next(e))

  // The conversation's own context, at its first request and again after a compaction: in a factory's checkout, the
  // manager's instructions as CodeBook words them. In any other folder, nothing.
  on('prompt.context', async ($, e, next) => {
    let note: string | null = null
    try { note = await contextBlock($, 3000) } catch { note = null }
    return next(note === null ? e : { ...e, blocks: [...e.blocks.filter(block => block.name !== 'codebookFactory'), { name: 'codebookFactory', text: note }] })
  }).catch(($, e, next) => next(e))

  // Each prompt: when the session has come into a factory's checkout the model was not told about (the answer arrived
  // after the conversation began, or the session moved to another folder), the note rides with this prompt; one line
  // when it has left one. Nothing otherwise, and a slash command is left alone.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    let note: string | null = null
    try { note = await promptNote($, 2000) } catch { note = null }
    return next(note === null ? e : { ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'factory',
      description: 'CodeBook factories: open the Factory pane, start a story (run), or show its status',
      argumentHint: '[overnight <factory> "<goal>" [--max-usd <amount>] [--deadline <ISO time>] | report <factory> <WO-7> | backlog <factory> | run <factory> "<story>" | status | follow <story> | here | cloud | stop | outside | inside | prove]',
    })
    // Which factory works on this folder's repository, asked now so the first prompt need not wait (never awaited, never fatal).
    try { await sweepCheckouts($) } catch { /* next session */ }
    void askAtStart($, e.cwd).catch(() => null)
    const storedMode = await $.store.get(STORE_MODE)
    if (storedMode === 'here' || storedMode === 'cloud') await update($, mode, () => storedMode)
    await restoreSession($)
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

    if (lower === 'prove') {
      const wanted = rest[0] ? Number(rest[0].replace(/^#/, '')) : null
      if (wanted !== null && !Number.isSafeInteger(wanted)) return { text: 'Usage: /factory prove [<proof number>]' }
      if (wanted === null) {
        const peeked = await waitingProofs($)
        if (!peeked.ok) return { text: peeked.message }
        if (peeked.waiting.length === 0) return { text: 'No proof run is waiting for this computer. One is asked for by an agent (request_proof) or with "Try it" under Factory settings → Proof runs.' }
      }
      const done = await runProof($, { proof: wanted, known: await read($, checkouts), hosts: proofHosts })
      return { text: done.text }
    }

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

    if (lower === 'run' || lower === 'start' || lower === 'overnight') {
      const overnight = lower === 'overnight'
      const usage = overnight ? overnightUsage : '/factory run <factory> "<story title>"'
      const options = overnight ? overnightArguments(rest) : { args: rest, limits: {} }
      if ('error' in options) return { text: options.error }
      let where = await read($, mode)
      const args = options.args.filter(word => {
        if (word === '--here') where = 'here'
        else if (word === '--cloud') where = 'cloud'
        else return true
        return false
      })
      if (args.length === 0) return { text: `Usage: ${usage}\n\n${HELP}` }
      const failed = await loadFactories($)
      if (failed) return { text: failed }
      const names = ((await read($, factories)) ?? []).map(f => f.name)
      const split = splitRun(args, names, (await read($, picked))?.name ?? null)
      if (split !== null && !split.title) {
        return { text: `What should ${split.factory} make? Usage: ${usage}` }
      }
      if (split === null) {
        return {
          text: `Which factory? Start with one of yours: ${names.map(name => `"${name}"`).join(', ')}.\nUsage: ${usage}`,
        }
      }
      if (overnight) {
        const request = overnightRequest(split.factory, split.title, options.limits)
        const filled = await $.prompt.fill({ text: request, mode: 'replace' })
        return { text: filled.isFilled ? 'Press Enter to draft the overnight plan. You can review its milestones before work starts.' : request }
      }
      const request = startRequest(split.factory, split.title, where)
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

    if (lower === 'backlog') return { text: await backlogText($, rest) }

    if (lower === 'report') {
      const order = rest.at(-1) ?? '', factory = rest.slice(0, -1).join(' ')
      if (!factory || !/^wo-?[1-9]\d*$/i.test(order)) return { text: 'Usage: /factory report <factory> <WO-7>' }
      const got = await call<WorkOrderReport>($, 'work_orders', { factory, order })
      if (!got.ok) return { text: got.message }
      return { text: orderReport(got.data) }
    }
    if (lower === 'status') return statusText($)

    if (lower === 'follow') {
      const [storyRef = '', ...factoryWords] = rest
      const factory = factoryWords.join(' ')
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
          ? "Agent stations of the stories you start run here, with your Claude, in the factory's checkout on this computer (Factory settings → Your computer)."
          : "Agent stations of the stories you start run in CodeBook's cloud."
      return { text: moved ? `${next}\n${moved}` : next }
    }

    if (lower === 'outside' || lower === 'inside') return { text: await outsideCommand($, lower === 'outside') }

    if (lower === 'stop') {
      await unfollow($)
      return { text: 'Stopped following the story. It keeps moving on app.codebook.work.' }
    }

    return { text: `I don't know "/factory ${verb}".\n\n${HELP}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'codebook-factory' }, async ($, e) => drawPane($, e))
}
