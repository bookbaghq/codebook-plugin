// A checkout that knows its factory (0.20.0; codebook-app docs/MCP-CONNECTOR.md §30).
//
// When a session works in a folder whose git origin is a repository one of the person's CodeBook factories works on,
// the session is that factory's manager for anything that changes code: this module finds that out by itself, hands the
// model the manager's instructions as CodeBook words them (`checkout_factory`, the same text ChatGPT and Codex are
// given), and tells register.tsx when a `git push`, `gh pr create` or `gh pr merge` should be put to the person first.
// In any other folder it adds nothing and asks nothing.
//
// It never slows or fails a session: every git call and every call to CodeBook is bounded, a session that is signed
// out or offline simply learns nothing (and is asked again in a few minutes, not on every prompt), and what CodeBook
// last answered for a repository is kept, so the next session in that folder knows at once and asks again behind it.
//
// What is sent to CodeBook: the repository's host and "owner/name", never the address as git holds it (which may
// carry a user name or a token) and never the folder.

import type { EngineInterface } from 'claude-code'

import { call } from './connector'

/** What `checkout_factory` answers, as far as this module reads it. */
export type CheckoutAnswer = {
  repository?: { name?: string; host?: string | null }
  factory_work?: boolean
  outside?: boolean
  factories?: { name?: string; outside?: boolean; local?: { checkout_path?: string | null } | null }[]
  instructions?: string | null
  message?: string
}

/** What CodeBook last said about one repository. */
export type Known = {
  key: string
  at: number
  repository: string
  factoryWork: boolean
  outside: boolean
  factories: string[]
  instructions: string | null
  /** The folder the person saved for it, when they saved one. */
  saved: string | null
}

/** A folder that is a git checkout with an origin on a host. */
export type Checkout = { top: string; host: string; name: string; key: string }

const STORE = 'checkout-1:'
const STORE_OUTSIDE = 'checkout-outside-1:'
const FRESH_MS = 60 * 1000
const REFRESH_WAIT_MS = 1000
const KEEP_MS = 30 * 24 * 3600 * 1000
const RETRY_MS = 5 * 60 * 1000
const GIT_MS = 3000
const FOLDER_MS = 60 * 1000

/** `{ host, name }` from an origin in any spelling; null for a folder, a bundle or anything that is not a host's repository. */
export function remoteOf(origin: string): { host: string; name: string } | null {
  const text = origin.trim()
  if (text === '' || /\s/.test(text)) return null
  let host = ''
  let path = ''
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text)
  const scp = url ? null : /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(text)
  if (url) {
    if (!/^(?:https?|ssh|git|git\+ssh):/i.test(text)) return null
    host = url[1] ?? ''
    path = url[2] ?? ''
  } else if (scp) {
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else return null
  const segments = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(part => part !== '')
  if (segments.length < 2 || segments.some(part => !/^[A-Za-z0-9._~-]+$/.test(part))) return null
  host = host.toLowerCase().replace(/^www\./, '')
  if (host === 'ssh.github.com') host = 'github.com'
  return { host, name: segments.join('/') }
}

// Module memory: rebuilt after a reload from the store and the next prompt.
const folders = new Map<string, { at: number; checkout: Checkout | null }>()
const pending = new Map<string, Promise<Known | null>>()
const failed = new Map<string, number>()
/** Per session: the repository whose instructions the model has been given, and when. */
const told = new Map<string, { key: string; at: number }>()

/** For tests: forget what this process learned. */
export function forgetCheckouts(): void {
  folders.clear()
  pending.clear()
  failed.clear()
  told.clear()
}

/** `work`, or null when it has not settled within `ms` (or failed). The wait is the engine's clock: a module has no timer of its own. */
async function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | null> {
  const late = $.clock.sleep(ms).then(() => null, () => null)
  return Promise.race([work.catch(() => null), late])
}

async function git($: EngineInterface, dir: string, args: string[]): Promise<string | null> {
  try {
    const got = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: GIT_MS })
    return got.exitCode === 0 ? got.stdout.trim() : null
  } catch {
    return null
  }
}

/** The checkout a folder is in, or null: not a git checkout, no origin, or an origin that is not on a host. */
export async function checkoutOf($: EngineInterface, dir: string): Promise<Checkout | null> {
  const now = await $.clock.now()
  const seen = folders.get(dir)
  if (seen && now - seen.at < FOLDER_MS) return seen.checkout
  let checkout: Checkout | null = null
  const origin = await git($, dir, ['remote', 'get-url', 'origin'])
  const remote = origin === null ? null : remoteOf(origin.split('\n')[0] ?? '')
  if (remote !== null) {
    const top = (await git($, dir, ['rev-parse', '--show-toplevel'])) ?? dir
    checkout = { top, host: remote.host, name: remote.name, key: `${remote.host}/${remote.name}`.toLowerCase() }
  }
  folders.set(dir, { at: now, checkout })
  return checkout
}

function knownOf(key: string, at: number, data: CheckoutAnswer | null): Known | null {
  if (data === null || typeof data.factory_work !== 'boolean') return null
  const factories = (data.factories ?? []).map(one => one.name).filter((name): name is string => typeof name === 'string' && name !== '')
  const saved = (data.factories ?? []).map(one => one.local?.checkout_path).find((path): path is string => typeof path === 'string' && path !== '') ?? null
  return {
    key,
    at,
    repository: data.repository?.name ?? key,
    factoryWork: data.factory_work,
    outside: data.outside === true,
    factories: [...new Set(factories)],
    instructions: typeof data.instructions === 'string' && data.instructions !== '' ? data.instructions : null,
    saved,
  }
}

async function stored($: EngineInterface, key: string): Promise<Known | null> {
  const kept = (await $.store.get(STORE + key)) as Partial<Known> | undefined
  return kept && typeof kept.at === 'number' && typeof kept.factoryWork === 'boolean' && Array.isArray(kept.factories) ? (kept as Known) : null
}

async function ask($: EngineInterface, checkout: Checkout): Promise<Known | null> {
  const got = await call<CheckoutAnswer>($, 'checkout_factory', { repository: checkout.name, host: checkout.host })
  const now = await $.clock.now()
  const known = got.ok ? knownOf(checkout.key, now, got.data) : null
  if (known === null) {
    failed.set(checkout.key, now)
    return null
  }
  failed.delete(checkout.key)
  await $.store.set(STORE + checkout.key, known)
  return known
}

function lookup($: EngineInterface, checkout: Checkout): Promise<Known | null> {
  const running = pending.get(checkout.key)
  if (running) return running
  const work = ask($, checkout)
    .catch(() => null)
    .finally(() => pending.delete(checkout.key))
  pending.set(checkout.key, work)
  return work
}

/**
 * What CodeBook says about a checkout's repository. An answer kept within the last minute is used as it is. An older
 * one is asked again, waited for one second at most, and used as kept when CodeBook does not answer in time: so a
 * switch the person flipped on the website is seen within a minute, and a session offline keeps what it knew. With
 * nothing kept, CodeBook is asked and waited for at most `waitMs`. Null when nothing is known in time.
 */
export async function knownFor($: EngineInterface, checkout: Checkout, waitMs: number): Promise<Known | null> {
  const now = await $.clock.now()
  const kept = await stored($, checkout.key)
  const recentlyFailed = now - (failed.get(checkout.key) ?? 0) < RETRY_MS
  if (kept !== null) {
    // A question already on its way (a session that has just started asks again) is worth the same short wait.
    const running = pending.get(checkout.key)
    if (running === undefined && (now - kept.at <= FRESH_MS || recentlyFailed)) return kept
    const again = running ?? lookup($, checkout)
    return waitMs > 0 ? ((await within($, again, Math.min(waitMs, REFRESH_WAIT_MS))) ?? kept) : kept
  }
  if (recentlyFailed) return null
  const work = lookup($, checkout)
  return waitMs > 0 ? within($, work, waitMs) : null
}

/**
 * At session start: ask CodeBook about the folder's repository again, whatever is kept, without waiting. A session
 * started after the person flipped their switch on the website, or after a repository joined or left a factory, then
 * knows by its first prompt.
 */
export async function askAtStart($: EngineInterface, dir: string): Promise<void> {
  const checkout = await checkoutOf($, dir)
  if (checkout === null) return
  const now = await $.clock.now()
  if (now - (failed.get(checkout.key) ?? 0) < RETRY_MS) return
  void lookup($, checkout)
}

/** A connector answer the model itself asked for: kept, so the session need not ask again. */
export async function adoptCheckout($: EngineInterface, tool: string, args: unknown, data: unknown): Promise<void> {
  if (tool !== 'checkout_factory' && tool !== 'work_outside_factory') return
  const asked = args as { repository?: unknown; host?: unknown } | null
  const answered = data as (CheckoutAnswer & { repository?: unknown; outside?: boolean }) | null
  const named = typeof asked?.repository === 'string' ? asked.repository : ''
  const remote = remoteOf(named) ?? (typeof asked?.host === 'string' && /^[^/\s]+\/[^\s]+$/.test(named) ? { host: asked.host.toLowerCase(), name: named.replace(/\.git$/i, '') } : null)
  if (remote === null || answered === null) return
  const key = `${remote.host}/${remote.name}`.toLowerCase()
  if (tool === 'checkout_factory') {
    const known = knownOf(key, await $.clock.now(), answered)
    if (known !== null) await $.store.set(STORE + key, known)
    return
  }
  // The person's own switch changed: what was kept is out of date, so it is asked again.
  await $.store.delete(STORE + key)
  failed.delete(key)
}

// ── "myself, in this session" ───────────────────────────────────────────────

type KeptOutside = { at: number; keys: string[] }

async function outsideKeys($: EngineInterface): Promise<string[]> {
  const kept = (await $.store.get(STORE_OUTSIDE + (await $.session.id()))) as Partial<KeptOutside> | undefined
  return Array.isArray(kept?.keys) ? kept.keys.filter((key): key is string => typeof key === 'string') : []
}

/** Turn the factory off (or back on) for this session in one repository. */
export async function setSessionOutside($: EngineInterface, key: string, outside: boolean): Promise<void> {
  const own = STORE_OUTSIDE + (await $.session.id())
  const keys = (await outsideKeys($)).filter(one => one !== key)
  if (outside) keys.push(key)
  if (keys.length === 0) await $.store.delete(own)
  else await $.store.set(own, { at: await $.clock.now(), keys } satisfies KeptOutside)
}

/** At session start: sessions that have gone leave nothing behind, and neither do repositories not seen for a month. */
export async function sweepCheckouts($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const own = STORE_OUTSIDE + (await $.session.id())
  for (const key of await $.store.keys()) {
    if (key === own || !(key.startsWith(STORE_OUTSIDE) || key.startsWith(STORE))) continue
    const kept = (await $.store.get(key)) as { at?: unknown } | undefined
    if (typeof kept?.at !== 'number' || now - kept.at > KEEP_MS) await $.store.delete(key)
  }
}

// ── what the session is told ────────────────────────────────────────────────

/** The factory's checkout this session is in and works inside of, or null. */
export async function factoryHere($: EngineInterface, dir: string, waitMs: number): Promise<{ checkout: Checkout; known: Known } | null> {
  const checkout = await checkoutOf($, dir)
  if (checkout === null) return null
  const known = await knownFor($, checkout, waitMs)
  if (known === null || !known.factoryWork || known.outside) return null
  if ((await outsideKeys($)).includes(checkout.key)) return null
  return { checkout, known }
}

const names = (known: Known): string => known.factories.map(name => `"${name}"`).join(', ') || 'a CodeBook factory'

/** What the model reads when the session is in a factory's checkout: CodeBook's own words, then what only Claude Code adds. */
export function contextText(checkout: Checkout, known: Known): string {
  return [
    `CodeBook: this folder (${checkout.top}) is a checkout of ${known.repository}, which the CodeBook factory ${names(known)} works on. In this session you are that factory's manager for every request that changes code, opens a pull request or merges one: use the codebook:factory-manager skill for it, and do not make the change yourself. A question or a read needs no story.`,
    known.instructions ?? `Call the CodeBook connector's checkout_factory tool (repository "${checkout.name}", host "${checkout.host}") for the manager's instructions before the first such request.`,
    [
      'In Claude Code:',
      '- Outside a station\'s run, the CodeBook plugin puts `git push`, `gh pr create` and `gh pr merge` in this checkout to the person before they run. Do not try another way round it.',
      '- If the person says they are working outside the factory here, do as they say. They can turn the question off for this session with /factory outside (and back on with /factory inside); for always, in every assistant, save it with work_outside_factory, only on their own words.',
      '- A sub-agent working a station\'s run it claimed follows that run\'s brief, not this note.',
    ].join('\n'),
  ].join('\n\n')
}

/** One line for a session that has left a factory's checkout it was told about. */
export function leftText(repository: string): string {
  return `CodeBook: this session is no longer working in the factory's checkout of ${repository} (another folder, or the person works outside the factory there now). The factory manager's instructions do not apply here: work as usual.`
}

/**
 * For the conversation's own context (its first request, and again after a compaction): the note for the folder the
 * session is in, or null. A note this turn's prompt already carried is not sent twice.
 */
export async function contextBlock($: EngineInterface, waitMs: number): Promise<string | null> {
  const here = await factoryHere($, await $.session.cwd(), waitMs)
  if (here === null) return null
  const session = await $.session.id()
  const now = await $.clock.now()
  const before = told.get(session)
  if (before && before.key === here.checkout.key && now - before.at < 5000) return null
  told.set(session, { key: here.checkout.key, at: now })
  return contextText(here.checkout, here.known)
}

/**
 * For one prompt: the note when the session has come into a factory's checkout the model has not been told about (a
 * lookup that came back after the conversation began, another folder), one line when it has left one, else null.
 */
export async function promptNote($: EngineInterface, waitMs: number): Promise<string | null> {
  const session = await $.session.id()
  const before = told.get(session)
  const here = await factoryHere($, await $.session.cwd(), waitMs)
  if (here === null) {
    if (!before) return null
    told.delete(session)
    const kept = await stored($, before.key)
    return leftText(kept?.repository ?? before.key)
  }
  if (before?.key === here.checkout.key) return null
  told.set(session, { key: here.checkout.key, at: await $.clock.now() })
  return contextText(here.checkout, here.known)
}

// ── the question before a push, a pull request or a merge ───────────────────

/** Where a command pushes, opens a pull request or merges, as guard.ts read it. */
export type Reach = { what: 'push' | 'pr' | 'merge'; dir: string }

const WHAT = { push: 'git push', pr: 'gh pr create', merge: 'gh pr merge' } as const

/**
 * Why the person should be asked before this command runs, or null when they need not be: none of what it reaches is
 * a factory's checkout this session works inside of.
 */
export async function askBefore($: EngineInterface, reaches: Reach[], waitMs: number): Promise<string | null> {
  for (const reach of reaches) {
    const here = await factoryHere($, reach.dir, waitMs)
    if (here === null) continue
    return `CodeBook: ${here.known.repository} is worked by the factory ${names(here.known)}, and this ${WHAT[reach.what]} does not come from one of its stations' runs. Allow it to do this yourself, this once. Or refuse it and ask Claude to put the change through the factory (a story, "proceed?", then the stations). /factory outside turns this question off for this session.`
  }
  return null
}

/** `/factory outside` and `/factory inside`: the factory off or on for this session, in the folder it is in. */
export async function outsideCommand($: EngineInterface, outside: boolean): Promise<string> {
  const checkout = await checkoutOf($, await $.session.cwd())
  if (checkout === null) return 'This folder is not a git checkout with an origin, so no factory works on it: there is nothing to turn off.'
  const known = await knownFor($, checkout, 4000)
  if (known === null) return `CodeBook could not be asked about ${checkout.name} just now (signed out or offline), so nothing changed. /factory list checks the sign-in.`
  if (!known.factoryWork && !known.outside) return `No CodeBook factory of yours works on ${known.repository}: Claude already works as usual here.`
  if (known.outside) return `You already work outside the factory in ${known.repository}, in every assistant (Factory settings → Your computer in CodeBook turns that off).`
  await setSessionOutside($, checkout.key, outside)
  return outside
    ? `For this session you work outside the factory ${names(known)} in ${known.repository}: Claude works as usual here and is not asked before a push. /factory inside turns it back on. To work outside it in every session and every assistant, tell Claude "I work outside the factory here", or use Factory settings → Your computer in CodeBook.`
    : `This session works through the factory ${names(known)} in ${known.repository} again.`
}

/** One line for /factory status about the folder the session is in, or null when no factory works on it. */
export async function checkoutLine($: EngineInterface): Promise<string | null> {
  const checkout = await checkoutOf($, await $.session.cwd())
  if (checkout === null) return null
  const known = await knownFor($, checkout, 0)
  if (known === null || (!known.factoryWork && !known.outside)) return null
  const session = (await outsideKeys($)).includes(checkout.key)
  const how = known.outside ? 'you work outside the factory here, in every assistant' : session ? 'you work outside the factory here for this session (/factory inside turns it back on)' : 'code changes here go through the factory (/factory outside turns that off for this session)'
  return `This folder: a checkout of ${known.repository}, worked by the factory ${names(known)} — ${how}.`
}
