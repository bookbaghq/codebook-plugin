// Both clients follow one knowledge contract (references/knowledge-contract.md). These selectors read what a session
// advertises and what CodeBook answered, and name the next step. They make no connector or model call and hold no
// knowledge body, credential or grant.
export const KNOWLEDGE_CONTRACT_SINCE = '0.34.0'
export const PAGE_BYTES = 8192          // retrieve_run_knowledge's own maximum for one page
export const READ_BUDGET_BYTES = 16384  // two full pages for one fact; past it the fact stays unresolved
export const CATEGORIES = ['missing', 'incorrect', 'stale', 'conflicting']
const OPERATIONS = {
  index: 'run_knowledge_index', retrieve: 'retrieve_run_knowledge', report: 'report_knowledge_gap',
  gaps: 'list_knowledge_gaps', note: 'run_note',
}

// Claude Code says mcp__plugin_codebook_codebook__run_note, Codex codebook.run_note or the bare name.
const base = (name) => String(name ?? '').split(/__|[./]/).pop()

/** What this session really offers. `tools` is its own list: names, or entries with a name and an input schema. */
export function advertised(tools) {
  const have = {}
  for (const entry of Array.isArray(tools) ? tools : []) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name !== 'string') continue
    const operation = Object.keys(OPERATIONS).find(key => OPERATIONS[key] === base(name))
    if (!operation) continue
    const schema = typeof entry === 'string' ? null : entry.inputSchema ?? entry.input_schema ?? entry.parameters
    have[operation] = { name, fields: schema?.properties ? new Set(Object.keys(schema.properties)) : null }
  }
  return have
}

// Send only fields the advertised schema lists, and only values this session holds.
function call(tool, args) {
  const kept = Object.entries(args).filter(([key, value]) => value !== undefined && value !== null && (!tool.fields || tool.fields.has(key)))
  return { tool: tool.name, args: Object.fromEntries(kept) }
}
const ok = (reply) => reply !== null && typeof reply === 'object' && !reply.error && !reply.lost
const of = (state, operation) => (state.replies ?? []).filter(one => base(one?.tool) === OPERATIONS[operation])

/** Only what completed: successful page reads, gap receipts and run notes. */
export function completed(replies) {
  const done = { reads: [], submissions: [], notes: 0 }
  for (const { tool: named, reply } of replies ?? []) {
    const tool = base(named)
    if (!ok(reply)) continue
    if (tool === OPERATIONS.retrieve && reply.status === 'available') {
      done.reads.push({ handle: reply.handle, version: reply.version, version_id: reply.version_id, source_hash: reply.source_hash ?? null, offset: reply.offset, bytes: reply.bytes })
    } else if (tool === OPERATIONS.report && reply.report) {
      done.submissions.push({ report: reply.report, entry: reply.entry, linked: reply.linked === true })
    } else if (tool === OPERATIONS.note) done.notes++
  }
  return done
}

const unresolved = (state, why, more = {}) => ({
  step: 'unresolved', say: `Unresolved: ${state.fact}. ${why}`, claims: completed(state.replies), ...more,
})
const unavailable = (state, operation) => unresolved(state,
  `${OPERATIONS[operation]} is unavailable here.`, { unavailable: OPERATIONS[operation] })

/**
 * The next step for one fact. state: { tools, story, run, fence?, knowledge (brief.knowledge), fact, handle?,
 * answered?, check_freshness?, replies: [{ tool, args?, reply }] }. `fact` is empty when the brief answers; `handle`
 * is the one reference the client chose; `answered` is the client's own reading of the latest page.
 */
export function knowledgeStep(state) {
  if (!state?.fact) return { step: 'continue', say: null, claims: completed([]) }
  const have = advertised(state.tools), knowledge = state.knowledge
  if (!knowledge) return unresolved(state, 'This brief carries no knowledge section.', { unavailable: 'brief.knowledge' })
  if (knowledge.status === 'unavailable') return unresolved(state, knowledge.reason || 'Knowledge is unavailable for this run.', { unavailable: 'brief.knowledge' })

  const pages = of(state, 'index').map(one => one.reply).filter(ok)
  const listed = [...(knowledge.items ?? []), ...pages.flatMap(page => page.items ?? [])]
  const entry = state.handle ? listed.find(item => item.handle === state.handle) : null
  if (!entry) {
    const last = pages.at(-1), more = last ? last.next_after != null : Number(knowledge.omitted) > 0
    if (of(state, 'index').some(one => !ok(one.reply))) return unresolved(state, 'The index read was refused.')
    if (more) {
      if (!have.index) return unavailable(state, 'index')
      return { step: 'call', call: call(have.index, { story: state.story, run: state.run, after: last?.next_after, limit: 25 }), say: 'Reading one page of this run\'s index.' }
    }
    if (state.handle) return unresolved(state, `${state.handle} is not in this run's index.`)
    if (listed.length) return { step: 'select', say: 'Choose one reference from this run\'s index by its title and reason.', handles: listed.map(item => item.handle) }
    return { step: 'gap', category: 'missing', say: `No guidance for: ${state.fact}.`, claims: completed(state.replies) }
  }

  const evidence = (source) => ({
    handle: entry.handle, kind: source.kind ?? entry.kind, id: source.id ?? entry.id, version: source.version ?? entry.version,
    version_id: source.version_id ?? entry.version_id, source_hash: source.source_hash ?? entry.source_hash ?? null,
  })
  if (listed.some(item => item.handle === entry.handle && item.stale === true)) {
    return unresolved(state, `${entry.handle} is marked stale.`, { gap: 'stale', evidence: evidence({}) })
  }
  const reads = of(state, 'retrieve').filter(one => one.reply?.handle === entry.handle || !ok(one.reply))
  if (typeof entry.body === 'string' && !reads.length) {
    return { step: 'cite', evidence: { ...evidence({}), inline: true }, say: `Answered from the brief: ${entry.handle} version ${entry.version}.`, claims: completed(state.replies) }
  }
  if (!have.retrieve || knowledge.retrieve_tool === null) return unavailable(state, 'retrieve')
  const first = { story: state.story, run: state.run, handle: entry.handle, fence: state.fence }
  if (!reads.length) return { step: 'call', call: call(have.retrieve, { ...first, offset: 0, limit: PAGE_BYTES }), say: `Reading ${entry.handle} from byte 0.` }

  const last = reads.at(-1).reply
  if (!ok(last)) return unresolved(state, `The read of ${entry.handle} was refused${last?.error?.code ? ` (${last.error.code})` : ''}.`)
  if (last.status !== 'available') {
    return unresolved(state, `${entry.handle} is a portable file: continue with ${last.tool ?? 'read_story_file'} for file ${last.file} version ${last.version}.`, { file: { id: last.file, version: last.version } })
  }
  const used = reads.reduce((sum, one) => sum + (ok(one.reply) ? Number(one.reply.bytes) || 0 : 0), 0)
  if (state.answered === true) {
    const compared = of(state, 'index').some(one => one.args?.refresh === true || Array.isArray(one.reply?.changes))
    if (state.check_freshness === true && have.index && !compared) {
      return { step: 'call', call: call(have.index, { story: state.story, run: state.run, refresh: true }), say: 'Comparing this run\'s index with the current catalog.' }
    }
    const cited = { ...evidence(last), bytes: [reads[0].reply.offset, last.offset + last.bytes - 1] }
    // A comparison with the current catalog replaces nothing: the run keeps the version it read.
    const changed = pages.flatMap(page => page.changes ?? []).find(change => change.kind === 'changed' && change.item?.from?.handle === entry.handle)
    const newer = changed ? { version: changed.item.to.version, source_hash: changed.item.to.source_hash ?? null } : undefined
    return {
      step: 'cite', evidence: cited, ...(newer ? { newer } : {}), claims: completed(state.replies),
      say: `Read ${entry.handle} version ${cited.version}, bytes ${cited.bytes[0]}-${cited.bytes[1]}.` +
        (newer ? ` The source is now version ${newer.version}: this run keeps version ${cited.version}, and a new authorized run can use the new one.` : ''),
    }
  }
  if (last.next_offset == null) return unresolved(state, `${entry.handle} was read in full without it.`, { gap: 'missing', evidence: evidence(last) })
  if (used >= READ_BUDGET_BYTES) return unresolved(state, `The ${READ_BUDGET_BYTES}-byte read budget ended first.`)
  return {
    step: 'call', say: `Reading ${entry.handle} from byte ${last.next_offset}.`,
    call: call(have.retrieve, { ...first, offset: last.next_offset, limit: Math.min(PAGE_BYTES, READ_BUDGET_BYTES - used) }),
  }
}

/**
 * The next step for one gap. state: { tools, story, run, fence?, gap: { repository, commit, subject, category,
 * observation, citations, proposed_correction?, report?, variant? }, replies: [{ tool, args?, reply }] }. A receipt is a
 * proposed correction.
 */
export function gapStep(state) {
  const have = advertised(state?.tools), gap = state?.gap ?? {}, claims = () => completed(state.replies)
  const missing = ['repository', 'commit', 'subject', 'category', 'observation', 'citations'].filter(field => !gap[field]?.length)
  if (!state?.story) missing.unshift('story')
  if (!state?.run) missing.unshift('run')
  if (gap.commit && !/^[a-f0-9]{40}$/i.test(gap.commit)) missing.push('commit (the full 40-character SHA)')
  if (gap.category && !CATEGORIES.includes(gap.category)) missing.push(`category (${CATEGORIES.join(', ')})`)
  if (missing.length) return { step: 'incomplete', missing, say: `Not sent. The report still needs: ${missing.join(', ')}.`, claims: claims() }

  const fallback = (why) => {
    const notes = of(state, 'note')
    if (notes.some(one => ok(one.reply))) return { step: 'done', outcome: 'noted', say: `${why} I recorded ${gap.subject} in the run note.`, claims: claims() }
    if (!have.note || notes.length) return { step: 'done', outcome: 'unreported', say: `${why} No run note could be recorded: ${gap.subject} stays unreported.`, claims: claims() }
    const text = `Knowledge gap (${gap.category}): ${gap.subject}. ${gap.observation} Repository ${gap.repository} at ${gap.commit}.`
    return { step: 'call', call: call(have.note, { run: state.run, fence: state.fence, text }), say: `${why} Recording it in a run note.` }
  }
  if (!have.report) return { ...fallback('Gap reporting is unavailable here.'), unavailable: OPERATIONS.report }

  const sent = of(state, 'report'), last = sent.at(-1)?.reply, lastArgs = sent.at(-1)?.args ?? {}
  // A lost answer may have been recorded. Read this story's reports first, then send the same report once more:
  // the same occurrence returns its original reference.
  const looked = of(state, 'gaps').at(-1)?.reply
  const known = ok(looked) && (looked.reports ?? []).find(one => one.category === gap.category && String(one.subject).toLowerCase() === gap.subject.toLowerCase())
  const send = {
    step: 'call', say: 'Sending the gap report.',
    call: call(have.report, {
      story: state.story, run: state.run, repository: gap.repository, commit: gap.commit, subject: gap.subject, category: gap.category,
      observation: gap.observation, citations: gap.citations, proposed_correction: gap.proposed_correction,
      report: gap.report ?? (known ? known.report : undefined), variant: gap.variant,
    }),
  }
  if (!sent.length) return send
  if (ok(last) && last.report) {
    const linked = last.linked === true
    return { step: 'done', outcome: linked ? 'linked' : 'reported', report: last.report, say: linked ? 'Run linked to existing report.' : 'Gap reported.', claims: claims() }
  }
  if (ok(last) && last.choose_match) {
    if ((gap.report || gap.variant) && !lastArgs.report && !lastArgs.variant) return send
    return { step: 'choose', candidates: (last.candidates ?? []).map(one => ({ report: one.report, variant: one.variant ?? null })), say: 'Pick a matching candidate\'s report, or send a distinct variant.', claims: claims() }
  }
  if (last?.lost) {
    if (sent.filter(one => one.reply?.lost).length > 1) return fallback('The gap report could not be confirmed.')
    if (have.gaps && !looked) return { step: 'call', call: call(have.gaps, { story: state.story }), say: 'The answer was lost. Reading this story\'s reports before sending again.' }
    return send
  }
  return fallback(`The gap report was refused${last?.error?.code ? ` (${last.error.code})` : ''}.`)
}

const SKILL = 'codebook-knowledge-contract'
const LAYOUTS = { claude_code: `.claude/skills/${SKILL}/SKILL.md`, codex: `.agents/skills/${SKILL}/SKILL.md` }
const NOTICE = 'Printed from the CodeBook plugin package (skills/factory-manager/references/knowledge-contract.md). Writing this file installs no plugin, enables no connector and grants no identity, permission or tool: those stay in CodeBook and in this client\'s own configuration. It carries no project knowledge.'

/** The same contract as a skill file for a session without the plugin. Printed, never written: the person places it. */
export function projectedSkill(target, contract) {
  const path = LAYOUTS[target]
  if (!path) throw new Error(`Choose a target: ${Object.keys(LAYOUTS).join(', ')}.`)
  const description = 'Where CodeBook project knowledge lives and how to read it within bounds: the frozen brief, one bounded reference read, a gap report, and what to say when a tool is absent.'
  return { path, content: `---\nname: ${SKILL}\ndescription: ${JSON.stringify(description)}\n---\n\n<!-- ${NOTICE} -->\n\n${contract.replace(/\r\n/g, '\n').trim()}\n` }
}
