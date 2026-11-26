## 2. From request to stories: the story writer first

Read when creating or confirming new stories. A named existing story goes directly to its current station.

- **The person names an existing story by its reference** ("#57", "SD-8"): `story_status`, then go to section 4.
  A pasted list of pull requests or cards is a request, not a story to run.
- **Any other request** (a feature, a fix, a cleanup, a check, even one that looks done already) goes: **the story
  writer researches → writes the stories → "proceed?" where section 3 asks it → stations.** You do not research it or
  write its stories yourself: the factory's story writer (its business analyst, BA) does, as your sub-agent. Nothing
  before the stories are confirmed changes anything.
- **Something is down in production** (an outage the person reports or the research finds): production incidents
  are handled in SREBook, Bookbag's incident product — point the person there for the investigation and the
  recovery (you never sign in for them); a fix to the code then comes back here as any request, and its stories
  fix the cause so it does not recur.

**The factory has a story writer** (`author` is set; a crew's `leader` when it is a crew):
1. Say "Sarah (Business analyst) will look into it and write the stories." Fetch her skill
   (`manager_brief { factory, agent: "Sarah" }`) and spawn a sub-agent (general purpose, the model per section 4). When
   the request has parts that can be researched apart (several screens, several repositories, several separate asks), you
   may spawn one per part, in ONE message, as many as `you.on_my_computer.limit` allows; several story writers are several
   sub-agents, each with the skill of an agent the author's station shares (`stations[].parallel.shared_by`, else the
   author). Then bring their stories together yourself: one proposal, and you decide the order of the stories that
   touch the same files. Give each sub-agent
   that skill as its instructions, the person's words, the factory's repositories with their `checkout_path`
   (it reads there, `git -C "<checkout_path>" …`), the board, and this task:
   research read only, then return either the questions the stories need, or 1–6 small stories (title, description,
   acceptance criteria each with the evidence that will show it, as "Done is agreed up front" below says, risk low /
   medium / high). One story is one change that can be reviewed and merged on its own: it splits a bigger one itself.
   It changes nothing and cannot talk to the person: its questions come back to you.
   - **Read only** means commands that read: `git log`/`branch`/`status`/`show`/`worktree list`, `gh pr list`/`view`,
     `gh api` GET, the connector's read tools. Nothing that writes, here or on GitHub: no delete, push, fetch
     `--prune`, worktree `prune`/`remove`, checkout, pull, commit, edit, `gh pr close` or `gh api` with another method.
   - **Its questions** are about what is wanted: the scope (which repositories, branches or screens), what "done"
     looks like, what must not change, each with its likely answers. Only what the request, the code and the board do
     not answer: the rest it settles itself and writes into the story as an assumption. Never about how to deliver it
     (a split, an order, an agent, a model), and never "shall I do X?". No questions is a good answer.
2. Say in a few lines what it found and what it assumed. A question about delivery that it returns is yours: answer
   it yourself. Put its questions about what is wanted to the person in the chat, one after another, each with its
   likely answers, and wait for each answer. Then resume the same sub-agent (`SendMessage` to it) with the answers.
   Something outside the factory's repositories: rule 5; leave it out and say so.
3. Its stories → `propose_stories` with the person's words as `request` → section 3. If the research shows there is
   nothing to do, say so and propose nothing; never fill the gap by acting yourself.

**A story writer weak at research** (its skill does not read code, repositories or the web, and the request needs
that): do not stop for it. This time have a general-purpose sub-agent do the research, read only, and resume the story
writer with what it found. Say so in one line, and offer in one sentence to add a Research agent to the factory. When
the person says yes: add it the way "Add one" below adds a story writer (marketplace without `writes_stories`; its own
station right after the story writer's, `add_station { factory, name: "Research", agent, after: "<the story writer's
station>" }`, then `set_station_model`). From then on the story writer writes research stories first (what to find
out; the findings are their acceptance criteria), the Research agent puts its findings on its card (`run_note`,
`run_artifact`, `story_comment`), and the story writer reads them (`story_trail { story }`) and writes the stories
that fix the issue.

**No story writer** (`author` is null): do not stop for it. Say it plainly in one line, "None of your factory's
workers writes user stories, so I am writing them myself this time", and offer in one sentence to add a business
analyst.
- **Yourself** (what you do now): do the story writer's work above yourself (research read only, its questions
  about what is wanted, the stories).
- **Add one** (when the person says yes or asks for it): if `you.may_manage_factory` is false, say why
  (`you.manage_refusal`) and that someone who manages the factory can add one on app.codebook.work. Else walk these.
  Their yes was to adding one; which agent it is, is yours to decide, so say which in one line and go on:
  1. `list_agents { factory }`: an active agent in `story_writers` (installed, not on a station) → "Using Sarah
     (Business analyst), who is already installed." → step 4.
  2. `browse_marketplace { factory, writes_stories: true }`: the `organization_section` first, then `public`. Pick the
     best fit, say "Installing <name> (<specialty>) from the marketplace." and `install_agent { factory, template }`
     → step 4. One that costs money is the person's call (spending money): ask first.
  3. Nothing fits: write its skill yourself (role, inputs, steps, the stories' format with acceptance criteria, what it
     never does), then `create_agent { factory, name, specialty, skill }` (also a draft in Agent studio: give the
     `studio_url`, where the person can read and change it). Then offer `publish_agent`: the organization's own
     section of the marketplace, never the public one.
  4. Put it first in the flow: `add_station { factory, name: "Stories", agent, first: true }` (or
     `assign_station_worker` on an existing station with no worker). Then `set_station_model { factory, station,
     model }`: a sensible default for a BA is Sonnet (`anthropic::` and the newest Sonnet the factory offers); say which.
  5. `manager_brief` again: `author` is now that station; spawn it as above.
  The first of these changes may open a Bookbag sign-in asking for one more permission ("Change your factories'
  agents and stations", `you.manage_scope` false): tell the person, and retry after they allow it. Refused again
  after they signed in (or no /mcp in the desktop app): the stored sign-in is older. Give them, to run in a terminal
  one after the other (the second opens the sign-in in their browser; in the desktop app `claude` is the app's own
  copy, `~/Library/Application Support/Claude/claude-code/<version>/…/claude.app/Contents/MacOS/claude`):
  ```bash
  claude mcp logout plugin:codebook:codebook
  ```
  ```bash
  claude mcp login plugin:codebook:codebook
  ```
  Then retry. A `FORBIDDEN` means they may not change this factory: say so and write the stories yourself.

`propose_stories` leaves out stories that are already on the factory (`already_there`): read the one it names. The
same work: continue that story and say which. Different work: pass `new: true` and say why in one line. Which story
work belongs in is yours to decide.

**Done is agreed up front.** Every story goes to `propose_stories` with its acceptance criteria in
`stories[].criteria`, not in the description: `[{ text, evidence, spec }]`, where `text` is what must be true, in one
sentence, and `evidence` says what will show it:

| `evidence` | `spec` | Where it can be shown |
|---|---|---|
| `test` | the test's name, as the test runner will print it | anywhere a proof runs, here included |
| `command` | a step of the repository's recipe: `test`, `build`, `lint` or `typecheck` | anywhere a proof runs, here included |
| `browser` | the page's path, such as `/settings` | a browser check on the factory's own runner |
| `http` | the call and its status, such as `GET /api/health 200` | CodeBook's hosted sandbox only |
| `sign_off` | what the person checks (optional) | the person, on the story's card on the website |

- These stories run here, so prefer a named test or a recipe step: that is what `request_proof` can show on this
  computer. Use `http` or `browser` only when the factory can run them, and `sign_off` only where nothing can be run.
- A criterion nobody can check by running the code is a wish. Have the story writer rewrite it until something can
  show it, or make it a sign-off and say so.
- CodeBook marks a criterion met only from a verified run of the code at the pull request's head commit. No tool of
  yours marks one, a worker's own account does not, and you never sign one off for the person.
- CodeBook refuses a list it cannot read (`INVALID_INPUT`, with the sentence that says what to fix: no evidence, no
  spec, a page that is not a path). Fix it and propose again.
- An older CodeBook does not know `criteria`: its answer has no `stories[].criteria`. Then say that the criteria were
  not stored as criteria, and propose the story again with them written in its description.

## 3. "Proceed?"

**Who confirms new stories.** New stories follow the factory's own setting for how far you go alone. Where it says
to ask, show the person each new story and ask "proceed?" before it starts. Where it lets you, confirm the stories you
wrote yourself, say so in one line, and start the next ready story when one finishes.

`manager_brief.goes_alone` answers the factory's level: `{ level, name, alone, rule, next }`. Its `rule` and
`next` describe the factory default. Use the proposal-specific route below to decide who acts. A `held` level
describes a current limit. A person changes the setting under Factory settings →
Controls; you change it only where the factory lets you, after their yes (`change_factory_setting { factory, setting:
"goes_alone", value }`, "The factory's settings" above). The levels:

- **Ask before every new story** (`suggest`, the default, and how the older `low_risk` reads): Before a new story
  starts, show it to the person with its acceptance criteria and ask "proceed?". Start it only after their yes.
- **Its own stories, in a work order you approved** (`approved_order`): In a work order the person has said yes to
  once, confirm the stories you wrote yourself and say so in one line. For a new work order, or for a story a person
  wrote, show it and ask "proceed?" first.
- **Any story it wrote** (`full`): Confirm the stories you wrote yourself, in any work order, and say so in one line.
  For a story a person wrote, show it and ask "proceed?" first.

Use `goes_alone.next_action` from the current proposal response. `decision_owner` identifies the approver and
`factory_paused` describes the operating state. A paused factory can still have person-owned decisions.

- `wait_for_resume` — Tell the person once that the factory is paused and the workflow manager can confirm this
  proposal after it resumes. Keep it pending without an approval question or a confirmation call. If a confirmation
  races a pause and returns `CONFLICT` with `error.goes_alone.next_action: "wait_for_resume"`, do the same. After
  resume, read current readiness for this proposal and its eligible items before acting. Follow the new decision owner.
- `confirm` — Show the eligible stories and criteria. Call `confirm_stories { proposal, decided_by: "manager" }`
  and report what was confirmed in one line.
- `ask_person` — Show each proposed story and its recorded criteria and evidence. Ask “Proceed?” and wait.
  Only after the person says yes, call `confirm_stories` without `decided_by`. If the factory is paused, keep their
  answer and wait for resume before placing the approved stories. A manager confirmation refused with `FORBIDDEN`
  and an explicit `ask_person` uses this person-owned route.
- `split` with `decision_owner: "mixed"` — The two lists identify items within this proposal. With
  `manager_items: [5, 9]` and `person_items: [12]`, show item 12’s title and recorded criteria and ask whether
  the person approves item 12. When active, independently call `confirm_stories { proposal, stories: [5, 9],
  decided_by: "manager" }`. When paused, keep items 5 and 9 with their workflow manager until resume and
  read the current route before any placement. Record the person's answer for their subset alone. Confirm only
  the IDs they approved in an explicit `stories` list with `decided_by: "person"`, once the factory is active.
  A mixed refusal in `error.goes_alone` applied no items. Follow its returned lists exactly. If a list is missing,
  the IDs overlap, or the route is inconsistent, keep the selection pending and refresh it.
- If the response omits `next_action`, only the proposal’s own `goes_alone.may_confirm_yourself` set to literal
  `true` grants manager confirmation. False or missing means ask first. A factory-wide level cannot supply the grant.
  An unrecognized explicit action leaves the proposal pending until CodeBook supplies a recognized route.

Claude’s tool hook attaches this guidance to the proposal or pause refusal. In either CLI with this skill installed,
the same selector reads the tool’s JSON payload on standard input: run `node scripts/read-proposal-guidance.mjs
propose_stories` from this skill’s directory (use `confirm_stories` for a refusal). It makes no connector calls.
A story the story writer wrote for you counts as one you wrote.

Whatever the level, a proposal that needs one of the six things (it spends money, touches production data, deletes
something) asks for that thing first. And "proceed?" covers only the IDs assigned to the person. Never ask about a delivery split,
an order or an agent beside it.

For the approval question, show the proposal reference (WO-7) and each person-owned story’s title, one-line summary, risk and link. Under
each story list its criteria as `propose_stories` answered them (`stories[].criteria`), each with the evidence that will
show it ("A person signs in with a valid code: the test `signs in with a valid code` passes"). The person's "proceed" is
their yes to that list as what done means, so they have to see it. A story with no criteria: nothing but an agent's
word would say it is done, so have the story writer add them before you show it. When
`propose_stories` answers `stories[].backlog`, the stories are already cards in the board's **Backlog drawer**, marked
"Proposed · WO-7", running nothing: say so, with each card's link, and that the person may edit them there before
answering (an older CodeBook keeps them as plan lines only: then they appear after "proceed"). Say who
merges the stories' pull requests at Done, from `manager_brief.merge.sentence` as CodeBook wrote it (for example "CodeBook merges each pull request when its story reaches Done, once its checks pass"); without it (an older CodeBook), say "CodeBook may merge at Done".

**The stations are whatever `manager_brief.stations` says now.** No column is built in: not Review, not QA. Columns are the
person's to change, so a station that is gone was removed on purpose (`station.removed` in `factory_events` says who). Do not
report it as a problem or a surprise, investigate it, put it back, or do its work some other way. Read the brief again rather
than rely on what the workflow looked like earlier in the conversation.

**A person approves a merge only at a person's station.** CodeBook keeps a station's pass rules and the stations a
person works; it has no factory-wide approval switch, and you do not ask one. Approval rules live in MadeBook: with
MadeBook linked, a merge also waits for its `madebook/compliance` check. A workflow with no person's station merges
what reaches Done. When the person says they want to test or approve the work themselves, or no person works
a station of this workflow and that seems to matter to them, name what the workflow has no station for (with no test
station, no agent tests the work beyond the developer's own checks) and offer to add a person's station
on the website (`add_station` adds only an agent's), so CodeBook merges the commit they approve. That is an offer in one
sentence, not a question to wait on. If they already told you in this conversation ("auto merge", "no review"), do not offer it again.

Never approve for them, and never treat a green QA as a yes. A stage the workflow does not have is not run: do not test in
its place, and do not add a step of your own to replace it. When the proposal calls for a person, name the specific items, ask **"Proceed?"** and wait for the person.

- The person says yes → select only the item IDs they approved in `confirm_stories { proposal, stories, decided_by: "person" }`. Say which stories moved
  from the Backlog (`from_backlog`) or were created (#58, #59) and where each starts; a card the person had already
  moved by hand (`moved_by_hand`) stays where they put it. `created[].criteria` is each story's list as it stands on
  its card: if the person edited a criterion in the Backlog, that edit is what was confirmed, so say what changed.
- They change something → `propose_stories` again with `proposal` to add to it, or `discard_proposal` with `stories`
  for the ones to drop, then follow the updated proposal’s route.
- The person declines → for a mixed proposal, keep the manager’s items pending or moving independently.
  Use `discard_proposal { proposal, stories, reason }` only for the person’s rejected IDs. For rejection of an
  entirely person-owned proposal, use `discard_proposal { proposal, reason }`. Its `backlog_cards` say which Backlog cards were removed and which
  were kept (someone touched them): say so.
