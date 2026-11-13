# CodeBook for Claude Code

Run your [CodeBook](https://app.codebook.work) factories from Claude Code. Start a story, watch its stations move in a
**Factory pane** beside the chat, approve or send back the stations that wait for you, and let the agent stations
**run here**, in your own checkout on your computer, with your own Claude plan. app.codebook.work shows the same story moving, live.

<img src=".claude-plugin/icon.png" alt="CodeBook" width="160">

## Install

In the Claude Code desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter
`bookbaghq/codebook-plugin`, then add the **codebook** plugin.

At the prompt of a terminal session:

```
/plugin install codebook --marketplace bookbaghq/codebook-plugin
```

From a shell:

```bash
claude plugin install codebook --marketplace bookbaghq/codebook-plugin
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

## Sign in

The plugin adds the CodeBook connector, `https://app.codebook.work/mcp`. The first time you use it, Claude Code asks
you to sign in: run `/mcp`, pick **plugin:codebook:codebook**, choose **Authenticate**, and sign in with your Bookbag
account in the browser. In the desktop app the same sign-in starts from the connectors menu.

If you cannot reach `/mcp` (the desktop app has no terminal for it), or CodeBook keeps asking for a permission you
already allowed (changing a factory's agents and stations needs `codebook:manage`, and an older sign-in does not have
it), sign in again from a terminal. The second command opens the Bookbag sign-in in your browser:

```bash
claude mcp logout plugin:codebook:codebook
```

```bash
claude mcp login plugin:codebook:codebook
```

The plugin never sees or stores a password or a token: Claude Code keeps the sign-in, and the connector only lets you
do what you can do on app.codebook.work.

## Use it

| Type | What happens |
| --- | --- |
| `/factory` | Opens the Factory pane. Pick a factory and type what it should make. |
| `/factory run Payments "Let customers refund a payment"` | Starts a story in the Payments factory and follows it in the pane. Add `--here` or `--cloud` to choose for this story. |
| `/factory status` | Where the story is, station by station, and where each repository's code is on this computer (checked as you ask). |
| `/factory list` | The factories you can see. |
| `/factory follow #57 Payments` | Follows a story that is already on the board. |
| `/factory here` / `/factory cloud` | Where agent stations run: for the next stories, and for the followed story too (while none of its runs is being worked). The pane's two picture buttons do the same. |
| `/factory stop` | Stops following; the story keeps moving on app.codebook.work. |

The pane shows the story's stations as cards. A station that waits for you shows **Approve** and **Send back**
(with the pull request to look at); both do exactly what the buttons on app.codebook.work do, once you send the
request they put in your prompt box. A question for you (from an agent or the manager) shows its text and **Answer**,
which puts "Answer #57: " in your prompt box for your words. When "proceed?" creates several stories, the pane shows
the first and the plugin follows them all: whatever waits on you in any of them wakes the chat with the question or
the approval.

## The two run modes

**Run here** (the default): the whole factory runs in your Claude Code session, on your Claude plan. Claude becomes the
factory's **manager** (the `factory-manager` skill) and works by CodeBook's rules:

1. **No story, no work.** Your request becomes stories first, written by the factory's story writer (see below).
2. **"Proceed?"** Claude shows the proposed stories, with a link that opens them on app.codebook.work, and creates
   nothing until you say yes.
3. **Every station runs here.** For each agent station Claude spawns a **factory-worker** sub-agent that becomes that
   station's agent (its own skill from CodeBook), claims the run, writes its notes and artifacts on the card, works in
   the factory's checkout on your computer (in its own worktree beside it), runs the tests, and opens a **draft** pull request with your `git` and `gh`. QA stations run the
   repository's tests here with CodeBook's "Test it here" skill. A crew's members each get a sub-agent.
4. **Your stations and questions are asked in the chat**: approve or send back a review, answer a question from an
   agent or the manager. Claude checks what waits on you (`needs_you`) at the start of each turn, asks each question
   with its text, and posts your words with `answer_question`; it never approves in place of an answer.
5. **You see it move**: the chat says what moved, who is working, when an agent is spawned and when a pull request
   opens; the Factory pane shows the stations and what is on the card.
6. **Done** means the card holds every comment (signed "Agent (role) via your Claude Code"), every run (marked "own
   plan, not billed"), the pull requests and the artifacts.

Claude and its workers never merge, push to a default branch or force-push. **Approving a person's station can
merge**: a factory may merge the story's pull request when its station is approved, even a draft. Claude says so before
it asks you, and the pane says so under Approve. A factory whose policy keeps work in CodeBook refuses Run here.

**Only the factory's repositories change.** While a CodeBook run is held in the session, the plugin refuses any
`git push` or `gh pr create` that reaches a repository the run's brief does not list (and CodeBook refuses to link a
pull request from anywhere else). The guard reads each command in its own folder (`git -C <folder>`, `cd <folder> &&`,
`gh … --repo`), so pushes from your checkout and its worktrees go through and anything else is refused. A push it cannot
attribute with confidence (through a wrapper such as `timeout` or `xargs`, a subshell, a shell or script, git
configuration or a remote changed in the same command, or a `gh api` write to pull requests) is refused too, with the
plain `git -C <checkout> push <remote> <branch>` or `gh pr create --repo <owner/name>` to run instead.

Where a command does not say where it goes, the guard asks git and gh as they would decide: a plain `git push` goes to
the branch's push remote (`pushRemote`, `remote.pushDefault`, its tracking remote, then `origin`); an address is
rewritten by `pushInsteadOf` / `insteadOf` first; `gh pr create` without `--repo` goes to `GH_REPO`, the
`gh repo set-default` repository or the only remote (with several remotes and no default it is refused). A git or gh
alias that pushes (an alias of an alias too), a gh extension, and a script, `npm run` script (with its pre/post
scripts, and the lifecycle scripts of `npm version` and `npm install`) or Makefile (`make -C` / `-f` included) that
pushes are refused while a run is held. So are a repository hook that pushes (git runs it with any git command), a
push with `push.recurseSubmodules` on, your own shell alias or function that runs a push, and a push when your shell
sets `GIT_DIR`, `GIT_WORK_TREE` or `GIT_CONFIG_*`. The guard reads your shell once every ten minutes, for at most five
seconds; if it does not answer, a push is refused until it does. Pushing from an array (`list.push(`), `pushd` and
`docker push` are not git pushes and run.

### One session, many agents

**The session that starts a story owns it.** Only that session follows it, wakes itself when it needs you, and runs its
agents as its own sub-agents. A new session stays silent and never becomes the manager, in any folder, unless you start
a story there or run `/factory follow <story>` in it. A resumed session carries on with what it followed. (Before 0.14.0
every session followed the same stories. After updating, a session that was following one needs `/factory follow <story>`
once.)

**Several cards at once.** The manager spawns one sub-agent per card, in every column: several QA agents or several
business analysts side by side are several sub-agents of this one session. Three limits apply, and each is yours to change:

- **Runs at once on your computer** (Factory settings › Your computer): 3 unless you change it, up to 16.
- **Cards at once** at a station (the station's settings): no limit unless you set one. It holds in CodeBook's cloud too.
- **Which agents share a station** (the station's Routing › Several agents, sharing): each new card goes to whichever has the fewest
  runs going. Worth it when they should differ in skill or model; more runs of one agent go just as fast.

Claude can change these too, after your yes (`set_parallel`). Many test suites at once slow a computer down, and tests that
share a port or database can fail each other: lower the number if that happens.

**Who is working on what.** Each code worker tells CodeBook its branch, worktree and the files it expects to change. Two
cards touching the same files say so on both cards and in the chat, before they meet at merge; neither is stopped, because
the list is an estimate. You decide whether one waits. If it does, its run stops, keeps its branch, and starts afresh once
the other is merged: merge order is on the factory, not written in a story.

### Code on your computer

Run here works on your own copy of each of the factory's repositories, wherever you keep it; the session can be opened
anywhere. In the factory's settings on app.codebook.work, **Your computer** holds, for each repository, the folder
of your existing checkout ("This folder already has the code") or a folder to clone it into ("Clone it into this
folder", for example `~/code`). Only you see it, and nothing secret is stored.

Before any research or station, the manager checks each repository (step 0 of the skill): the folder is there, it is a
git checkout whose `origin` is that repository, and git can reach it (`git ls-remote`), then fetches. If no folder is
set, it offers this session's folder when that is a checkout of the repository, or asks you for one and saves it for
you. A missing folder: it offers to `git clone` it there, and clones only on your yes. A folder that is not a git
checkout, or has another `origin`: it says so and asks what to do. It never deletes, moves or overwrites a folder.
Setting this up is not factory work, so it needs no story, only your yes.

Each worker checks the same before it works and reports **blocked**, with what to fix, when the folder is missing or
wrong; it never falls back to the session's folder. Code stations work in a worktree next to the checkout,
`<checkout>-<story number>` (for example `~/code/payments-58`), which QA then tests. With an older CodeBook that has no
**Your computer** setting, the session's folder is the checkout, as before.

Claude chat and ChatGPT cannot reach your computer: stations that change code run here in Claude Code, or in
CodeBook's cloud.

### What the manager does with a new issue

1. **The story writer goes first.** Claude sends the factory's story writer (its business analyst) to look into the
   issue as a sub-agent, with that agent's own skill. It only reads. Its questions come back to Claude, which asks you
   one at a time in the chat, with the likely answers, and passes your answers back. Then it writes the stories.
2. **No story writer?** Claude says so plainly and offers: it writes the stories itself this time, or you add one. To
   add one it looks at the agents your organization already has, then the marketplace (asking "OK to use …?"), then
   writes a new one; then it installs it, adds its station first in the flow and sets its model (Sonnet by default).
   Each change is asked first, and the first one asks Bookbag for one more permission ("Change your factories' agents
   and stations").
3. **A story writer that cannot research** writes research stories first; Claude adds a Research agent the same way,
   whose findings go on its card, and the story writer reads them to write the stories that fix the issue.
4. **"Proceed?"**, then the stations, as above.

On the board, Claude can also move and edit any card (`move_card`, `update_card`), ask you something on a card
(`ask_person`), and set a station's model (`set_station_model`, after your yes). It deletes a card (`delete_card`)
only after "proceed?", and CodeBook refuses unless the card's exact title is given.

**The rest of the factory.** Claude can also read and use the factory's other screens: work orders (plan, replan,
edit), the optimizer's recommendations (preview, then apply after your yes), test runs, operations (pause and resume,
alerts), outcomes (report a production problem) and the dashboard. Anything that spends, reaches outside CodeBook or
changes the factory waits for your yes; the kill switch and autonomy stay on the website.

**Models.** Each station's agent runs on the Claude model CodeBook picks for it: the station's own when it is a Claude
model, otherwise Sonnet (or this session's model for a station that writes code). A station that asks for another
provider's model (GPT-5, say) can be kept in CodeBook's cloud on that model, for your stories only (`set_station_cloud`,
after your yes, or Factory settings › Your computer); the rest of the story still runs here. When a run here used
another model than the station asks for, CodeBook notes it on the story.

**Run in CodeBook**: CodeBook's own agents run the stations on its servers, as from the website. The pane still follows
the story and you still approve your stations here. Nothing runs on your computer unless you press **Work it here**.

## Permissions

The plugin itself only **reads** CodeBook, with two exceptions that are its own work: it uploads your conversation
(Saving conversations) and it reports the proof runs it made (Proof runs). The pane lists your factories and follows the
story you chose. Every other change is yours to send. Start, Approve, Send back and moving a story to Claude or to CodeBook put the request,
in plain words, into your prompt box; you press Enter, and Claude makes the call under your usual permission
settings (in auto mode, the auto-mode check judges it like anything you type). The pane picks up the answer.

### Auto mode

In auto mode Claude Code checks each tool call against what you asked for. The pane's own refreshes and the upload of your
conversation come from the plugin, not from a message of yours, so the check refuses them: the pane says "Not reached", and
nothing is saved (one notice says so, and `/factory capture status` says how to fix it). Allow them in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_codebook_codebook__list_factories",
      "mcp__plugin_codebook_codebook__story_status",
      "mcp__plugin_codebook_codebook__story_trail",
      "mcp__plugin_codebook_codebook__capture_transcript",
      "mcp__plugin_codebook_codebook__claim_proof"
    ]
  }
}
```

The first three are reads. `capture_transcript` saves your own conversation to your own account. `claim_proof` lets the
plugin take a proof run you or your agent asked for (see Proof runs); the plugin refuses it to Claude. Nothing else skips the check: starting a
story, approving, sending back and changing a factory still go through your prompt box and your permission mode.

## Proof runs

CodeBook counts a check as proven when a program ran it and reported the result itself, not when an agent says it did.
On your computer that program is this plugin.

- **An agent asks, the plugin runs.** When Claude calls `request_proof` for a story, the plugin takes the proof from
  CodeBook, runs the repository's checks in your checkout (the recipe under Factory settings → Proof runs: test, lint,
  type check, build), and sends CodeBook each command's exit code, its output, a SHA-256 of that output, the commit that
  was checked out and whether anything was uncommitted. The story then shows the command as **Verified · run on a
  person's computer**. Claude reads what CodeBook recorded; it never writes the result.
- **`/factory prove`** runs a proof that is waiting, such as the one "Try it" queues from Factory settings → Proof runs.
- **Boxed.** Each command runs under the system's sandbox where there is one: Seatbelt (`sandbox-exec`) on macOS,
  bubblewrap (`bwrap`) on Linux. It can write only in the checkout, in `~/.codebook/proof` and in the temporary folders;
  it cannot read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.netrc` or
  `~/.npmrc`; it gets a short list of environment variables (`PATH`, `HOME` and a few more), not your session's; and it
  reaches only the computer itself unless the recipe says its checks need the network. With no sandbox on the computer
  the command still runs, and the story says it was not boxed.
- **Failures that were already there.** When a check fails, the plugin runs it again on the default branch in a separate
  worktree under `~/.codebook/proof/baseline`, so CodeBook can say which failures are new. Your checkout is never
  switched, stashed or reset. Dependencies are linked from your checkout when both commits pin the same ones; otherwise
  the recipe's install line runs in that worktree, with the network.
- **Commit first.** A run on uncommitted changes is recorded and proves no commit.
- **Limits.** One command runs for at most ten minutes. The network is the computer itself or everything; a list of
  allowed hosts is not built. The sandbox limits a repository's test code; it does not make a forged report impossible
  for a model that set out to send one from your shell, which is why a factory can also require its own runner.
- **Auto mode** needs `mcp__plugin_codebook_codebook__claim_proof` in `permissions.allow` (below). The plugin refuses that
  tool to Claude whatever your settings say: it is the plugin's own call, and its answer holds the token the result is
  reported with.

## Saving conversations

A session that calls CodeBook is saved to your CodeBook account as it happens, from its first word: what was said, thought, called and answered, and each sub-agent as its own conversation, linked to the factory, story and agent it worked on. A session that never calls CodeBook stays on your computer. Only you can read what is saved, in the app's manager chat and agent chats and under Factory settings › Your computer. From there you can carry one on with an agent in the app.

- **It never gets in the session's way.** The upload runs in the background one piece at a time, and a failure waits and tries again without a word. If you were offline, or a session ended before its last rows went up, a later session catches it up from where it stopped. It has its own connector limit, so it does not use the 120 requests a minute your work needs.
- **Secrets are removed first**, on your computer, and checked again by CodeBook: known key formats, private keys, authorization headers, connection-string logins, sensitive names given a value, and whatever a tool read from a `.env` file. That is best effort. A password typed into a sentence, or a key in a format nobody listed, may not be recognised.
- **What it leaves out**: the transcript's bookkeeping (API request records, file history, costs, the instruction text repeated each turn), about three quarters of the file. Images go as a line saying one was there. The middle of a block over 280,000 characters is not saved, and the row says so.
- **It needs one permission**: `mcp__plugin_codebook_codebook__capture_transcript` in `permissions.allow`, under Auto mode above. Without it nothing is saved, and it says so once.
- **`/factory capture off`** stops it on this computer; `/factory capture on` starts it again; `/factory capture status` says where it stands; `/factory capture backfill` uploads this project's older sessions that used CodeBook. Saved conversations in the app has the same switch for every computer, and how long they are kept (a year by default). What is said while it is off is never uploaded later, even after turning it back on.
- It reads the file with `sh`, `tail` and `head`, so it needs a POSIX shell: on Windows without one nothing is saved.

Claude's chat tab and ChatGPT cannot do this: a connector sees tool calls, never the conversation. There, ask the model to save the chat, and it writes a copy with `save_conversation`, labelled in the app as a copy the model wrote. Or import the app's export under Saved conversations.

## What is sent where

- **To CodeBook (app.codebook.work)**, over the connector, signed in as you: the factory and story you pick, the story
  title you type, your Approve / Send back decisions and reasons, and, for a station worked here, the claim, the
  summary of what was done, the pull request link and the artifacts the station asks for. And, for a session that calls
  CodeBook, that session's conversation, with secrets removed as best they can be recognised: see Saving conversations.
  `/factory capture off` stops it.
  And, for a proof run: each command's exit code, the last million characters of its output, a hash of it, the commit
  and whether the checkout had uncommitted changes (see Proof runs).
- **To your repository's git remote (for example GitHub)**: the branch and the draft pull request, with your own
  `git` and `gh` credentials.
- **Nothing else.** The plugin has no servers of its own, no analytics, and no keys in this repository. Your code
  stays in your checkout except what you push. Privacy: <https://codebook.work/privacy>.

## What is in this repository

| Path | What it is |
| --- | --- |
| `.mcp.json` | The CodeBook connector (`https://app.codebook.work/mcp`), with no credentials. |
| `hooks/` | The Factory pane, `/factory` and the repository guard (a Claude Code hooks module): `register.tsx`, `pane.tsx`, `factory.ts`, `connector.ts`, `guard.ts`, `resolve.ts` (what git and gh decide for a push), `local.ts` (the checkouts `/factory status` shows), and `art.ts` (the illustrations, small WebP). |
| `skills/factory-manager/` | The manager skill Run here follows: the code on your computer, stories, "proceed?", stations, people, narration. |
| `agents/factory-worker.md` | The sub-agent that works one station run here as that station's agent. |
| `agents/benchmark-worker.md` | The sub-agent that answers one benchmark run here, as the model the manager chose, for CodeBook's judge to grade. |
| `hooks/proof.ts` | Proof runs: the repository's checks, run here boxed and reported by the plugin itself. |
| `types/index.d.ts` | The pane's state contract. |
| `test/` | Tests for `claude plugin test`. |
| `.claude-plugin/` | The plugin manifest, the marketplace file and the icon. |

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`scripts/art.sh <folder of PNGs>` rebuilds `hooks/art.ts` from the illustrations.

## License

MIT
