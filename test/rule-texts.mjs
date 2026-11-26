// The manager decides, and tests run locally: the texts a model reads must carry CodeBook's rule sentences word for
// word, and must not tell the manager to ask a person how to deliver the work.
//
// `claude plugin test` loads code files only, so these checks are a plain Node script:
//
//   node --test test/rule-texts.mjs
//
// RULES below are the sentences CodeBook's server says to every assistant (bookbaghq/codebook-app,
// components/kanban/app/service/managerGuide.js: DECIDES, ASK_ONLY, GOES_ALONE, LOCAL_TESTING, FINISH_WITHOUT,
// MANAGER_LOCAL_TESTING, MANAGER_FINISH_WITHOUT, NO_RECIPE, SETTINGS_TOGGLE, SETTINGS_ON, SETTINGS_OFF, SETTINGS_RULE,
// BACKLOG_LOOK). Change one here only together with that file.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { proposalGuidance } from '../skills/factory-manager/scripts/proposal-guidance.mjs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

export const RULES = {
  DECIDES: 'You decide how the work gets delivered. Say what you decided in one line, and never ask the person about it: whether to split a story, the order stories merge in, which story a fix belongs in, which agent or model works a station, and whether to retry a failed run.',
  ASK_ONLY: 'Ask a person only for these: spending money, touching production data, deleting things, secrets and keys, a real outside account that no stand-in can replace, and a merge where the factory keeps a person\'s station. Everything else about delivering the work you decide yourself.',
  NEW_STORIES: 'New stories follow the factory\'s own setting for how far you go alone. Where it says to ask, show the person each new story and ask "proceed?" before it starts. Where it lets you, confirm the stories you wrote yourself, say so in one line, and start the next ready story when one finishes.',
  GOES_ALONE: {
    suggest: { name: 'Ask before every new story', rule: 'Before a new story starts, show it to the person with its acceptance criteria and ask "proceed?". Start it only after their yes.', next: 'When a story finishes, say which story is ready next and ask "proceed?".' },
    approved_order: { name: 'Its own stories, in a work order you approved', rule: 'In a work order the person has said yes to once, confirm the stories you wrote yourself and say so in one line. For a new work order, or for a story a person wrote, show it and ask "proceed?" first.', next: 'When a story finishes, start the next ready story yourself, up to the factory\'s limits, and keep going until nothing is ready.' },
    full: { name: 'Any story it wrote', rule: 'Confirm the stories you wrote yourself, in any work order, and say so in one line. For a story a person wrote, show it and ask "proceed?" first.', next: 'When a story finishes, start the next ready story yourself, up to the factory\'s limits, and keep going until nothing is ready.' },
  },
  LOCAL_TESTING: [
    'Test on a local copy of the app that you build yourself. Never test against production.',
    'Build and start the app from your checkout, on free ports, with a throwaway database.',
    'Seed it, and create your own test accounts and organisations there.',
    'Use stand-ins for sign-in and for outside services.',
    'Ask a person only for a real outside account that no stand-in can replace, and offer to skip that one check.',
    'When you are done, stop the app and throw the local database away.',
  ],
  FINISH_WITHOUT: [
    'If the story can be finished with a stand-in, a recorded response or a contract test, finish it that way.',
    'Write on the card what was not checked.',
    'A story waits for a person only when nothing else can finish it. Then say in one sentence what only the person can give.',
  ],
  MANAGER_LOCAL_TESTING: 'Tests run on a local copy of the app, never on production. The station\'s agent builds it from the checkout, starts it on free ports with a throwaway database, seeds it, and creates its own test accounts and organisations there, with stand-ins for sign-in and outside services.',
  MANAGER_FINISH_WITHOUT: 'Before a story waits for a person, try the local route first. If it can be finished with a stand-in, a recorded response or a contract test, have it finished that way, with what was not checked written on the card. A story that still waits says in one sentence what only the person can give.',
  SETTINGS_TOGGLE: 'Let the manager change this factory\'s settings. It still asks you before each change.',
  SETTINGS_ON: 'This factory lets you change its settings, and you still ask first. Say in the chat which setting you would change and what that does, and change it only after the person\'s yes.',
  SETTINGS_OFF: 'This factory does not let you change its settings. Tell the person where the setting is, and change nothing.',
  SETTINGS_RULE: 'A factory\'s settings are changed only where the factory lets you, by its own switch, and only after the person\'s yes each time. Where it does not, tell the person where the setting is, and change nothing.',
  BACKLOG_LOOK: 'After each finished story, look at the Backlog too. Start the stories that are ready, as the factory\'s setting for new stories allows, and tell the person which ones are parked and on what.',
  NO_RECIPE: 'When a check or a proof cannot run because the repository has no recipe, do not stop there. Read the repository (its package scripts, CLAUDE.md and Dockerfile) and propose the recipe yourself. Where the factory lets you go alone it is saved and the check runs again; otherwise ask the person to save it. Passing a check by hand is the last resort.',
}
/** The fixed list, as ASK_ONLY names its six things. */
const SIX = ['spending money', 'touching production data', 'deleting things', 'secrets and keys', 'a real outside account that no stand-in can replace', 'a merge where the factory keeps a person\'s station']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** A file as one line of plain words: line breaks, list markers and Markdown emphasis do not count. */
const plain = (text) => text.replace(/\r\n/g, '\n').replace(/\*\*/g, '').replace(/\n\s*(?:[-*]|\d+\.)\s+/g, ' ').replace(/\s+/g, ' ')
// Check the published guidance including its linked, on-demand references. This is
// validation only: agents read a reference when its condition applies, not eagerly.
const read = (path) => {
  const seen = new Set()
  const visit = (file) => {
    const absolute = resolve(root, file)
    assert.ok(!relative(root, absolute).startsWith('..'), `reference leaves the plugin: ${file}`)
    if (seen.has(absolute)) return ''
    seen.add(absolute)
    const text = readFileSync(absolute, 'utf8')
    const references = [...text.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
      .map((match) => match[1]).filter((target) => !/^[a-z]+:/i.test(target))
      .map((target) => visit(relative(root, resolve(dirname(absolute), target))))
    return [text, ...references].join('\n')
  }
  return plain(visit(path))
}
const skill = read('skills/factory-manager/SKILL.md'), worker = read('agents/factory-worker.md'), readme = read('README.md')

const carries = (text, name, sentences) => {
  for (const sentence of [sentences].flat()) assert.ok(text.includes(sentence), `${name} does not carry: ${sentence}`)
}

test('the list in these checks is the six things of ASK_ONLY, in its order', () => {
  let from = 0
  for (const thing of SIX) {
    const at = RULES.ASK_ONLY.indexOf(thing, from)
    assert.ok(at >= from, `ASK_ONLY does not name "${thing}" in order`)
    from = at + thing.length
  }
})

test('the manager skill: it decides how the work gets delivered and says so in one line (Q1)', () => {
  carries(skill, 'The manager skill', RULES.DECIDES)
  for (const how of ['Split.', 'Order.', 'A fix.', 'Agent and model.', 'Retry.']) assert.ok(skill.includes(how), `no "${how}" under how each is decided`)
  assert.ok(skill.includes('After two retries for the same cause, stop retrying and say in one line what blocks it'))
})

test('the manager skill: the server still wins where the two differ', () => {
  assert.ok(skill.includes('Where this file and they ever differ, they win'))
  assert.ok(skill.includes('Where `manager_brief.rules` words one differently, the server wins.'))
})

test('the manager skill: nothing tells it to ask a person about a split, an order, a fix, an agent, a model or a retry', () => {
  const gone = [
    'Delegate, never decide',
    'Never decide it for them',
    'Should #29 wait for #26',
    'ask whether one should wait',
    'Never retry in a loop by yourself',
    'and offer `start_card`',
    'always at least whether the scope',
    'tell the person: Factory settings → Proof runs',
    'pass `new: true` only when they say',
    'Which?"',
    'OK to use',
    'I\'d split it',
  ]
  for (const old of gone) assert.ok(!skill.includes(old), `The manager skill still says: ${old}`)
  // Every sentence that speaks of asking about delivery must be one that forbids it.
  const topic = /\b(split|merge order|goes first|should wait|whether to retry|retry (?:a|it|the)|which model|which agent)\b/i
  const asks = /\b(ask|asks|asking|asked)\b/i
  const forbids = /\b(never ask|never asks|never asked|do not ask|not ask|not asked)\b/i
  // Allowed besides: "asks a person only for the six things".
  const allowed = /\basks? (?:a|the) person only for\b/
  let seen = 0
  for (const whole of skill.split(/(?<=[.?!]"?)\s+/)) {
    const sentence = whole.replace(/\bthe person asks\b/gi, '')   // the person asking the manager is not the manager asking
    if (!asks.test(sentence) || !topic.test(sentence)) continue
    seen++
    assert.ok(forbids.test(sentence) || allowed.test(sentence), `The manager skill asks about delivery: ${sentence}`)
  }
  assert.ok(seen >= 3, 'the check found no sentence about asking: it is reading the skill wrongly')
})

test('the fixed list of what goes to a person is the same six things everywhere (Q3)', () => {
  carries(skill, 'The manager skill', RULES.ASK_ONLY)
  for (const [name, text] of [['The factory-worker agent', worker], ['The README', readme]]) {
    const list = SIX.slice(0, 5).join(', ')
    assert.ok(text.includes(list), `${name} does not name the six things in ASK_ONLY's words and order: ${list}`)
    assert.ok(text.includes(SIX[5]), `${name} does not name: ${SIX[5]}`)
  }
  // The skill explains each of the six under its own name.
  for (const thing of SIX) assert.ok(skill.includes(`${thing[0].toUpperCase()}${thing.slice(1)}.`), `The manager skill does not explain: ${thing}`)
})

test('the manager skill: new stories and the next story follow the factory\'s setting (Q2)', () => {
  carries(skill, 'The manager skill', RULES.NEW_STORIES)
  for (const [level, said] of Object.entries(RULES.GOES_ALONE)) {
    assert.ok(skill.includes(`${said.name} (\`${level}\``), `the level ${level} is not named "${said.name}"`)
    carries(skill, `The manager skill, level ${level}`, [said.rule, said.next])
  }
  for (const part of ['`manager_brief.goes_alone`', '`{ level, name, alone, rule, next }`', '`confirm_stories { proposal, decided_by: "manager" }`', 'only the proposal’s own `goes_alone.may_confirm_yourself` set to literal `true` grants manager confirmation']) assert.ok(skill.includes(part), `the skill does not say: ${part}`)
  for (const where of ['`list_my_work { factory }`', '`manager_brief.proposals`', '`factory_board { factory, backlog_offset: 0 }`']) assert.ok(skill.includes(where), `it does not look in ${where}`)
  for (const limit of ['`you.on_my_computer.limit`', '`parallel.cards_at_once`', 'rule 7']) assert.ok(skill.includes(limit), `the limit ${limit} is not named`)
})

test('tests run on a local copy the worker builds, seeds and creates accounts in itself, never production (Q4)', () => {
  carries(worker, 'The factory-worker agent', RULES.LOCAL_TESTING)
  carries(skill, 'The manager skill', RULES.MANAGER_LOCAL_TESTING)
  for (const step of ['Build from your worktree', 'Free ports.', 'A throwaway database.', 'Seed it, and create the accounts there.', 'Stand-ins for what is outside.']) assert.ok(worker.includes(step), `the worker has no step: ${step}`)
  for (const never of ['never the person\'s checkout, their running app, their ports or their database', 'Never copy the person\'s `.env`']) assert.ok(worker.includes(never), `the worker does not say: ${never}`)
  assert.ok(skill.includes('never the person\'s checkout, running app, ports or database'))
  assert.ok(!worker.includes('When only a person can decide (unclear requirement'), 'the worker still stops for a choice the brief leaves open')
  assert.ok(worker.includes('When the brief leaves something open, decide it.'))
})

test('a missing recipe is proposed from the repository (Q5)', () => {
  carries(skill, 'The manager skill', RULES.NO_RECIPE)
  assert.ok(skill.includes('`run_recipe_change { factory, repository?, step, value, reason }`'))
  assert.ok(worker.includes('`run_recipe_change { run, fence, step, value, reason }`'))
})

test('a story is finished with a stand-in, and the card says what was not checked (Q6)', () => {
  carries(skill, 'The manager skill', RULES.MANAGER_FINISH_WITHOUT)
  carries(worker, 'The factory-worker agent', RULES.FINISH_WITHOUT)
  assert.ok(worker.includes('"Not checked:"'))
})

test('the factory\'s settings change only where its switch lets the manager, after the person\'s yes (Q9)', () => {
  carries(skill, 'The manager skill', [RULES.SETTINGS_RULE, RULES.SETTINGS_TOGGLE, RULES.SETTINGS_ON, RULES.SETTINGS_OFF])
  for (const part of ['`manager_brief.settings`', '`{ manager_may_change, switch, rule, where, now, change_with?, never }`', '`manager_may_change: true`', '`manager_may_change: false`',
    '`change_factory_setting { factory, setting, value, reason }`', '`goes_alone`', '`check_cannot_run`', '`merge_outside_pull_requests`', '`pending: true`', '`manager_brief.settings.manager_may_change`']) {
    assert.ok(skill.includes(part), `the skill does not say: ${part}`)
  }
  // The server's principle no longer forbids changing a setting outright: neither does the skill.
  for (const old of ['change a setting', 'Controls; you never do']) assert.ok(!skill.includes(old), `The manager skill still says: ${old}`)
  carries(readme, 'The README', RULES.SETTINGS_TOGGLE)
  assert.ok(readme.includes('`change_factory_setting`'))
})

test('after each finished story the manager looks at the Backlog and says what is parked (Q11)', () => {
  carries(skill, 'The manager skill', RULES.BACKLOG_LOOK)
  for (const part of ['`manager_brief.backlog`', '`{ stories: [{ story, title, workflow, proposal?, ready, parked_on, start_with? }], ready, parked, say }`', '`start_with`', '`parked_on`', 'No `backlog` in the brief (an older CodeBook)']) {
    assert.ok(skill.includes(part), `the skill does not say: ${part}`)
  }
  assert.ok(readme.includes('tells you which ones are parked and on what'))
})

test('the README tells the owner the same rules', () => {
  for (const said of ['never asks you about it: whether to split a story, the order stories merge in, which story a fix belongs in, which agent or model works a station, and whether to retry a failed run', 'the server wins', ...Object.values(RULES.GOES_ALONE).map((l) => l.name)]) {
    assert.ok(readme.includes(said), `The README does not say: ${said}`)
  }
})

test('factory continuation checks active work and proposed backlog', () => {
  const skill = plain(readFileSync(join(root, 'skills/factory-manager/SKILL.md'), 'utf8'))
  const next = plain(readFileSync(join(root, 'skills/factory-manager/references/next-story.md'), 'utf8'))
  assert.match(skill, /After each finished story, inspect queued runs, open proposals and the separate proposed stories drawer/)
  assert.match(skill, /Do not start another session's work or duplicate a run/)
  assert.match(next, /manager_brief \{ factory, backlog_offset: backlog.next_offset \}.*same workflow scope/)
  assert.match(next, /Continue until `backlog.next_offset` is null/)
  assert.match(next, /A configured station named Backlog holds stories already on the board/)
  assert.match(next, /the stories it waits for, a paused work order/)
  assert.match(next, /the person's "proceed\?"/)
})

const proposed = (route) => ({
  proposal: { proposal: 'wo7' }, stories: [{ item: 1, title: 'Export', criteria: [{ text: 'Export opens' }] }],
  goes_alone: route,
})
// Claude's tool hook imports the selector. The shared skill also exposes it to the Codex CLI on stdin.
const guidanceFor = (tool, reply) => {
  const fromHook = proposalGuidance(tool, reply)
  const fromCli = execFileSync(process.execPath, [join(root, 'skills/factory-manager/scripts/read-proposal-guidance.mjs'), tool],
    { input: JSON.stringify(reply), encoding: 'utf8' }).trim()
  assert.equal(fromCli, fromHook ?? '')
  return fromCli
}

test('delegated pause selects wait guidance in Claude and Codex', () => {
  const route = { next_action: 'wait_for_resume', decision_owner: 'manager', factory_paused: true, may_confirm_yourself: false }
  const wait = guidanceFor('propose_stories', proposed(route))
  assert.match(wait, /factory is paused.*manager can confirm.*after it resumes/i)
  assert.match(wait, /re-read this proposal’s current approval route and readiness/)
  assert.doesNotMatch(wait, /proceed|confirm_stories|ask the person/i)
  assert.equal(guidanceFor('confirm_stories', { error: { code: 'CONFLICT', goes_alone: route } }), wait)
  assert.equal(guidanceFor('confirm_stories', { error: { code: 'FORBIDDEN', goes_alone: route } }), '')
  assert.match(guidanceFor('propose_stories', proposed({ next_action: 'confirm', decision_owner: 'manager', factory_paused: false })), /decided_by: "manager"/)
})

test('person-owned decisions select owner approval guidance', () => {
  for (const paused of [true, false]) {
    const guidance = guidanceFor('propose_stories', proposed({ next_action: 'ask_person', decision_owner: 'person', factory_paused: paused, may_confirm_yourself: true }))
    assert.match(guidance, /each proposed story and its recorded acceptance criteria.*Proceed.*wait for the person’s yes before calling confirm_stories/s)
    assert.doesNotMatch(guidance, /decided_by: "manager"/)
    if (paused) assert.match(guidance, /wait for the factory to resume before placing/)
  }
  assert.match(guidanceFor('confirm_stories', { error: { code: 'FORBIDDEN', goes_alone: { next_action: 'ask_person' } } }), /wait for the person’s yes/)
})

test('legacy approval metadata preserves ask-first fallback', () => {
  assert.match(guidanceFor('propose_stories', proposed({ may_confirm_yourself: true })), /decided_by: "manager"/)
  for (const route of [{ may_confirm_yourself: false }, {}, undefined, { level: 'full', alone: true }, { may_confirm_yourself: 'true' }]) {
    assert.match(guidanceFor('propose_stories', proposed(route)), /wait for the person’s yes/)
  }
  assert.match(guidanceFor('propose_stories', proposed({ next_action: 'unknown', may_confirm_yourself: true })), /Leave this proposal pending/)
  assert.equal(guidanceFor('propose_stories', { proposal: { proposal: 'wo7' }, stories: [], already_there: [{}] }), '')
})
