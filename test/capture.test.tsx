import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { batchesOf, MAX_BLOCK_CHARS, namesEnvFile, parseChunk, utf8Length } from '../hooks/capture'
import type { FilePlace } from '../hooks/capture'
import { isEnvFile, redactSecrets } from '../hooks/redact'

const a = (s: string, n: number) => s.repeat(n)
const place = (): FilePlace => ({ offset: 0, seq: 0, sent: [], envCalls: [] })
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const user = (uuid: string, content: unknown, extra: object = {}) => ({ type: 'user', uuid, timestamp: '2026-11-05T17:00:00.000Z', cwd: '/Users/x/payments', gitBranch: 'main', version: '2.1.317', message: { role: 'user', content }, ...extra })
const assistant = (uuid: string, content: unknown, extra: object = {}) => ({ type: 'assistant', uuid, timestamp: '2026-11-05T17:00:01.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content }, ...extra })

test('the rows of a real transcript become what was said, thought, called and answered; bookkeeping goes nowhere', () => {
  const text = [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'api-request', params: {}, id: 'x' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'attachment', uuid: 'q1', attachment: { type: 'skill_listing', content: 'long' } },
    { type: 'attachment', uuid: 'q2', timestamp: 't', attachment: { type: 'queued_command', prompt: 'And also this', origin: { kind: 'human' } } },
    { type: 'custom-title', customTitle: 'Refund work' },
    user('u1', 'Build the refund export'),
    user('u2', 'Injected', { isMeta: true }),
    assistant('a1', [{ type: 'thinking', thinking: 'Hmm', signature: 'SIGNATURE' }], { apiBlockIndex: 0 }),
    assistant('a2', [{ type: 'text', text: 'On it.' }], { apiBlockIndex: 1 }),
    assistant('a3', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], { apiBlockIndex: 2 }),
    user('u3', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'money.js' }, { type: 'image', source: { data: 'BASE64' } }], is_error: true }]),
    user('u4', [{ type: 'image', source: { media_type: 'image/png', data: 'BASE64' } }]),
    { type: 'system', uuid: 's1', subtype: 'compact_boundary', content: 'Conversation compacted' },
    { type: 'system', uuid: 's2', subtype: 'stop_hook_summary', content: 'x' },
    user('u5', 'Summary of it all', { isCompactSummary: true }),
  ].map(line).join('')
  const parsed = parseChunk(text, place())
  expect(parsed.entries.map((e) => [e.key, e.seq, e.role, e.kind, e.is_meta ?? false])).toEqual([
    ['q2:0', 0, 'user', 'text', false], ['u1:0', 1, 'user', 'text', false], ['u2:0', 2, 'user', 'text', true], ['a1:0', 3, 'assistant', 'thinking', false], ['a2:1', 4, 'assistant', 'text', false], ['a3:2', 5, 'assistant', 'tool_use', false],
    ['u3:0', 6, 'user', 'tool_result', false], ['u4:0', 7, 'user', 'image', false], ['s1:0', 8, 'system', 'system', false], ['u5:0', 9, 'user', 'summary', false],
  ])
  expect(parsed.meta).toEqual({ title: 'Refund work', project: 'payments', git_branch: 'main', version: '2.1.317', model: 'claude-opus-5-5' })
  const all = JSON.stringify(parsed.entries)
  expect(all).not.toContain('SIGNATURE')
  expect(all).not.toContain('BASE64')
  expect(parsed.entries[5]).toMatchObject({ tool_name: 'Bash', tool_call_id: 't1', text: '{"command":"ls"}' })
  expect(parsed.entries[6]).toMatchObject({ tool_call_id: 't1', is_error: true })
  expect(parsed.entries[6].text).toContain('money.js')
  expect(parsed.used).toBe(utf8Length(text))
})

test('a place moves only over whole lines; a line cut off waits; a line that does not parse is passed; multi-byte text counts in bytes', () => {
  const first = line(user('u1', 'héllo → 🌍'))
  const second = line(user('u2', 'second'))
  const parsed = parseChunk(first + second.slice(0, 10), place())
  expect(parsed.entries.map((e) => e.key)).toEqual(['u1:0'])
  expect(parsed.used).toBe(new TextEncoder().encode(first).length)
  expect(parseChunk('no line end yet', place()).used).toBe(0)
  const mid = parseChunk(`middle of a row"}\n${second}`, place())
  expect(mid.entries.map((e) => e.key)).toEqual(['u2:0'])
})

test('secrets are gone before anything would leave: text, tool input and tool results; the count says how many', () => {
  const key = `ghp_${a('Ab1', 12)}`
  const text = [
    user('u1', `use ${key}`),
    assistant('a1', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${a('Ab1', 10)}" postgres://u:${a('Pw2', 4)}@db/x` } }]),
    user('u2', [{ type: 'tool_result', tool_use_id: 't', content: `DB_PASSWORD=${a('Pw2', 4)}` }]),
  ].map(line).join('')
  const parsed = parseChunk(text, place())
  const all = JSON.stringify(parsed.entries)
  expect(all).not.toContain(key)
  expect(all).not.toContain('Pw2')
  expect(all).not.toContain('Ab1')
  expect(parsed.redacted).toBeGreaterThan(2)
})

test('reading or writing a .env file: its contents never leave, whichever chunk the result comes in; .env.example does', () => {
  const p = place()
  const asked = parseChunk(line(assistant('a1', [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/x/.env.local' } }])), p)
  expect(asked.entries[0].text).toContain('.env.local')
  const answered = parseChunk(line(user('u1', [{ type: 'tool_result', tool_use_id: 'read1', content: 'PORT=8080\nWORD=plainvalue' }])), p)
  expect(answered.entries[0].text).toBe('[removed: .env contents]')
  const wrote = parseChunk(line(assistant('a2', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '.env', content: 'WORD=plainvalue' } }])), p)
  expect(wrote.entries[0].text).not.toContain('plainvalue')
  parseChunk(line(assistant('a3', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'cat .env | head' } }])), p)
  expect(parseChunk(line(user('u2', [{ type: 'tool_result', tool_use_id: 'b1', content: 'WORD=plainvalue' }])), p).entries[0].text).toBe('[removed: .env contents]')
  parseChunk(line(assistant('a4', [{ type: 'tool_use', id: 'e1', name: 'Read', input: { file_path: '.env.example' } }])), p)
  expect(parseChunk(line(user('u3', [{ type: 'tool_result', tool_use_id: 'e1', content: 'WORD=<yours>' }])), p).entries[0].text).toBe('WORD=<yours>')
  expect(namesEnvFile({ command: 'grep x src/environment.js .envrc' })).toBe(false)
})

test('the connector\'s calls in a transcript name what the session worked on; another tool\'s do not', () => {
  const parsed = parseChunk([
    assistant('a1', [{ type: 'tool_use', id: '1', name: 'mcp__plugin_codebook_codebook__claim_work', input: { run: 811 } }]),
    assistant('a2', [{ type: 'tool_use', id: '2', name: 'mcp__plugin_cblive_codebook__manager_brief', input: { factory: 'Payments', story: 'S1' } }]),
    assistant('a3', [{ type: 'tool_use', id: '3', name: 'mcp__other__thing', input: { factory: 'Nope' } }]),
  ].map(line).join(''), place())
  expect(parsed.links).toEqual([{ run: 811 }, { factory: 'Payments', story: 'S1' }])
})

test('a very long block keeps both ends and says its true size; batches stay small enough for a request', () => {
  const huge = 'x'.repeat(MAX_BLOCK_CHARS + 100_000)
  const parsed = parseChunk(line(user('u1', huge)), place())
  expect(parsed.entries[0].text.length).toBeLessThan(MAX_BLOCK_CHARS + 200)
  expect(parsed.entries[0].cut_bytes).toBe(huge.length)
  const many = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, seq: i, role: 'user' as const, kind: 'text' as const, text: 'y'.repeat(2000) }))
  const batches = batchesOf(many)
  expect(batches.flat().length).toBe(1000)
  for (const b of batches) expect(b.length).toBeLessThanOrEqual(400)
  expect(batchesOf([])).toEqual([])
})

test('the same cases as the server\'s test: key formats go, near misses stay, twice changes nothing', () => {
  for (const key of [`sk-ant-api03-${a('Ab1', 20)}`, `sk-proj-${a('Ab1', 20)}`, `ghp_${a('Ab1', 12)}`, `github_pat_${a('Ab1_', 10)}`, `glpat-${a('Ab1', 7)}`, `xoxb-123456-${a('Ab1', 8)}`, `AKIA${a('ABC1', 4)}`, `AIza${a('Ab1', 12)}`, `sk_live_${a('Ab1', 10)}`, `npm_${a('Ab1', 12)}`, `eyJ${a('Ab1', 8)}.eyJ${a('Cd2', 8)}.${a('Ef3', 8)}`, `Bearer ${a('Ab1', 10)}`]) {
    expect(redactSecrets(`x ${key} y`).text).not.toContain(key)
  }
  for (const kept of ['The commit is 027c1ce3.', 'const token = getToken();', 'token: string', 'password: user.password', 'API_KEY=${API_KEY}', 'The token budget is 500 000 tokens.', 'postgres://localhost:5432/codebook', 'mcp__plugin_codebook_codebook__claim_work', 'tokens_used: 1234', 'secret: true', 'tokenLike(value)']) {
    expect(redactSecrets(kept)).toEqual({ text: kept, count: 0 })
  }
  const once = redactSecrets(`DB_PASSWORD=Xy7-secret-Value-9`)
  expect(once.text).not.toContain('Xy7')
  expect(redactSecrets(once.text).count).toBe(0)
  expect(isEnvFile('.env.production')).toBe(true)
  expect(isEnvFile('.env.example')).toBe(false)
})

// ── the session: real hooks, a real register, a stand-in engine ───────────────────────────────────────────────────

const TRANSCRIPT = '/tmp/project/session-a.jsonl'
type Upload = { session: { id: string; title?: string; agent?: { id: string; label?: string } }; entries?: { key: string }[]; links?: unknown[] }

function world(on: On, opts: { stored?: Record<string, unknown>; fail?: () => string | null; capture?: () => string } = {}) {
  const kept = new Map<string, unknown>(Object.entries(opts.stored ?? {}))
  const files = new Map<string, string>()
  const uploads: Upload[] = []
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => { kept.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { kept.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'session-a' }))
  on('command.register', () => ({ value: { command: 'factory' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:codebook:codebook' } }))
  on('fs.stat', (_, e) => { const text = files.get(String(e.path)); if (text === undefined) throw new Error('ENOENT'); return { value: { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 0, isLink: false } } })
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const names = [...files.keys()].filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes('/')).map((f) => f.slice(dir.length))
    if (!names.length) throw new Error('ENOENT')
    return { value: names.map((name) => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => { const text = files.get(String(e.path)); if (text === undefined) throw new Error('ENOENT'); return { value: text } })
  on('process.run', (_, e) => {
    const [, , , , offset, path, length] = e.argv as string[]
    const bytes = new TextEncoder().encode(files.get(path) ?? '')
    return { value: { exitCode: 0, stdout: new TextDecoder().decode(bytes.slice(Number(offset) - 1, Number(offset) - 1 + Number(length))), stderr: '' } }
  })
  on('mcp.call', (_, e) => {
    if (e.tool !== 'capture_transcript') return { value: { content: [{ type: 'text', text: '{}' }], structuredContent: {}, isError: false } }
    const failed = opts.fail?.()
    if (failed) throw new Error(failed)
    uploads.push(e.args as Upload)
    const data = { capture: opts.capture?.() ?? 'on', saved: 1, duplicates: 0, conversation: 1 }
    return { value: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } }
  })
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: '{}' }], structuredContent: {} }, text: '{}' }))
  on('classic.Stop', () => ({}))
  on('command.run', () => ({ text: '' }))
  return { kept, files, uploads, clock }
}

const keys = (uploads: Upload[]) => uploads.flatMap((u) => (u.entries ?? []).map((e) => e.key))
const usesCodeBook = { tool: 'mcp__plugin_codebook_codebook__manager_brief', factory: 'Payments' }

async function typed($: Engine, args: string) {
  return $.command.run({ command: 'factory', args, origin: { kind: 'human' }, presentation: 'chat' } as never)
}
async function begin($: Engine) {
  await $.session.start({ cwd: '/tmp/project', surface: 'desktop', isInteractive: true })
}
async function stop($: Engine) {
  await ($ as any).classic.Stop({ session_id: 'session-a', transcript_path: TRANSCRIPT, cwd: '/tmp/project', hook_event_name: 'Stop', stop_hook_active: false })
}
async function seconds(w: ReturnType<typeof world>, n: number) { for (let i = 0; i < n; i++) await w.clock.advance(1000) }

test('a session that never used CodeBook uploads nothing, whatever it says', async ($, on) => {
  const w = world(on)
  w.files.set(TRANSCRIPT, line(user('u1', 'private thoughts')))
  await begin($)
  await stop($)
  await seconds(w, 30)
  expect(w.uploads).toEqual([])
})

test('used once, the whole session goes up from its first word, in order, then what comes after; nothing twice', async ($, on) => {
  const w = world(on)
  w.files.set(TRANSCRIPT, line(user('u1', 'first')) + line(assistant('a1', [{ type: 'text', text: 'second' }])))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 3)
  expect(keys(w.uploads)).toEqual(['u1:0', 'a1:0'])
  expect(w.uploads[0].session.id).toBe('session-a')
  w.files.set(TRANSCRIPT, `${w.files.get(TRANSCRIPT)}${line(user('u2', 'third'))}`)
  await stop($)
  await seconds(w, 3)
  expect(keys(w.uploads)).toEqual(['u1:0', 'a1:0', 'u2:0'])
  await seconds(w, 60)
  expect(keys(w.uploads).length).toBe(3)
})

test('a failed upload is silent to the session, waits, and goes again: nothing lost, nothing skipped', async ($, on) => {
  let broken = true
  const w = world(on, { fail: () => (broken ? 'network unreachable' : null) })
  w.files.set(TRANSCRIPT, line(user('u1', 'first')))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 3)
  expect(w.uploads).toEqual([])
  const kept = w.kept.get('capture-1:session-a') as { main: { offset: number } }
  expect(kept.main.offset).toBe(0)
  w.files.set(TRANSCRIPT, `${w.files.get(TRANSCRIPT)}${line(user('u2', 'while offline'))}`)
  broken = false
  await seconds(w, 12)
  expect(keys(w.uploads)).toEqual(['u1:0', 'u2:0'])
})

test('a sub-agent\'s transcript goes up as its own conversation, with its type and what it was asked', async ($, on) => {
  const w = world(on)
  w.files.set(TRANSCRIPT, line(user('u1', 'first')))
  w.files.set('/tmp/project/session-a/subagents/agent-a0b1.jsonl', line(user('s1', 'Work run 811')) + line(assistant('s2', [{ type: 'text', text: 'Passed.' }])))
  w.files.set('/tmp/project/session-a/subagents/agent-a0b1.meta.json', JSON.stringify({ agentType: 'codebook:factory-worker', description: 'Alex works #2 at Build' }))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 5)
  const agent = w.uploads.find((u) => u.session.agent)
  expect(agent?.session.agent).toEqual({ id: 'a0b1', type: 'codebook:factory-worker', label: 'Alex works #2 at Build' } as never)
  expect(keys(w.uploads)).toEqual(['u1:0', 's1:0', 's2:0'])
})

test('a session that ended with rows not uploaded is caught up by a later one, from where it stopped', async ($, on) => {
  const earlier = '/tmp/project/session-old.jsonl'
  const first = line(user('o1', 'uploaded before'))
  const w = world(on, { stored: { 'capture-1:session-old': { path: earlier, main: { offset: new TextEncoder().encode(first).length, seq: 1, sent: [], envCalls: [] }, agents: {}, at: 1 } } })
  w.files.set(earlier, first + line(user('o2', 'never uploaded')))
  await begin($)
  await seconds(w, 5)
  expect(w.uploads.map((u) => [u.session.id, u.entries?.map((e) => e.key)])).toEqual([['session-old', ['o2:0']]])
})

test('/factory capture off: nothing leaves, and what was said meanwhile stays home even after on', async ($, on) => {
  const w = world(on)
  w.files.set(TRANSCRIPT, line(user('u1', 'first')))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 3)
  expect(keys(w.uploads)).toEqual(['u1:0'])
  const said = await typed($, 'capture off')
  expect(JSON.stringify(said)).toContain('not being saved')
  w.files.set(TRANSCRIPT, `${w.files.get(TRANSCRIPT)}${line(user('u2', 'off the record'))}`)
  await stop($)
  await seconds(w, 25)
  expect(keys(w.uploads)).toEqual(['u1:0'])
  await typed($, 'capture on')
  w.files.set(TRANSCRIPT, `${w.files.get(TRANSCRIPT)}${line(user('u3', 'back on'))}`)
  await stop($)
  await seconds(w, 3)
  expect(keys(w.uploads)).toEqual(['u1:0', 'u3:0'])
})

test('the app says off: stored nothing, so the place moves past it, and when the app says on again only what comes after goes up', async ($, on) => {
  let answer = 'off'
  const w = world(on, { capture: () => answer })
  w.files.set(TRANSCRIPT, line(user('u1', 'said while off')))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 3)
  const kept = () => w.kept.get('capture-1:session-a') as { main: { offset: number } }
  expect(kept().main.offset).toBe(w.files.get(TRANSCRIPT)?.length as number)
  answer = 'on'
  w.uploads.length = 0
  await w.clock.advance(1_900_000)
  w.files.set(TRANSCRIPT, `${w.files.get(TRANSCRIPT)}${line(user('u2', 'back on'))}`)
  await stop($)
  await seconds(w, 3)
  expect(keys(w.uploads)).toEqual(['u2:0'])
})

test('/factory capture status says what it does, where it stands, and that removing secrets is best effort', async ($, on) => {
  const w = world(on)
  w.files.set(TRANSCRIPT, line(user('u1', 'first')))
  await begin($)
  await $.tool.call(usesCodeBook as never)
  await stop($)
  await seconds(w, 3)
  const said = JSON.stringify(await typed($, 'capture status'))
  expect(said).toContain('This session: 1 blocks saved')
  expect(said).toContain('best effort')
})
