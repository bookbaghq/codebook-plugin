// Saving Run here conversations to CodeBook: every turn of a session that used CodeBook, and each of its sub-agents.
//
// WHERE IT READS. The session's own transcript file, not the engine's `$.session.messages`, which answers only the newest
// 4096 rows, and only of the session it runs in: a transcript survives the session, so the same code catches up after being
// offline or after the session ended. `$.fs.read` refuses a file over 4 MiB and a real one is 80 MB, so a chunk is cut
// with tail and head. A place is kept per file, per session, in `$.store`, and moves only after CodeBook said it has the
// rows, so a failed upload is simply sent again. CodeBook keeps the first copy of each block, so sending twice is harmless.
//
// PERMISSION. Claude Code's permission check still judges `$.mcp.call`: auto mode's classifier refuses a call no message asked for, a
// headless session has nobody to ask, and the engine skips this plugin's own tool.check for a call it raised itself. So saving needs one
// allow rule from the person, like the pane's reads (README). Status and one toast say so; the plugin does not change their permissions.
//
// NEVER IN THE SESSION'S WAY. A hook here only notes that there is something to do. The work runs on the pane's one-second
// timer, one chunk at a time, one at a time, and a failure waits and tries later, silently. /factory capture status says what
// happened. Only session.end waits, for at most SESSION_END_WAIT_MS; under `claude -p` the connector is already gone by then, so what the last
// seconds said goes up from the next session.
//
// WHAT GOES. Which sessions: only those that called CodeBook; a conversation that never touched it stays on this computer. Which
// rows: what was said, thought, called and answered, compaction summaries, and messages queued while a turn ran. Not the
// transcript's bookkeeping (API request records, file history, cost, the instruction text repeated on every turn), about
// three quarters of the file. Images go as a line saying one was there. Everything is checked for secrets first (redact.ts).
//
// THE SWITCH. `/factory capture off` here, or Saved conversations in the app for every computer. While off the place moves
// past what is said, so turning it back on never uploads what was said meanwhile.

import type { EngineInterface } from 'claude-code'
import { call } from './connector'
import { isEnvFile, redactSecrets } from './redact'

const STORE_CAPTURE = 'capture-1:'
const STORE_OFF = 'capture-off'
const TOOL = 'capture_transcript'

const CHUNK_BYTES = 1024 * 1024
const MAX_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_BATCH_CHARS = 500_000
const MAX_BATCH_ENTRIES = 400
export const MAX_BLOCK_CHARS = 280_000
const BLOCK_TAIL = 50_000
const IDLE_SCAN_MS = 20_000
const OTHERS_SCAN_MS = 150_000
const LONG_QUIET_MS = 86_400_000
const OTHERS_QUIET_MS = 120_000
const FORGET_AFTER_MS = 30 * 86_400_000
const MIN_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 300_000
const HOLD_MS = 1_800_000
const UPLOAD_TIMEOUT_MS = 45_000
const SESSION_END_WAIT_MS = 2_000
const MAX_LINKS = 40
const PERMISSION_RULE = 'Claude Code\'s permission check refuses this upload, so nothing is being saved. To allow it, add "mcp__plugin_codebook_codebook__capture_transcript" to permissions.allow in ~/.claude/settings.json. It lets this plugin save your own conversation to your own account, and nothing else.'

/** Where one file was read up to. */
export type FilePlace = {
  offset: number
  seq: number
  /** Links CodeBook has been sent, as `factory|story|run`. */
  sent: string[]
  /** Tool calls that named an env file, so their results are not uploaded. */
  envCalls: string[]
}
/** One session and its agents. */
export type Kept = { path: string | null; main: FilePlace; agents: Record<string, FilePlace>; at: number; project?: string }

export type Entry = {
  key: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'summary' | 'system' | 'other'
  text: string
  at?: string | number
  tool_name?: string
  tool_call_id?: string
  is_error?: boolean
  is_meta?: boolean
  model?: string
  cut_bytes?: number
}
export type Link = { factory?: string; story?: string; run?: number }
export type Meta = { title?: string; project?: string; git_branch?: string; model?: string; version?: string }

const newPlace = (): FilePlace => ({ offset: 0, seq: 0, sent: [], envCalls: [] })

/** Bytes of a string as UTF-8, to move a place along a file read as text. */
export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

const clip = (text: string): { text: string; cut_bytes?: number } =>
  text.length <= MAX_BLOCK_CHARS
    ? { text }
    : { text: `${text.slice(0, MAX_BLOCK_CHARS - BLOCK_TAIL)}\n[… ${text.length} characters in all; the middle was not saved …]\n${text.slice(-BLOCK_TAIL)}`, cut_bytes: utf8Length(text) }

const ENV_WORD = /(?:^|[\s/'"=:])(\.env(?:\.[A-Za-z0-9_-]+)?)(?=$|[\s'"|;&)<>])/g

/** Whether a tool call's input names a file that holds environment secrets. */
export function namesEnvFile(input: unknown): boolean {
  const seen = input as { file_path?: unknown; path?: unknown; command?: unknown } | null
  if (isEnvFile(seen?.file_path) || isEnvFile(seen?.path)) return true
  const command = typeof seen?.command === 'string' ? seen.command : ''
  for (const match of command.matchAll(ENV_WORD)) if (isEnvFile(match[1])) return true
  return false
}

/** A tool result's text; an image in it becomes a line saying so. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  return content.map((part: { type?: string; text?: string }) => (part?.type === 'text' ? part.text ?? '' : part?.type === 'image' ? '[an image was here; it was not saved]' : JSON.stringify(part))).join('\n')
}

// The connector's tools in a transcript name what the session worked on, so links survive a catch-up.
const OWN_TOOL = /^mcp__plugin_[a-z0-9-]+_codebook__(.+)$/

function linkOf(input: unknown): Link | null {
  const seen = input as { factory?: unknown; story?: unknown; run?: unknown } | null
  const link: Link = {}
  if (typeof seen?.factory === 'string' && seen.factory) link.factory = seen.factory
  if (typeof seen?.story === 'string' && seen.story) link.story = seen.story
  if (typeof seen?.run === 'number' && seen.run > 0) link.run = seen.run
  return link.factory || link.story || link.run ? link : null
}

type Row = Record<string, any>
export type Parsed = { entries: Entry[]; links: Link[]; meta: Meta; redacted: number }

/**
 * What one transcript row saves. Pure: `place.envCalls` is the only thing it changes, and it changes it only with what the
 * rows say, so reading the same rows again gives the same answer.
 */
export function parseRow(row: Row, place: FilePlace, out: Parsed): void {
  const push = (partial: Omit<Entry, 'key' | 'seq'>, key: string) => {
    const checked = redactSecrets(partial.text)
    out.redacted += checked.count
    const clipped = clip(checked.text)
    out.entries.push({ ...partial, ...clipped, key, seq: place.seq + out.entries.length })
  }
  const at = row.timestamp
  if (row.type === 'custom-title' && row.customTitle) out.meta.title = String(row.customTitle)
  if (row.type === 'agent-name' && row.agentName && !out.meta.title) out.meta.title = String(row.agentName)
  if (row.cwd) out.meta.project = String(row.cwd).split(/[\\/]/).filter(Boolean).pop()
  if (row.gitBranch) out.meta.git_branch = String(row.gitBranch)
  if (row.version) out.meta.version = String(row.version)
  if (row.type === 'system') {
    if (['compact_boundary', 'api_error', 'informational', 'local_command'].includes(row.subtype)) {
      const text = row.subtype === 'compact_boundary' ? 'Conversation compacted' : typeof row.content === 'string' ? row.content : String(row.subtype)
      push({ role: 'system', kind: 'system', text, at }, `${row.uuid}:0`)
    }
    return
  }
  if (row.type === 'attachment') {
    // A message typed while a turn ran. Everything else attached is what the engine injects.
    if (row.attachment?.type === 'queued_command' && typeof row.attachment.prompt === 'string') {
      push({ role: 'user', kind: 'text', text: row.attachment.prompt, at, is_meta: row.attachment.origin?.kind !== 'human' }, `${row.uuid}:0`)
    }
    return
  }
  if (row.type !== 'user' && row.type !== 'assistant') return
  const message = row.message ?? {}
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const model = typeof message.model === 'string' && !message.model.startsWith('<') ? message.model : undefined
  if (model) out.meta.model = model
  // What the engine put in the person's mouth: kept, shown only when asked for.
  const injected = (text: unknown) => typeof text === 'string' && /^\s*<system-reminder>/.test(text)
  const is_meta = !!row.isMeta || injected(message.content) || (Array.isArray(message.content) && message.content.length > 0 && message.content.every((b: Row) => b.type === 'text' && injected(b.text)))
  const base = { role, at, model, ...(is_meta ? { is_meta } : {}) } as const
  const kindOfText = row.isCompactSummary ? 'summary' : 'text'
  if (typeof message.content === 'string') {
    if (message.content) push({ ...base, kind: kindOfText, text: message.content }, `${row.uuid}:0`)
    return
  }
  if (!Array.isArray(message.content)) return
  message.content.forEach((block: Row, i: number) => {
    const key = `${row.uuid}:${row.apiBlockIndex ?? i}`
    if (block.type === 'text') { if (block.text) push({ ...base, kind: kindOfText, text: String(block.text) }, key) }
    else if (block.type === 'thinking') { if (block.thinking) push({ ...base, kind: 'thinking', text: String(block.thinking) }, key) }
    else if (block.type === 'tool_use') {
      const isEnv = namesEnvFile(block.input)
      if (isEnv) place.envCalls = [...place.envCalls.slice(-19), String(block.id)]
      const named = OWN_TOOL.exec(String(block.name ?? ''))
      const link = named ? linkOf(block.input) : null
      if (link) out.links.push(link)
      const hasBody = typeof block.input?.content === 'string' || typeof block.input?.new_string === 'string'
      const text = isEnv && hasBody ? JSON.stringify({ file_path: block.input.file_path ?? block.input.path, content: '[removed: .env contents]' }) : JSON.stringify(block.input ?? {})
      push({ ...base, kind: 'tool_use', text, tool_name: String(block.name ?? ''), tool_call_id: String(block.id ?? '') }, key)
    } else if (block.type === 'tool_result') {
      const isEnv = place.envCalls.includes(String(block.tool_use_id))
      push({ ...base, kind: 'tool_result', text: isEnv ? '[removed: .env contents]' : resultText(block.content), tool_call_id: String(block.tool_use_id ?? ''), is_error: !!block.is_error }, key)
    } else if (block.type === 'image') push({ ...base, kind: 'image', text: `[an image was here; it was not saved${block.source?.media_type ? ` (${block.source.media_type})` : ''}]` }, key)
    else {
      const { data: _data, signature: _signature, ...rest } = block
      push({ ...base, kind: 'other', text: JSON.stringify(rest) }, key)
    }
  })
}

/**
 * Whole lines of a chunk as rows. → what they save and how many bytes they took; a line cut off at the end waits for the
 * next chunk, and a line that will not parse (the place landed mid-line after capture was off) is skipped.
 */
export function parseChunk(text: string, place: FilePlace): Parsed & { used: number } {
  const out: Parsed = { entries: [], links: [], meta: {}, redacted: 0 }
  const end = text.lastIndexOf('\n')
  if (end < 0) return { ...out, used: 0 }
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.trim()) continue
    let row: Row
    try { row = JSON.parse(line) } catch { continue }
    parseRow(row, place, out)
  }
  return { ...out, used: utf8Length(text.slice(0, end + 1)) }
}

/** Entries in batches a request can carry. */
export function batchesOf(entries: Entry[]): Entry[][] {
  const out: Entry[][] = []
  let batch: Entry[] = [], size = 0
  for (const entry of entries) {
    const weight = entry.text.length + 200
    if (batch.length && (size + weight > MAX_BATCH_CHARS || batch.length >= MAX_BATCH_ENTRIES)) { out.push(batch); batch = []; size = 0 }
    batch.push(entry); size += weight
  }
  if (batch.length) out.push(batch)
  return out
}

/** Whether a failed call was Claude Code's permission check and not CodeBook or the network. */
export function isPermissionRefusal(code: string, message: string): boolean {
  return code === 'AUTO_MODE' || /permission check refused|requested permissions/i.test(message)
}

// ── the module's memory: rebuilt after a reload, from the store and the next hook ────────────────────────────────────

let busy = false
let due = true
let nextScan = 0
let nextOthers = 0
let backoff = 0
let waitUntil = 0
let serverSays: 'on' | 'off' | 'full' = 'on'
let lastProblem: string | null = null
let askAgainAt = 0
const pathOf = new Map<string, string>()
const settled = new Set<string>()
let told = false
let toldPermission = false

const keyOf = (sessionId: string) => `${STORE_CAPTURE}${sessionId}`
async function keptOf($: EngineInterface, sessionId: string): Promise<Kept | null> {
  return ((await $.store.get(keyOf(sessionId))) as Kept | undefined) ?? null
}

/** The session used CodeBook: it is saved from its first word. Called from a hook, so it only writes down that it should be. */
export async function markSession($: EngineInterface, sessionId: string): Promise<void> {
  if (await keptOf($, sessionId)) return
  await $.store.set(keyOf(sessionId), { path: pathOf.get(sessionId) ?? null, main: newPlace(), agents: {}, at: await $.clock.now() } satisfies Kept)
  due = true
  if (!told && !(await isLocallyOff($))) {
    told = true
    try { await $.ui.toast('CodeBook is saving this conversation to your account. /factory capture off stops it.') } catch { /* no surface to say it on */ }
  }
}

/** What a settings-hook event says about where a session's transcript is. */
export async function noteTranscript($: EngineInterface, sessionId: unknown, path: unknown): Promise<void> {
  due = true
  if (typeof sessionId !== 'string' || typeof path !== 'string' || !path || path.includes('/subagents/')) return
  // Known from the session's first event, because a manager's one turn can run for an hour: it must not wait for the turn's end.
  pathOf.set(sessionId, path)
  const kept = await keptOf($, sessionId)
  if (kept && kept.path !== path) await $.store.set(keyOf(sessionId), { ...kept, path })
}

export const noteDue = (): void => { due = true }
async function isLocallyOff($: EngineInterface): Promise<boolean> {
  return (await $.store.get(STORE_OFF)) === true
}

// ── reading a file ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Bytes `offset` to `offset + length` of a file as text. No Windows without a POSIX shell: says so in status, saves nothing there. */
async function readRange($: EngineInterface, path: string, offset: number, length: number): Promise<string> {
  const got = await $.process.run(['sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', String(offset + 1), path, String(length)], { timeoutMs: 15_000 })
  if (got.exitCode !== 0) throw new Error(`could not read the transcript (exit ${got.exitCode})`)
  return got.stdout
}

async function sizeOf($: EngineInterface, path: string): Promise<number | null> {
  try { return (await $.fs.stat(path)).size } catch { return null }
}

/** The agent's id, type and what it was asked, from the files beside its transcript. */
async function agentMeta($: EngineInterface, file: string): Promise<{ type?: string; label?: string }> {
  try {
    const meta = JSON.parse(String(await $.fs.read(file.replace(/\.jsonl$/, '.meta.json')))) as { agentType?: string; description?: string }
    return { type: meta.agentType, label: meta.description }
  } catch { return {} }
}

/** A session's sub-agent transcripts: `subagents/agent-*.jsonl`, and those of its workflows one level down. */
async function agentFiles($: EngineInterface, path: string): Promise<{ id: string; file: string }[]> {
  const root = `${path.replace(/\.jsonl$/, '')}/subagents`
  const out: { id: string; file: string }[] = []
  const take = async (dir: string) => {
    let entries: { name: string; kind: string }[] = []
    try { entries = await $.fs.list(dir) } catch { return [] as string[] }
    const folders: string[] = []
    for (const entry of entries) {
      if (entry.kind === 'directory') folders.push(`${dir}/${entry.name}`)
      else if (/^agent-.*\.jsonl$/.test(entry.name)) out.push({ id: entry.name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), file: `${dir}/${entry.name}` })
    }
    return folders
  }
  for (const folder of await take(root)) for (const inner of await take(folder)) await take(inner)
  return out
}

// ── one step ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Sent = { ok: true; capture: 'on' | 'off' | 'full'; retentionDays?: number } | { ok: false; wait: number; problem: string }

/** One request, with a ceiling of its own: an upload that hangs must not hold the queue for ever. */
async function send($: EngineInterface, args: Record<string, unknown>): Promise<Sent> {
  const ask = call<{ capture?: 'on' | 'off' | 'full'; retention_days?: number }>($, TOOL, args)
  const timer = $.clock.sleep(UPLOAD_TIMEOUT_MS).then(() => ({ ok: false as const, code: 'TIMEOUT', message: 'the upload timed out', isSignIn: false }))
  const got = await Promise.race([ask, timer])
  if (got.ok) return { ok: true, capture: got.data?.capture ?? 'on', retentionDays: got.data?.retention_days }
  if (isPermissionRefusal(got.code, got.message)) {
    // A timer's upload is not something a person asked for, so it needs the person's rule. Said once, and then in status.
    if (!toldPermission) {
      toldPermission = true
      try { await $.ui.toast('CodeBook cannot save this conversation without your permission: /factory capture status says how.') } catch { /* no surface to say it on */ }
    }
    return { ok: false, wait: MAX_BACKOFF_MS, problem: PERMISSION_RULE }
  }
  const named = /try again in (\d+)\s*s/i.exec(got.message)
  return { ok: false, wait: named ? Number(named[1]) * 1000 : 0, problem: got.isSignIn ? 'Sign in to CodeBook to save conversations (/mcp).' : got.message }
}

/** Reads one chunk of one file and uploads it. → whether anything moved. */
async function stepFile($: EngineInterface, sessionId: string, kept: Kept, agent: { id: string; file: string } | null, path: string, off: boolean, isOwn: boolean): Promise<boolean> {
  const place = agent ? (kept.agents[agent.id] ??= newPlace()) : kept.main
  const size = await sizeOf($, path)
  if (size === null || size <= place.offset) return false
  // `at` says when the session itself was last alive; catching it up does not make it so.
  const save = async () => { await $.store.set(keyOf(sessionId), { ...kept, at: isOwn ? await $.clock.now() : kept.at }) }
  // Off: what is being said now is never uploaded, later included.
  if (off) { place.offset = size; await save(); return false }
  let length = CHUNK_BYTES
  let text = await readRange($, path, place.offset, length)
  if (!text.includes('\n') && size - place.offset > length) {
    length = MAX_CHUNK_BYTES
    text = await readRange($, path, place.offset, length)
    if (!text.includes('\n')) {
      // One row over 4 MiB. Past it, saying so; the rest of the file is worth more than this row.
      const seq = place.seq
      const sent = await send($, { session: { id: sessionId, ...(agent ? { agent: { id: agent.id } } : {}) }, entries: [{ key: `over:${place.offset}`, seq, role: 'system', kind: 'system', text: 'A row of over 4 MB was not saved.' }] })
      if (!sent.ok) return settle($, sent)
      place.seq = seq + 1; place.offset += length; await save()
      return true
    }
  }
  const envBefore = place.envCalls
  const parsed = parseChunk(text, place)
  if (parsed.used === 0) { place.envCalls = envBefore; return false }
  const meta = agent ? { agent: { id: agent.id, ...(await agentMeta($, agent.file)) } } : {}
  const links = parsed.links.filter((l, i, all) => all.findIndex((o) => JSON.stringify(o) === JSON.stringify(l)) === i).filter((l) => !place.sent.includes(`${l.factory}|${l.story}|${l.run}`))
  const session = { id: sessionId, ...parsed.meta, ...meta }
  const batches = batchesOf(parsed.entries)
  // A chunk with nothing to save still moves the place, and a link or title still has to arrive.
  for (let i = 0; i < Math.max(batches.length, links.length || parsed.meta.title ? 1 : 0); i++) {
    const sent = await send($, { session, entries: batches[i] ?? [], ...(i === 0 ? { links: links.slice(0, MAX_LINKS), redacted: parsed.redacted } : {}) })
    if (!sent.ok) { place.envCalls = envBefore; return settle($, sent) }
    if (sent.capture !== 'on') {
      place.envCalls = envBefore
      serverSays = sent.capture
      askAgainAt = (await $.clock.now()) + HOLD_MS
      // Off: what was said is not to be saved, then or later. Full: it is, once there is room, so the place stays.
      if (sent.capture === 'off') { place.offset = size; await save() }
      return false
    }
    serverSays = 'on'
  }
  place.seq += parsed.entries.length
  place.offset += parsed.used
  place.sent = [...place.sent, ...links.map((l) => `${l.factory}|${l.story}|${l.run}`)].slice(-MAX_LINKS)
  backoff = 0; lastProblem = null
  await save()
  return true
}

async function settle($: EngineInterface, sent: Extract<Sent, { ok: false }>): Promise<false> {
  backoff = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoff * 2, sent.wait))
  waitUntil = (await $.clock.now()) + backoff
  lastProblem = sent.problem
  try { $.ui.log(`codebook capture: ${sent.problem}`, { to: 'debug' }) } catch { /* nowhere to say it */ }
  return false
}

/** One session's next chunk. → whether anything moved. */
async function stepSession($: EngineInterface, sessionId: string, off: boolean, isOwn = true): Promise<boolean> {
  const kept = await keptOf($, sessionId)
  if (!kept?.path) return false
  if (await stepFile($, sessionId, kept, null, kept.path, off, isOwn)) return true
  if ((await $.clock.now()) < waitUntil) return false
  for (const agent of await agentFiles($, kept.path)) {
    if (await stepFile($, sessionId, kept, agent, agent.file, off, isOwn)) return true
    if ((await $.clock.now()) < waitUntil) return false
  }
  return false
}

/** Other sessions' files: this computer was offline, or they ended before their last rows went up. Forgets the long finished. */
async function stepOthers($: EngineInterface, own: string, off: boolean, now: number): Promise<boolean> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_CAPTURE) || key === keyOf(own)) continue
    const kept = (await $.store.get(key)) as Kept | undefined
    const session = key.slice(STORE_CAPTURE.length)
    if (!kept || now - kept.at < OTHERS_QUIET_MS) continue
    // One look per process at what has been quiet for a day: a backfill can hold hundreds, and nothing is adding to them.
    if (now - kept.at > LONG_QUIET_MS && settled.has(session)) continue
    const gone = !kept.path || (await sizeOf($, kept.path)) === null
    if (gone && now - kept.at > OTHERS_QUIET_MS) { if (now - kept.at > FORGET_AFTER_MS || kept.path) await $.store.delete(key); continue }
    if (await stepSession($, session, off, false)) return true
    settled.add(session)
    if (now - kept.at > FORGET_AFTER_MS) await $.store.delete(key)
  }
  return false
}

/** From the pane's timer, every second. Does nothing most seconds. */
export async function captureTick($: EngineInterface): Promise<void> {
  if (busy) return
  const now = await $.clock.now()
  if (now < waitUntil) return
  if (!due && now < nextScan) return
  busy = true
  try {
    due = false
    const own = await $.session.id()
    const local = await isLocallyOff($)
    // The app said off or full: the next session asks by uploading; this one asks again now and then.
    if (serverSays !== 'on' && !local && now >= askAgainAt) {
      const asked = await send($, { session: { id: own }, entries: [] })
      if (asked.ok) serverSays = asked.capture
      askAgainAt = now + HOLD_MS
    }
    if (serverSays === 'full' && !local) { nextScan = now + IDLE_SCAN_MS; return }
    const off = local || serverSays === 'off'
    let moved = await stepSession($, own, off)
    if (!moved && now >= nextOthers && now >= waitUntil) {
      moved = await stepOthers($, own, off, now)
      if (!moved) nextOthers = now + OTHERS_SCAN_MS
    }
    // A failure waits (`waitUntil`) and then goes straight back to it; nothing to do waits for the next look.
    if (moved || (await $.clock.now()) < waitUntil) due = true
    else nextScan = now + IDLE_SCAN_MS
  } catch (error) {
    lastProblem = error instanceof Error ? error.message : String(error)
    try { $.ui.log(`codebook capture: ${lastProblem}`, { to: 'debug' }) } catch { /* nowhere to say it */ }
    backoff = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoff * 2))
    waitUntil = now + backoff
  } finally {
    busy = false
  }
}

/** At the session's end, one short try, so the last turn usually does not wait for the next session. */
export async function captureAtEnd($: EngineInterface, sessionId: string): Promise<void> {
  if (busy || (await isLocallyOff($))) return
  busy = true
  try {
    await Promise.race([
      (async () => { for (let i = 0; i < 4; i++) if (!(await stepSession($, sessionId, serverSays === 'off'))) break })(),
      $.clock.sleep(SESSION_END_WAIT_MS),
    ])
  } catch { /* the next session catches up */ } finally { busy = false }
}

// ── /factory capture ─────────────────────────────────────────────────────────────────────────────────────────────────

const OFF_WORDS = 'Conversations from this computer are not being saved to CodeBook. What is said while it is off is never uploaded, even after turning it back on.'

export async function captureCommand($: EngineInterface, verb: string): Promise<string> {
  const word = verb.toLowerCase()
  if (word === 'off') { await $.store.set(STORE_OFF, true); return OFF_WORDS }
  if (word === 'on') {
    await $.store.delete(STORE_OFF)
    serverSays = 'on'; waitUntil = 0; askAgainAt = 0; due = true
    return 'Conversations from this computer are saved to CodeBook again, from now on: every session that uses CodeBook and its sub-agents. Only you can read them, in the app. Secrets are removed first; that is best effort. /factory capture off stops it.'
  }
  if (word === 'backfill') return backfill($)
  const off = await isLocallyOff($)
  const kept = await keptOf($, await $.session.id())
  const pending = (await $.store.keys()).filter((key) => key.startsWith(STORE_CAPTURE)).length
  return [
    off ? OFF_WORDS : serverSays === 'off' ? 'Saving is turned off for your account in the app (Saved conversations).' : serverSays === 'full' ? 'Your saved conversations are at their limit; delete some in the app. This computer holds its place and catches up.' : 'Conversations that use CodeBook are saved to your account as they happen. Only you can read them, in the app.',
    kept ? `This session: ${kept.main.seq} blocks saved${Object.keys(kept.agents).length ? `, and ${Object.keys(kept.agents).length} sub-agents` : ''}.` : 'This session has not used CodeBook, so it is not being saved.',
    `This computer follows ${pending} ${pending === 1 ? 'session' : 'sessions'}.`,
    lastProblem ? `Last problem: ${lastProblem} It will try again.` : '',
    'Secrets are removed before upload and checked again by CodeBook. That is best effort: a password typed into a sentence may not be recognised.',
    '/factory capture on | off | backfill',
  ].filter(Boolean).join('\n')
}

/** Older sessions of this project that used CodeBook: found by reading the files for a call to it, then uploaded like any other. */
async function backfill($: EngineInterface): Promise<string> {
  const own = await keptOf($, await $.session.id())
  if (!own?.path) return 'Use CodeBook in this session first, so it knows where this project\'s conversations are.'
  const dir = own.path.slice(0, own.path.lastIndexOf('/'))
  const names = (await $.fs.list(dir)).filter((e) => e.name.endsWith('.jsonl')).map((e) => e.name)
  let added = 0
  for (let at = 0; at < names.length; at += 50) {
    const part = names.slice(at, at + 50)
    const got = await $.process.run(['grep', '-l', '-E', 'mcp__plugin_[a-z0-9-]+_codebook__', ...part], { cwd: dir, timeoutMs: 120_000 })
    for (const name of got.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const id = name.replace(/\.jsonl$/, '')
      if (await keptOf($, id)) continue
      await $.store.set(keyOf(id), { path: `${dir}/${name}`, main: newPlace(), agents: {}, at: 0 } satisfies Kept)
      added++
    }
  }
  nextOthers = 0; due = true
  return added ? `${added} older ${added === 1 ? 'session' : 'sessions'} of this project will be uploaded in the background, a little at a time. /factory capture status follows it.` : 'No older session of this project used CodeBook, or they are all already followed.'
}
