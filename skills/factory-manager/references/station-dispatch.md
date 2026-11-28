# Dispatch ordinary stations

For a missing capability, record the hold and read the delivery on the matching request from CodeBook. If it is `board_only`, keep it on the board and continue other eligible station work. Wait for the capability, the setting or the decision to change. This also applies to a pending recipe or proof preview whose owner is the person. Keep existing personal approvals when delivery is `chat`, absent or unknown.


Read the relevant model, capacity, overlap or recipe case when dispatch needs it; the ordinary loop is in the main skill.

**Following several stories.** Poll once, for all of them: `list_my_work { factory }` says which runs wait for you, and
`factory_events { factory, after }` says what moved. A sub-agent you spawned tells you when it finishes, so look when one does, or
about every 30 seconds while nothing else wakes you (Claude Code refuses a plain foreground `sleep`; use its Monitor tool to wait).
Use `story_status { story, after }` for the one story you need the detail of. Polling each story every few seconds uses up the connector's
120 requests a minute per person, and a connection over it fails. For what you see:

- **An agent station waits for this runner** (`waiting.on: "runner"`, `on_you: true`, not claimed): spawn one
  `codebook:factory-worker` sub-agent for that run (`subagent_type: "codebook:factory-worker"`), using the task-specific envelope in [evidence and handoffs](evidence-and-handoffs.md), including the run, story, station, agent and validated `checkout_path`. Say: "Alex (Developer) is
  working #58 at Build, spawned here."
  - **Proof.** A station whose pass needs a proof run says so in its brief (`brief.proof.required`). The worker first checks for relevant verified evidence already at the exact head. When it is absent, the worker requests only the required approved command/selection allowed by the user's test scope; an authorized executor runs and reports it. Neither you nor the worker reports a verified proof. If only a disallowed broad recipe is available, report the missing supported selection without executing it. If CodeBook records a pass as blocked for
    "NO PROOF RUN", the checks did not run at the pull request's head commit: say so and identify the missing executor or check. Do not repeat development when only proof capability is missing; finish the station truthfully blocked and resume after that capability or evidence changes.
  - **No recipe.** First check the delivery on any recorded approval for this capability. Leave a `board_only` request pending on the board. For chat delivery or a legacy server, apply the recipe rule below.

    When a check or a proof cannot run because the repository has no recipe, do not stop there. Read
    the repository (its package scripts, CLAUDE.md and Dockerfile) and propose the recipe yourself. Where the factory
    lets you go alone it is saved and the check runs again; otherwise ask the person to save it. Passing a check by
    hand is the last resort. This does not authorize self-verification or overriding a required proof or human sign-off. How: `run_recipe_change { factory, repository?, step, value, reason }`, one call a step
    (`install`, `build`, `test`, `lint`, `typecheck`, `start`, `health_url`, `seed`), each one line as it is run from
    the repository's root. With no `run` it is your own proposal: its answer says whether the step was saved or
    waits for the person under Factory settings → Proof runs, and which checks were asked for again. A step of a
    saved recipe that is wrong is the station's worker's to correct on its run (`run_recipe_change { run, fence, … }`,
    on trial at the next proof). Say in one line what was proposed: "No recipe for payments: proposed test `npm test`
    and build `npm run build`." Do not park the story for it. (An older CodeBook refuses the call without a `run`:
    then have the station's worker propose the steps on its run.)
  - **Criteria.** `story_trail { story }` answers `criteria`: each with its `state` (`met`, `failed` or `none`), `why`,
    and the proof run that decided it. When a pass is recorded blocked or failed and the card names acceptance criteria
    ("did not produce verified evidence for…", or "The story's acceptance criteria wait on it"), read them out with
    each `why`, and route only the actual gap: a missing named test or failing code needs a fix; missing execution capability needs that capability. Existing passing exact-head evidence is reused, not rerun merely for a new station. A push puts every run-shown criterion back to `none` until a
    proof runs on the new commit. A `sign_off` criterion waits for the person on the story's card on the website: tell
    them which, with the story's link; you cannot sign it.
  - **The model.** CodeBook picks it: `manager_brief.stations[].model.here` (the same as the run's
    `brief.run_here.model.here`). Pass `here.claude` (`haiku`, `sonnet`, `opus` or `fable`) as `model`; when it is
    null, leave `model` out (the session's own model: a station that writes code, or a crew). When the person names a
    model, use theirs. The model is CodeBook's pick for the station unless the work plainly needs another: then pass
    the one it needs and say so in one line ("#58 changes the billing engine: Build runs on Opus this time"). Never
    ask which model. When `here.as_wanted` is false the station's first choice is another provider's model this
    session cannot run (`here.why` says which, and what runs instead): run it here on what runs here, and before its
    first run tell the person once in plain words ("Review asks for GPT-5; here it runs on Sonnet"). Keeping that
    station in CodeBook's cloud on its own model spends money, so it is an offer in one sentence, not a stop:
    `set_station_cloud { factory, station, always: true }` after their yes (the rest of the story still runs here).
    CodeBook writes the "ran on" note on the story itself: never write it, and never tell the worker to.
  - **Stations kept in the cloud.** A station with `always_cloud` (its `runs` reads `cloud`) runs in CodeBook for this
    person's stories: do not wait for it in `list_my_work` and do not spawn a worker for it; follow it with
    `story_status` and say "Review runs in CodeBook's cloud on GPT-5." `set_station_cloud { …, always: false }` (after
    a yes) lets it run here again.
  - **Local subscriptions.** Dispatch on the selected signed-in Codex or Claude Code subscription. Record actual native usage and keep working when a receipt is pending. A CodeBook gross-token ceiling does not apply to these workers. Honor provider quotas, access, pause, context limits and concurrency. Switching to an organization key or the cloud requires the person's explicit choice.
  - **Stories in parallel: one sub-agent per card.** Check every Run here story you follow, not only the first: when
    several have a run waiting for this runner, spawn their workers together, in ONE message (they run side by side).
    Several QA or BA agents at once are several sub-agents of this session. How many: `you.on_my_computer.limit` in all
    (the person's number; 3 unless they changed it), and at each station `stations[].parallel.cards_at_once` less its
    `running` (null: no limit of its own). Spawn only what fits; start the next when one finishes, and say what waits:
    "QA is at its limit of 2; #29 starts when one finishes." A claim over a limit answers CONFLICT and takes nothing, so
    never retry it in a loop: `claim_work` is not how to find a free slot. Each run's brief names its own agent
    (`brief.agent`), which on a shared station (`parallel.shared_by`) may differ from run to run: say who it is. Each code
    worker works in its own git worktree next to `checkout_path`, so they never share a checkout. One story's stations
    still go one after another; one agent may work several stories at once (each is its own run). Never leave `model`
    out when `here.claude` names one: the worker's default is the session's model. Say which ones started: "Alex is on
    #26 and Ben is on #28, side by side."
  - **When more would help (an option, never a step).** When cards keep waiting at one station, you may offer it in a
    sentence with the trade-off: a higher `set_parallel { factory, on_my_computer }`, or `set_parallel { factory, station,
    cards_at_once }`. Or several agents sharing it, `set_parallel { factory, station, agents: ["Maya", "Priya"] }`
    (after `install_agent` if the second is not installed), which is worth it when they should differ in skill or model;
    more runs of the same agent go just as fast. Each is an offer: carry on meanwhile, and change it on the person's
    yes. A station's limit and its agents are factory settings: change them only where
    `manager_brief.settings.manager_may_change` is true, and otherwise tell the person they are in the station's own
    settings (click the station on the board). A computer running many test suites
    at once slows down, and tests that share a port or database can fail each other: if that happens, offer a lower number.
  - **Two cards touching the same files.** Workers say what they expect to change (`declare_work`), and CodeBook compares
    it with open pull requests. `manager_brief.working_on`, `story_status.working_on` and a `run.overlap` event say which
    cards overlap; nothing was stopped. The order is yours to decide: when two stories touch the same files, the one
    further along goes first and the other waits for it. `wait_for_story { story, on, reason }`: the run stops, keeps
    its branch, and a fresh run starts by itself once the other is through. When the overlap is a file both only add
    to (a changelog, a list of routes), let both carry on. Say which in one line: "#29 waits for #26: both change
    `billing/invoice.js`, and #26 is already in QA." Never ask the person which goes first.
- **A QA station** (`kind: "qa"`, or `run_here.testing`): delegate an independent review of the change and acceptance criteria. Reuse relevant exact-head evidence and run checks for uncovered behavior or findings, following [evidence and handoffs](evidence-and-handoffs.md). The station's required checks and proof gate still apply.
- **A running app**: follow [local testing](local-testing.md) only when a criterion requires it. Tests run on a local copy of the app, never on production. The station's agent builds it from the checkout, starts it on free ports with a throwaway database, seeds it, and creates its own test accounts and organisations there, with stand-ins for sign-in and outside services. Here the checkout is the worker's own worktree: never the person's checkout, running app, ports or database.
- Before a story waits for a person, try the local route first. If it can be finished with a stand-in, a recorded response or a contract test, have it finished that way, with what was not checked written on the card. A story that still waits says in one sentence what only the person can give. A stand-in cannot satisfy a criterion that specifically requires the real service or actual browser behavior.
