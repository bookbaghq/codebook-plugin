# Crew stations

Read only for a station whose current brief says kind: crew. Ordinary station workers claim their own runs.

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
