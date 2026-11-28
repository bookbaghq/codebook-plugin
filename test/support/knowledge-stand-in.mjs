// A stand-in for CodeBook's knowledge tools, for test/knowledge-contract.mjs. It runs in this process, opens no
// socket and calls no model. Reply shapes follow bookbaghq/codebook-app (runKnowledge.js, knowledgeGaps.js) as merged
// on 28 Nov 2026; only the fields the contract reads are modelled.
import { createHash } from 'node:crypto'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const refused = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

// The input fields each tool listed on app.codebook.work on 28 Nov 2026. A call with any other field fails the test.
export const SCHEMAS = {
  run_knowledge_index: ['after', 'changes_after', 'delivery', 'factory', 'history_after', 'limit', 'refresh', 'run', 'story', 'workflow'],
  retrieve_run_knowledge: ['factory', 'fence', 'handle', 'limit', 'offset', 'run', 'story', 'workflow'],
  report_knowledge_gap: ['category', 'citations', 'commit', 'factory', 'fix_story', 'needs_fix', 'observation', 'proposed_correction', 'report', 'repository', 'run', 'source_revision', 'story', 'subject', 'variant', 'workflow'],
  list_knowledge_gaps: ['factory', 'repository', 'story', 'subject', 'workflow'],
  run_note: ['fence', 'member', 'run', 'text'],
  manager_memory: ['factory', 'limit', 'note', 'offset', 'query'],
}

/** A client as it advertises its tools: Claude Code prefixes the plugin's connector, Codex names the server apart. */
export function client(kind, { without = [] } = {}) {
  const named = (tool) => kind === 'claude_code' ? `mcp__plugin_codebook_codebook__${tool}` : tool
  const tools = Object.keys(SCHEMAS).filter(tool => !without.includes(tool)).map(tool => ({
    name: named(tool), ...(kind === 'codex' ? { server: 'codebook' } : {}),
    inputSchema: { type: 'object', properties: Object.fromEntries(SCHEMAS[tool].map(field => [field, {}])) },
  }))
  return { kind, tools }
}

export function standIn() {
  const sources = new Map(), runs = new Map(), reports = [], calls = [], served = [], notes = []
  let handles = 0, lose = 0, notesFail = false
  const current = (source) => source.versions.at(-1)

  const tools = {
    run_knowledge_index(args) {
      const run = runs.get(args.run)
      if (!run || run.story !== args.story) return refused
      const items = run.items.filter(item => sources.get(item.source).granted).map(item => ({ ...describe(item), state: 'reference', stale: sources.get(item.source).stale }))
      const after = args.after ?? 0, limit = args.limit ?? 25
      const reply = { run: run.run, snapshot: run.snapshot, status: 'delivered', items: items.slice(after, after + limit), next_after: after + limit < items.length ? after + limit : null, visible: items.length }
      if (args.refresh !== true) return reply
      // A comparison with the current catalog. It replaces nothing in the run's frozen snapshot.
      const changes = items.filter(item => current(sources.get(item.id)).version_id !== item.version_id).map(item => {
        const now = current(sources.get(item.id))
        return { kind: 'changed', item: { from: item, to: { kind: item.kind, id: item.id, version: now.version, source_hash: sha(now.body), title: item.title } } }
      })
      return { ...reply, changes, changes_total: changes.length, changes_next_after: null }
    },
    retrieve_run_knowledge(args) {
      const run = runs.get(args.run), item = run?.items.find(one => one.handle === args.handle)
      // Another run's handle, a withdrawn grant and a wrong fence are all the same refusal: nothing else is disclosed.
      if (!run || run.story !== args.story || !item || !sources.get(item.source).granted || args.fence !== run.fence) return refused
      const bytes = Buffer.from(sources.get(item.source).versions.find(one => one.version_id === item.version_id).body)
      const offset = args.offset ?? 0, limit = args.limit ?? 8192
      if (offset < 0 || offset >= bytes.length || limit < 1 || limit > 8192) return { error: { code: 'INVALID_INPUT', message: 'Invalid byte range.' } }
      const chunk = bytes.subarray(offset, Math.min(offset + limit, bytes.length))
      served.push({ run: run.run, handle: item.handle, source: item.source, version: describe(item).version, offset, bytes: chunk.length })
      return {
        run: run.run, ...describe(item), status: 'available', encoding: 'base64', content: chunk.toString('base64'),
        source_bytes_sha256: sha(bytes), chunk_sha256: sha(chunk), offset, bytes: chunk.length, total_bytes: bytes.length,
        next_offset: offset + chunk.length < bytes.length ? offset + chunk.length : null, recorded: true,
      }
    },
    report_knowledge_gap(args) {
      const run = runs.get(args.run)
      if (!run || run.story !== args.story) return refused
      const same = reports.filter(one => one.repository === args.repository && one.category === args.category && one.subject.toLowerCase() === args.subject.toLowerCase())
      const retry = same.find(one => one.occurrences.some(seen => seen.run === args.run))
      let report = retry ?? same.find(one => one.report === args.report) ?? (args.variant ? null : same.find(one => !one.variant))
      if (!report && !args.variant && same.length) {
        return { created: false, choose_match: true, candidates: same.map(one => ({ report: one.report, subject: one.subject, variant: one.variant, category: one.category })) }
      }
      const linked = !!report
      if (!report) reports.push(report = { report: sha(JSON.stringify([args.repository, args.category, args.subject.toLowerCase(), args.variant ?? ''])), repository: args.repository, category: args.category, subject: args.subject, variant: args.variant ?? null, occurrences: [] })
      const created = !retry
      if (created) report.occurrences.push({ entry: reports.reduce((sum, one) => sum + one.occurrences.length, 0) + 1, story: args.story, run: args.run, commit: args.commit, observation: args.observation, citations: args.citations })
      const entry = report.occurrences.find(seen => seen.run === args.run).entry
      if (lose > 0) { lose--; return { lost: true } }   // recorded, and the answer never arrives
      return { report: report.report, entry, created, linked: linked || !created, subject: report.subject, category: report.category, status: 'open', proposal: true, affected_runs: report.occurrences.length }
    },
    list_knowledge_gaps(args) {
      const mine = reports.filter(one => one.occurrences.some(seen => seen.story === args.story))
      return { reports: mine.map(one => ({ report: one.report, subject: one.subject, category: one.category, variant: one.variant, status: 'open', proposal: true, affected_runs: one.occurrences.length })) }
    },
    run_note(args) {
      const run = runs.get(args.run)
      if (notesFail || !run || args.fence !== run.fence) return { error: { code: 'CONFLICT', message: 'The lease is not held.' } }
      notes.push({ run: args.run, text: args.text })
      return { run: args.run, comment: { id: notes.length } }
    },
    // One person's private notes. The contract never reads them for a worker: any call here fails the tests' count.
    manager_memory: () => ({ notes: [{ id: 1, title: 'Private manager note', body: 'PRIVATE-MANAGER-MEMORY' }] }),
  }
  function describe(item) {
    const source = sources.get(item.source), version = source.versions.find(one => one.version_id === item.version_id)
    return { handle: item.handle, kind: 'knowledge', id: source.id, version: version.version, version_id: version.version_id, source_hash: sha(version.body), title: source.title, reason: source.reason }
  }

  return {
    calls, served, notes, reports,
    source(id, workspace, title, body, reason = 'Repository guidance for this story.') {
      sources.set(id, { id, workspace, title, reason, granted: true, stale: false, versions: [{ version_id: id * 100 + 1, version: 'v1', body }] })
    },
    publish(id, body) {
      const source = sources.get(id), number = source.versions.length + 1
      source.versions.push({ version_id: id * 100 + number, version: `v${number}`, body })
    },
    withdraw(id) { sources.get(id).granted = false },
    markStale(id) { sources.get(id).stale = true },
    loseNextAnswer() { lose = 1 },
    failNotes() { notesFail = true },
    /** The frozen brief of a claimed run: the current versions of its own workspace's sources, and nothing else. */
    claim(run, { story, workspace, fence = 1, inBrief = Infinity, retrieval = true, knowledge = true }) {
      const items = [...sources.values()].filter(source => source.workspace === workspace && source.granted)
        .map(source => ({ handle: `k${++handles}`, source: source.id, version_id: current(source).version_id }))
      runs.set(run, { run, story, workspace, fence, snapshot: run * 10, items })
      const listed = items.slice(0, inBrief).map(item => ({ ...describe(item), delivery: 'reference' }))
      return {
        story, run, fence,
        ...(knowledge ? { knowledge: {
          status: 'prepared', snapshot: run * 10, run, items: listed, omitted: items.length - listed.length, index_tool: 'run_knowledge_index',
          retrieve_tool: retrieval ? 'retrieve_run_knowledge' : null, capability: retrieval ? 'bounded exact retrieval' : 'retrieval not granted',
          policy: { policy_ref: 'madebook:policy:7', policy_digest: 'sha256:' + sha('policy 7') },
        } } : {}),
      }
    },
    /** One call as that client makes it: only a tool it advertises, only fields its schema lists. */
    call(who, name, args) {
      const tool = who.tools.find(one => one.name === name)
      if (!tool) throw new Error(`${who.kind} called ${name}, which it does not advertise`)
      const unknown = Object.keys(args).filter(field => !(field in tool.inputSchema.properties))
      if (unknown.length) throw new Error(`${who.kind} sent ${name} fields its schema does not list: ${unknown.join(', ')}`)
      const base = name.split('__').pop()
      calls.push({ client: who.kind, tool: base, args })
      return tools[base](args)
    },
  }
}
