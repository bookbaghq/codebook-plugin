# Review, questions and recovery

Read the relevant case for a person review, waiting question, failed run or final merge state.

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
- **A run waiting for EvalBook** (`waiting.on: "evalbook"`): the station's EvalBook suite is evaluating the change;
  nobody here answers it. Say so, and follow the story until it moves.
- **A question from a run**: an agent's `request_person` (`waiting.question`), the manager's `ask_person` or an
  escalation (`story_status.question`), or a `needs_you` item. The plugin wakes this session with "CodeBook: #57 has a
  question for you …: "<text>"". Read it first: is it one of the six things?
  - **One of the six** (money, production data, a delete, a secret or key, a real outside account, a person's
    merge): ask it in the chat with its text and likely answers, then `answer_question { story, answer, question }`
    with the person's words: the run goes back to its runner (`waiting.on: "runner"`) and its next brief carries the
    answers. For an outside account, say first what the local route already covered, and offer to skip that check.
  - **A question about delivery** (a split, an order, where a fix belongs, an agent or model, a retry): decide it.
    Do not put it to the person, and do not write your decision as the person's answer (`answer_question` carries
    the person's own words). Give the run your decision instead: `stop_card { story, reason }`, then `start_card {
    story, guidance: "Manager's decision: …" }`, so the next run reads it. Say the decision in one line in the chat.
  - **A question about what is wanted** (the requirement has two readings, and neither the story, the code nor the
    board says which): ask the person in the chat, with the likely answers, and pass their words to
    `answer_question`. Do not hold the other stories for it.
  Never `approve_station` in place of an answer.
- **A story waiting for another story** (`waiting.on: "story"`): nothing for you or the worker to do. Say which story it waits
  for (`waiting.waits_for`); a fresh run starts by itself when that one is through. Only the person lifts the wait, on the card.
- **A station in CodeBook's cloud** (`runs: "cloud"`): say it runs there and keep following.
- **Stuck or failed**: read the station's summary and decide. Retry a failed run with guidance that names what
  failed (`start_card { story, guidance }`), or send the story to the station that can fix it (`send_card`). After two
  retries for the same cause, stop retrying and say in one line what blocks it (`stop_card` when a run is still
  going); then take the next story. Say each retry in one line: "Build failed on #58 (type error in `export.ts`):
  retrying with that as guidance, try 1 of 2." Never ask whether to retry.

To steer a Run here story use `assign_work`, `start_card`, `send_card`, `stop_card`. On any card of the factory:
`move_card { factory, card, to }` (a station, or `"backlog"` to park it), `update_card { factory, card, title?,
description?, priority?, labels?, story_points? }`, `delete_card { factory, card, confirm_title }` (rule 1). To ask the
person something about a card (one of the six things, or what is wanted), `ask_person { factory, card, question,
choices? }` (it goes on the card and in their `needs_you`), and ask it in the chat too: one sentence that says what
only they can give. Never a question about delivery. To ask an agent a question use
`ask_agent`: its `answer_here` names the agent, the call that fetches its skill (`manager_brief { factory, agent }`)
and the call for its reply (`story_comment { story, agent }`); spawn a sub-agent with that skill to answer, and post
the answer with `story_comment` as that agent.

## 6. Finish

When every story is done (or stopped) and nothing more is ready (section 4b), read `story_trail { story }` and give a
short summary per story: its pull request(s), the runs (here, on the person's own plan, not billed), the artifacts
(test reports), what you decided on the way (each split, order, retry and model, one line each), what was not checked
and why (a stand-in used, a check skipped), and the link on app.codebook.work, where the card holds every comment,
run, artifact and pull request.

**A story at Done can still leave work for the person.** When `story_status.done.needs_person` is true (or a pull
request in `story_trail` has `merge: "left_for_person"`), nobody at CodeBook will merge it: say so plainly with
`done.sentence` and each pull request's link (a draft stays a draft), and that the person reviews and merges it at the
repository host. `needs_you` does not list it (it lists factory work only), so this summary is where the person
hears of it. Do not call the story finished without it.

**A merge that failed is not Done.** Where CodeBook merges, a card whose merge fails moves back out of Done:
`story_status.merge_problem` says so, and `story_trail` has CodeBook's comment with the reason. Tell them plainly that the story
is not done, with the reason and the link. A conflict or failing check goes back to the station that built it by itself. For
anything else, such as branch protection, the person sorts out the cause and the story is moved to Done again (`move_card { card, to }`, after
their yes), which tries the merge again. Do not start a run for it, and never merge it yourself. You never mark it ready or merge it yourself, even if asked
in passing: that is the person's to do on GitHub. A pull request with `merge: "checking"` is still with CodeBook's merge;
read `story_trail` again a few minutes later and say whether it merged.

When you speak on a story for a station's agent outside a run (a reply the person asked an agent for), use
`story_comment { story, text, agent }`: it is signed "<Agent> (<role>) via <person>'s Claude Code".
