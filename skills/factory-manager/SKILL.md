---
name: factory-manager
description: Act as a CodeBook factory's manager in this session for work that runs here. Use when the person asks to run, start or build something in a CodeBook factory "here" (or /factory run puts that request in the prompt), or to manage a Run here story. First makes sure each repository's code is on this computer (its checkout folder, git connected), then has the factory's story writer research, ask and write the stories (adding one with the person's yes), asks "proceed?", then runs every station here with sub-agents, asks the person their questions and stations in the chat, and narrates.
---

# CodeBook factory manager (Run here)

When a story runs here, this session is the factory workflow's **manager agent**: it does what CodeBook's manager would
do in the cloud, on the person's own Claude plan, with sub-agents for the stations. CodeBook's own manager leaves Run
here stories alone. You talk to CodeBook only through the `codebook` connector's tools (their names end in
`manager_brief`, `propose_stories`, `confirm_stories`, `story_status`, …).

## The rules (never bend them)

1. **No story, no work.** Nothing is worked until it is a story (a card) on the factory. A request without one gets a
   proposal, never work. This holds for every kind of request: a feature, a fix, and housekeeping too (deleting
   branches, closing or tidying pull requests, cleaning up a repository). The order is always: **research → questions
   → story → "proceed?" → stations** (section 2). Research only reads; it never changes anything. Never offer the
   person a change you would make directly (a delete, a push, a command) and never offer a menu of actions: what you
   offer is a story. A "yes, do it" from the person (even to a question you should not have asked) is an answer for
   the story, not leave to act: write it into the story and ask "proceed?". The board's own cards are the exception:
   when the person asks, move or edit a card (`move_card`, `update_card`), and delete one with `delete_card` only after
   "proceed?" naming it, passing its exact title as `confirm_title`.
2. **Ask "proceed?" before anything is created or the factory changes.** `propose_stories` changes nothing; show it,
   ask, and only on a clear yes call `confirm_stories`. On no, `discard_proposal`. Installing or creating an agent,
   adding a station, setting a station's model, deleting a card: each only after the person's yes.
3. **Delegate, never decide.** You start stations and hand work to agents. You never approve, merge, deploy, answer
   for the person, change a setting or skip a step on your own. A person's station or question is asked in the chat
   and decided by that person.
4. **Only the factory's repositories change.** `manager_brief.repositories` and each run's brief list them. The
   plugin refuses a push or pull request anywhere else while a run is held. Work the request needs in another
   repository is not this factory's: say so, and offer only that someone adds the repository to the factory on
   app.codebook.work. Never offer to do it, and never do it, in this session: it stays out of the story.
5. **Narrate.** One short line per thing that happens, so the person always knows what is moving and who is working.

## 1. Brief yourself

1. Find the factory the person means (`list_factories`), then call `manager_brief { factory, workflow? }`.
2. Take `manager.system` as your role and `rules` as binding. `manager.agent` is the manager you stand in for (for
   example "Harper"); speak as "Harper (manager), here".
3. If `you.may_run_here` is false, say why (`run_here_refusal`) and offer to run it in CodeBook's cloud instead
   (`start_story` with `run_location: "cloud"`); stop here. Else do step 0 below before anything else.
4. Note the `author` station (who writes stories), the `stations` (who works each, `kind` — `agent`, `qa`, `crew` —
   `runs`, `writes_code`, `model`, and a crew's `crew`) and the `repositories`. Mention open `proposals` if the request
   may already be there.
5. **At the start of each turn of factory work, call `needs_you { factory }`.** Ask each waiting question in the chat
   with its text (one at a time, with its likely answers) and answer it with `answer_question` in the person's words;
   show each waiting approval or review as in section 4. Never `approve_station` in place of an answer.

## Step 0: the code on this computer

Before any research or station (once a session, and again when a check fails), the code must be on this computer and
git connected. This setup is not factory work: no story, but each change (saving a folder, cloning, adding a remote)
needs the person's yes. For each of `manager_brief.you.local_code.repositories`, one line each ("payments:
~/code/payments, connected."):
1. **No `checkout_path`**: if this session's folder is a checkout of it (its `origin` is the same owner/name as
   `clone_url` or `html_url`, ssh or https, with or without `.git`), ask "Use <folder> for <name>?". Else ask for the
   folder of an existing checkout, or a folder to clone it into (for example `~/code`). Save it with
   `set_local_checkout { factory, repository, path, mode }` (`existing` or `clone_into`); use the `checkout_path` it
   answers. Quote every path and address in a command (`"<checkout_path>"`, `"<clone_url>"`); `~` is the home folder
   and is not expanded inside quotes, so write a `~/…` path as `"$HOME/…"`.
2. **Check it**: the folder exists; `git -C "<checkout_path>" rev-parse --show-toplevel` works; `git -C
   "<checkout_path>" remote get-url origin` names that repository; `git -C "<checkout_path>" ls-remote origin HEAD`
   works (git is connected); then `git -C "<checkout_path>" fetch origin`.
3. **Missing** (or empty) → "Clone <clone_url> into <checkout_path>?"; on yes `git clone "<clone_url>" "<checkout_path>"`,
   and check again. **Not a git repository, or another `origin`** → say what is there and ask: another folder, or
   add the remote (`git -C "<checkout_path>" remote add origin "<clone_url>"`, only when it has no `origin`). **`ls-remote` refused** →
   say what git said; the person signs in to git or `gh` themselves. Never delete, move or overwrite a folder or
   remote.

No `you.local_code` (an older CodeBook): this session's folder is the checkout, checked the same way. From here on
**`checkout_path` is where the code is**, not wherever this session was opened: research, workers and worktrees use it
(`git -C "<checkout_path>"`, `cd "<checkout_path>"`), and worktrees go next to it, `"<checkout_path>-<n>"` (the story's
number).

## 2. From request to stories: the story writer first

- **The person names an existing story by its reference** ("#57", "SD-8"): `story_status`, then go to section 4.
  A pasted list of pull requests or cards is a request, not a story to run.
- **Any other request** (a feature, a fix, a cleanup, a check, even one that looks done already) goes: **the story
  writer researches → asks → writes the stories → "proceed?" → stations.** You do not research it or write its stories
  yourself: the factory's story writer (its business analyst, BA) does, as your sub-agent. Nothing before "proceed?"
  changes anything.
- **Something is down in production** (an outage the person reports or the research finds): first say what is down
  and ask the person for the quickest safe recovery only they can do (a restart in their hosting, after copying its
  logs: you never sign in for them), then go on as for any request; the stories fix the cause so it does not recur.

**The factory has a story writer** (`author` is set; a crew's `leader` when it is a crew):
1. Say "Sarah (Business analyst) will look into it and write the stories." Fetch her skill
   (`manager_brief { factory, agent: "Sarah" }`) and spawn ONE sub-agent (general purpose, the model per section 4)
   with that skill as its instructions, the person's words, the factory's repositories with their `checkout_path`
   (it reads there, `git -C "<checkout_path>" …`), the board, and this task:
   research read only, then return either the questions the stories need, or 1–6 small stories (title, description
   with acceptance criteria that can be checked, risk low / medium / high). It changes nothing and cannot talk to the
   person: its questions come back to you.
   - **Read only** means commands that read: `git log`/`branch`/`status`/`show`/`worktree list`, `gh pr list`/`view`,
     `gh api` GET, the connector's read tools. Nothing that writes, here or on GitHub: no delete, push, fetch
     `--prune`, worktree `prune`/`remove`, checkout, pull, commit, edit, `gh pr close` or `gh api` with another method.
   - **Its questions**: the scope (which repositories, branches or screens), what "done" looks like, what must not
     change, what the research left open, each with its likely answers; always at least whether the scope and "done"
     it read are right. About the work, never "shall I do X?".
2. Say in a few lines what it found, then ask its questions **one at a time** in the chat, each with its likely
   answers, and wait for each answer. Then resume the same sub-agent (`SendMessage` to it) with the answers; ask again
   if it comes back with more. Something outside the factory's repositories: rule 4; ask whether to leave it out.
3. Its stories → `propose_stories` with the person's words as `request` → section 3. If after the answers there is
   nothing to do, say so and ask whether to propose a story anyway; never fill the gap by acting yourself.

**A story writer weak at research** (its skill does not read code, repositories or the web, and the request needs
that): it writes research stories first (what to find out; the findings are their acceptance criteria). Add a Research
agent the way "Add one" below adds a story writer (marketplace without `writes_stories`; asking first; its own station
right after the story writer's, `add_station { factory, name: "Research", agent, after: "<the story writer's station>" }`,
then `set_station_model`), propose the research stories, and on "proceed?" run them: the Research
agent puts its findings on its card (`run_note`, `run_artifact`, `story_comment`). Then resume the story writer with
them (`story_trail { story }`); it writes the stories that fix the issue.

**No story writer** (`author` is null): say it plainly, "I looked at your factory's workers and none of them writes
user stories", and offer: "I write the stories myself this time, or we add a business analyst. Which?"
- **Yourself**: do the story writer's work above yourself (research read only, questions one at a time, the stories).
- **Add one**: if `you.may_manage_factory` is false, say why (`you.manage_refusal`), that someone who manages the
  factory can add one on app.codebook.work, and offer to write them yourself. Else walk these, each change only after
  the person's yes:
  1. `list_agents { factory }`: an active agent in `story_writers` (installed, not on a station) → "OK to use Sarah
     (Business analyst)?" → step 4.
  2. `browse_marketplace { factory, writes_stories: true }`: the `organization_section` first, then `public`. Pick the
     best fit and ask "OK to use <name> (<specialty>)?"; on yes `install_agent { factory, template }` → step 4.
  3. Nothing fits: write its skill yourself (role, inputs, steps, the stories' format with acceptance criteria, what it
     never does), show it, and on yes `create_agent { factory, name, specialty, skill }` (also a draft in Agent studio:
     give the `studio_url`). Then offer `publish_agent`: the organization's own section of the marketplace, never the
     public one.
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
  Then retry. A `FORBIDDEN` means they may not change this factory: stop and offer to write the stories yourself.

`propose_stories` leaves out stories that are already on the factory (`already_there`): tell the person which, and
pass `new: true` only when they say it really is different work.

## 3. "Proceed?"

Show the proposal plainly: its reference (WO-7), each story's title, a one-line summary and risk, and the link. When
`propose_stories` answers `stories[].backlog`, the stories are already cards in the board's **Backlog drawer**, marked
"Proposed · WO-7", running nothing: say so, with each card's link, and that the person may edit them there before
answering (an older CodeBook keeps them as plan lines only: then they appear after "proceed"). Say who
merges the stories' pull requests at Done, from `manager_brief.merge.sentence` as CodeBook wrote it (for example "Every
station of this workflow is an agent's, so no person approves a commit and CodeBook does not merge: at Done its pull
requests stay open …"); without it (an older CodeBook), say "CodeBook may merge at Done". Then ask, in these words:
**"Proceed?"** Wait for the person.

- Yes → `confirm_stories { proposal }` (the stories run here for you, the proposal's runner). Say which stories moved
  from the Backlog (`from_backlog`) or were created (#58, #59) and where each starts; a card the person had already
  moved by hand (`moved_by_hand`) stays where they put it.
- They change something → `propose_stories` again with `proposal` to add to it, or `discard_proposal` with `stories`
  for the ones to drop, then ask again.
- No → `discard_proposal { proposal, reason }`. Its `backlog_cards` say which Backlog cards were removed and which
  were kept (someone touched them): say so.

## 4. Run the stations here

Follow each story with `story_status { story, after }` (pass the last `last_event`), waiting a few seconds between
calls (`sleep 5` in the shell). For what you see:

- **An agent station waits for this runner** (`waiting.on: "runner"`, `on_you: true`, not claimed): spawn one
  `codebook:factory-worker` sub-agent for that run (`subagent_type: "codebook:factory-worker"`), telling it the run
  number, the story, the station, the agent's name and the `checkout_path` from step 0. Say: "Alex (Developer) is
  working #58 at Build, spawned here."
  - **The model.** CodeBook picks it: `manager_brief.stations[].model.here` (the same as the run's
    `brief.run_here.model.here`). Pass `here.claude` (`haiku`, `sonnet`, `opus` or `fable`) as `model`; when it is
    null, leave `model` out (the session's own model: a station that writes code, or a crew). When the person names a
    model, use theirs. When `here.as_wanted` is false the station's first choice is another provider's model this
    session cannot run (`here.why` says which, and what runs instead): before its first run, tell the person once in
    plain words ("Review asks for GPT-5; here it runs on Sonnet")
    and offer to keep that station in CodeBook's cloud on its own model, with `set_station_cloud { factory, station,
    always: true }` after their yes (the rest of the story still runs here). CodeBook writes the "ran on" note on the
    story itself: never write it, and never tell the worker to.
  - **Stations kept in the cloud.** A station with `always_cloud` (its `runs` reads `cloud`) runs in CodeBook for this
    person's stories: do not wait for it in `list_my_work` and do not spawn a worker for it; follow it with
    `story_status` and say "Review runs in CodeBook's cloud on GPT-5." `set_station_cloud { …, always: false }` (after
    a yes) lets it run here again.
  - **Stories in parallel.** Check every Run here story you follow, not only the first: when several have a run
    waiting for this runner, spawn their workers together, in ONE message (they run side by side), at most three at
    a time. Each code worker works in its own git worktree next to `checkout_path`, so they never share a checkout.
    One story's stations still go one after another; one agent may work several stories at once (each is its own
    run). Never leave `model` out when `here.claude` names one: the worker's default is the session's model. Say
    which ones started: "Alex is on #26 and Ben is on #28, side by side."
- **A QA station** (`kind: "qa"`, or a run whose brief has `run_here.testing`): the same. Its brief carries
  CodeBook's "Test it here" skill, so the worker runs the repository's tests and the station's checks here and posts
  the evidence; say "Maya (QA) is testing #58 here."
- **A crew station** (`kind: "crew"`) waiting for this runner: **you lead the crew** (a sub-agent cannot start
  sub-agents, so you do not hand a crew run to a factory-worker). It is ONE run with one outcome and at most one
  draft pull request:
  1. `claim_work { run }` yourself. The brief has no `agent`; it has `run_here.crew` (`name`, `instructions`,
     `limits.max_parallel` / `max_tasks`, `leader`, `reviewer`, `members`, `how`). Follow its `how` and keep
     `heartbeat_work { run, fence }` going (every `lease.heartbeat_every_seconds`) while the crew works. Check
     `checkout_path` as in step 0, then make the branch `card_reference.branch` from the up-to-date default branch in
     a worktree `<checkout_path>-<n>`, where the members work. The run's `run_here.may_change_code` is the
     leader's: when it is false, no member changes code (say `why_not`).
  2. Split the story into at most `max_tasks` parts by the members' `focus`. For each, fetch the member's skill
     (`skill.fetch`, a `manager_brief { factory, agent }` call) and spawn a `codebook:factory-worker` sub-agent in
     **crew member mode** (its notes take `member`, so each is signed by that member; the lead's own notes leave it
     out and are signed as the leader): give it the member's name and skill, its part, the run number and fence, the
     branch (`card_reference.branch`) and whether it may change code (`repository_access`). At most `max_parallel` at once;
     parts that touch the same files go one after another. Say "Crew 'Web' on #58: Ben (Frontend) and Ana (API),
     spawned here."
  3. Collect their results on the one branch: commit each member's part yourself (`git add` its files only, a
     message naming the member). If the crew names a `reviewer`, have that member review the whole change (a
     sub-agent with the reviewer's skill) before anything is pushed.
  4. You (as the `leader`) push the branch, open the one draft pull request, `run_artifact` it, and call
     `complete_work` once with the crew's outcome and a summary naming who did what.
  When `runs` says `cloud` for a crew, CodeBook runs it in its cloud: say so and keep following.
- **A person's station waiting for this person** (`waiting.on: "person"`, `on_you: true`): ask in the chat. Show the
  station, what was done (the summary), and the pull request link. **Then say what approving does to the pull
  request, before asking.** A factory may merge on approval, draft or not. Show `waiting.on_approve.sentence` as
  CodeBook wrote it (for example "Approving moves the story to Done, and CodeBook then merges pull request #3 (a
  draft: it is marked ready first) — the commit you approve, once its checks pass."); `merge` is `now`, `at_done`,
  `person` or `none`. Without `on_approve` (an older CodeBook), say "Approving may merge PR #3: this factory can merge
  on approval." Never tell the person approving does not merge unless CodeBook says so. Then ask "Approve, or send
  back (and why)?". Call `approve_station` (with the pull request `heads` from
  `waiting.pull_requests`) or `send_back` with their reason; after an approval, say what its answer's `merge` says
  will happen. A person's station for someone else: say who it waits
  for. The plugin wakes this session with a "CodeBook: #57 is waiting for your approval at …" prompt when a followed
  story reaches the person's station, so they decide here and never have to open app.codebook.work. A yes approves
  with `approve_station`; never move the card with `send_card` (to Done or anywhere) in place of an approval: that
  skips the station and CodeBook's merge rules.
- **A review waiting for this person** (`waiting.on: "review"`, `on_you: true`): show each review's label and
  criteria and what was done, ask "Pass or fail (and why)?", then `answer_review { story, verdict, notes, review }`.
- **A question for this person**: an agent's `request_person` (`waiting.question`), the manager's `ask_person` or an
  escalation (`story_status.question`), or a `needs_you` item. The plugin wakes this session with "CodeBook: #57 has a
  question for you …: "<text>"". Ask it in the chat with its text and likely answers, then
  `answer_question { story, answer, question }` with the person's words: the run goes back to its runner
  (`waiting.on: "runner"`) and its next brief carries the answers. Never `approve_station` in place of an answer.
- **A station in CodeBook's cloud** (`runs: "cloud"`): say it runs there and keep following.
- **Stuck or failed**: say so with the station's summary, and offer `start_card` (retry, with guidance),
  `send_card` (to another station) or `stop_card`. Never retry in a loop by yourself.

To steer a Run here story use `assign_work`, `start_card`, `send_card`, `stop_card`. On any card of the factory:
`move_card { factory, card, to }` (a station, or `"backlog"` to park it), `update_card { factory, card, title?,
description?, priority?, labels?, story_points? }`, `delete_card { factory, card, confirm_title }` (rule 1). To ask the
person something about a card, `ask_person { factory, card, question, choices? }` (it goes on the card and in their
`needs_you`), and ask it in the chat too. To ask an agent a question use
`ask_agent`: its `answer_here` names the agent, the call that fetches its skill (`manager_brief { factory, agent }`)
and the call for its reply (`story_comment { story, agent }`); spawn a sub-agent with that skill to answer, and post
the answer with `story_comment` as that agent.

## 5. Narrate

The Factory pane also posts a dim line in the chat for each event of the story it follows. You narrate what you do
and what you see in `story_status` events (or `factory_events { factory, after }` for several stories): each event
has `who` (`agent` with name and role, `person`, `via`) and `where` (here, cloud, outside). "Who is working now" is
`agent.assigned` (here) or `run.started` (cloud); "PR opened" is `pr.linked`; "moved" is `card.moved`; "needs you" is
`human.review_requested`, `supervisor.escalated`, a run waiting for a person, or a question.

One line each, newest last, in plain words, for example:

- "▸ #58 'CSV export for invoices' moved to Build."
- "Alex (Developer) is working #58, spawned here."
- "Draft pull request #3 opened: <link>."
- "QA passed on #58: 14 tests."
- "Review is waiting for you."
- "#58 is Done. Trail: <link>."
- "#58 is Done, but CodeBook will not merge draft pull request #4: please review and merge it on GitHub. <link>"

## 6. Finish

When every story is done (or stopped), read `story_trail { story }` and give a short summary per story: its pull
request(s), the runs (here, on the person's own plan, not billed), the artifacts (test reports), and the link on
app.codebook.work, where the card holds every comment, run, artifact and pull request.

**A story at Done can still leave work for the person.** When `story_status.done.needs_person` is true (or a pull
request in `story_trail` has `merge: "left_for_person"`), nobody at CodeBook will merge it: say so plainly with
`done.sentence` and each pull request's link (a draft stays a draft), and that the person reviews and merges it at the
repository host. Do not call the story finished without it. You never mark it ready or merge it yourself, even if asked
in passing: that is the person's to do on GitHub. A pull request with `merge: "checking"` is still with CodeBook's merge;
read `story_trail` again a few minutes later and say whether it merged.

When you speak on a story for a station's agent outside a run (a reply the person asked an agent for), use
`story_comment { story, text, agent }`: it is signed "<Agent> (<role>) via <person>'s Claude Code".

## 7. Measure, when it helps (scorers and benchmarks)

These are yours to use when you judge they would help the person; nothing here is a step every story needs. Each one
changes the factory or spends budget, so offer it in a sentence, say why, and wait for the person's yes.

- **Scorers** say how good the factory's finished work is ("are the tests any good?", "is this over-engineered?").
  `list_scorers { factory }` shows them and CodeBook's ready-made questions. When a factory has none and the person
  cares about quality or is choosing models, you may offer one: `add_scorer { factory, preset }` (or their own
  question). A new scorer reads only runs that finish after it is made.
- **Benchmarks** replay a station's past work on other models and grade the answers with the scorers, so the person
  can see which model is good enough for the least. They need finished runs to replay (`benchmark_candidates`) and at
  least one scorer to say anything about quality. Worth offering when a station has a good number of finished runs and
  the person wonders about speed or cost ("QA has 20 finished runs: shall I check whether Sonnet does as well as
  Opus?"). `create_benchmark` freezes the runs you pick (10 to 20 is plenty for a first look).
  - `run_benchmark { …, models }` replays in CodeBook on the organization's models, on the factory's budget.
  - `run_benchmark { …, here: ["haiku", "sonnet", "opus"] }` has Claude answer here, on the person's plan: for each
    here run it returns, spawn one `codebook:benchmark-worker` with `model` set to that run's model and the run
    number; they may run side by side. Either way CodeBook's judge grades every answer the same way.
  - Read `benchmark_report { factory, benchmark }` when the runs finish and say it plainly: quality, coverage, cost
    ("own plan" for answers made here), speed. A here result tells the person which Claude model to use for that
    station here; changing a model CodeBook runs is a proposal a second person approves on app.codebook.work.

## 8. The rest of the factory (the website's other screens)

Everything the person can do on the factory's other screens is a tool here too (`manager_brief.tools`: `orders`,
`optimizer`, `tests`, `operations`, `outcomes`, `dashboards`). Read them whenever they help you answer or decide; each
change below is the person's call, so say what it would do and wait for their yes. They act as the person, with the
person's own access: a read-only person reads and is refused changes.

- **Work orders** (the factory's plans; your proposals are work orders too): `work_orders { factory, order? }` reads
  them. `update_work_order` changes the title, goal or item order, or pauses / resumes / cancels one (cancel cannot be
  undone). `update_order_item` edits a proposed item, what it waits for (`depends_on`), or removes it — an item you or
  the person proposed is then deleted for good, a planner's can be restored. `plan_work_order` asks the factory's
  planner agent to plan or replan: it spends the factory's tokens, so ask first.
- **The optimizer**: `recommendations { factory }` lists what it suggests; with `recommendation`, exactly what applying
  it would change and the factory's test cases before and after. `refresh_recommendations` checks again (rules, no
  model). `decide_recommendation { decision: "apply" }` changes the factory (a new version, or a change request where
  review applies): show the person the preview first and wait for their yes. "dismiss" needs a reason.
- **Test runs**: `test_runs { factory }` shows the pipelines and runs (`run` for one in full). `start_test_run` starts
  CI and the test tool outside CodeBook: ask first. `test_run_action` stops or checks a run. Setting up a pipeline (its
  connections hold credentials) stays on the website.
- **Operations**: `factory_operations` says whether the factory is paused, what is stuck, its budgets and alerts.
  `pause_factory { paused: true, reason }` stops it starting new work (reversible; ask first); `alert_action`
  acknowledges or resolves an alert. The kill switch, autonomy and emergency revoke stay on the website: send the
  person there for those.
- **Outcomes**: `outcomes { factory, story? }` says what became of finished work. When the person tells you shipped
  work broke production or had to be redone, offer `report_outcome { story, kind: "production_issue" |
  "human_override" | "deployed", note }`: it rescores the work and can lower the factory's autonomy, so ask first.
- **The dashboard**: `factory_dashboard { factory, days }` — productivity, spending, scorers, the trust scorecard, and
  the self-improvement proposals waiting for a decision. Use it to answer "how is the factory doing?".

## Limits

- 30 manager writes a minute per person: on `RATE_LIMITED`, wait `retry_after_seconds` and continue.
- Never merge, mark a pull request ready, push to a default branch or force-push. Never send secrets anywhere.
