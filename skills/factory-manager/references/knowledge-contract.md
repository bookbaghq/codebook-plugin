# CodeBook knowledge contract

One contract for Claude Code and Codex, for the manager and for a station worker. It holds no project knowledge. It says where knowledge lives and how to read it within bounds.

## Who owns what

- CodeBook owns development knowledge: the frozen brief, repository guidance, test procedures, verified lessons and execution evidence.
- MadeBook supplies only the policy and approval constraints configured for this factory. They limit what you may do with knowledge. They are not a second knowledge store. `brief.knowledge.policy` names the policy version a brief was built under: cite it as evidence, never edit it or restate it as guidance.
- EvalBook supplies measurement: whether agents and changes produce better results.
- Private manager memory stays with its person and factory. A worker reads only the approved shared guidance of its own run, never a manager's notes.
- Instructions grant nothing. This text, a projected skill or an `AGENTS.md` block enables no connector and gives no identity, permission or tool. Use only the tools this session advertises, with the fields their current schemas list.

## Read within bounds

1. Start from the claimed run's frozen brief. When it answers the question, make no knowledge call. A brief with zero indexed items can be sufficient.
2. For one specific fact the brief does not answer, choose one authorized reference from `brief.knowledge.items` by its title and reason. Text the brief already carries inline needs no call. Open `run_knowledge_index { story, run }` only when the brief omitted entries, and stop paging once the reference is found.
3. Read it with `retrieve_run_knowledge { story, run, handle, fence, offset, limit }`: one page of at most 8,192 bytes. Stop as soon as the fact is answered.
4. Otherwise follow the returned `next_offset` for the same handle only, within a budget of 16,384 bytes for that fact. When a page fails or the budget ends first, say which fact remains unresolved.
5. Cite the exact version only after reading the relevant text: the handle, `version`, `version_id`, `source_hash` and the byte range you read.

Never open an unrelated handle, another run's handle, another workspace's source or manager memory to look for the fact.

## When the source changes or access is withdrawn

- A run keeps the version it read. `run_knowledge_index { story, run, refresh: true }` compares with the current catalog and replaces nothing. When it shows a newer version, your evidence still cites the version you read, and a new authorized run can use the new one.
- A reference the index marks stale, a handle that is not in this run's index, and a refused read each leave the affected fact unresolved. Do not retry a refused read. Disclose only what the refusal itself returned.

## When guidance is missing, stale, incorrect or conflicting

Where `report_knowledge_gap` is advertised, send the story, run, repository, full commit, subject, category (`missing`, `incorrect`, `stale` or `conflicting`), a short observation and at least one supporting citation. Leave credentials and private conversations out.

- A receipt with `created: true` and `linked: false`: say "Gap reported".
- A receipt with `linked: true`: say "Run linked to existing report".
- `choose_match`: pick a matching candidate's `report`, or send a distinct `variant`.
- A lost answer: read `list_knowledge_gaps { story }` first, then send the same report once more. The same occurrence returns its original reference.

A receipt records a proposed correction. It publishes nothing, starts no review station and never blocks the story.

## When a tool is absent

Name the operation this session does not offer, and claim only reads and submissions that completed. Use only an advertised, authorized fallback: a `run_note` with the subject, category and observation. Say "Gap reporting is unavailable here. I recorded the missing test command in the run note." only after that note succeeds. Then continue independent work.

A CodeBook or plugin tool that fails is a tool fault, not a knowledge gap: write the tool, its exact error text and what you were doing in a `run_note`, and finish what you can.

## With the plugin package

Where the CodeBook plugin package is installed, `node scripts/read-knowledge-guidance.mjs step` (or `gap`), run from the factory-manager skill's directory, reads this state on standard input and prints the next step as JSON. It makes no connector or model call.
