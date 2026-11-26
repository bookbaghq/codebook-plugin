# CodeBook for Claude Code

Run your [CodeBook](https://app.codebook.work) factories from Claude Code. Start a story, watch its stations move in a
**Factory pane** beside the chat, approve or send back the stations that wait for you, and let the agent stations
**run here**, in your own checkout on your computer, with your own Claude plan. app.codebook.work shows the same story moving, live.

<img src=".claude-plugin/icon.png" alt="CodeBook" width="160">

For a dedicated Codex manager on your signed-in ChatGPT plan, see the [local Codex manager guide](docs/codex-local-manager.md).

## Install

From a shell with Claude Code installed, add Bookbag’s public marketplace and install the plugin for your user profile:

```bash
claude plugin marketplace add bookbaghq/codebook-plugin
claude plugin install codebook@codebook --scope user
claude plugin list
```

Look for **codebook@codebook**, a version number, **user** scope and **enabled** status. To inspect its agents, skill and MCP server, run `claude plugin details codebook@codebook`. Start Claude Code, or enter `/reload-plugins` in an open session, then enter `/factory help` at the Claude Code prompt.

You can also install in one shell command with `claude plugin install codebook --marketplace bookbaghq/codebook-plugin`, or enter `/plugin install codebook --marketplace bookbaghq/codebook-plugin` at the Claude Code prompt. In the **Code** view of Claude Desktop, open **+ → Plugins → Add marketplace**, enter `bookbaghq/codebook-plugin`, then add **codebook**. User scope makes the plugin available across your projects.

## Update

Refresh the marketplace, update the plugin in its installed scope, and check the version:

```bash
claude plugin marketplace update codebook
claude plugin update codebook@codebook --scope user
claude plugin list
```

Reload plugins in an open Claude Code session or start a new one. For Windows and WSL setup, sign-in troubleshooting, and removal, see the [CodeBook support guide](https://codebook.work/docs/claude-and-chatgpt/connect-claude).

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
| `/factory report Payments WO-7` | Reopen the work order from any signed-in session. Read milestone evidence, recorded cost, remaining budget, deadline, held operations and production decisions. For reviewed production alerts, see whether the owner rolled back or kept the deployment and the note they recorded. The command makes one read-only request. |
| `/factory overnight Payments "Migrate the invoice exporter"` | Draft a cloud work order with milestones and acceptance checks. Review the plan and its manager’s token ceiling. Once approved, the cloud manager supervises the work and reports back after you close the terminal. Later milestones follow your factory’s approval policy. |
| `/factory run Payments "Let customers refund a payment"` | Starts a story in the Payments factory and follows it in the pane. Add `--here` or `--cloud` to choose for this story. |
| `/factory manage Payments --workflow wf12` | Keep this local session watching the selected workflow after its current stories finish. Use `/factory status` to see the last poll, pending notices and retry status. |
| `/factory status` | Where the story is, station by station, and where each repository's code is on this computer (checked as you ask). |
| `/factory list` | The factories you can see. |
| `/factory backlog Payments` | List up to 15 stories waiting to enter a station. Each row includes a follow command and any pending work-order item. Choose **View backlog** in the Factory pane and use **Next page** to browse there. Use the printed next-page command or add `--workflow "Release QA"` to select another workflow. Older servers can show these stories in the web Backlog drawer. |
| `/factory follow #57 Payments` | Follows a story on the board or in its backlog. Use the story ID from the backlog list to follow across workflows. |
| `/factory here` / `/factory cloud` | Where agent stations run: for the next stories, and for the followed story too (while none of its runs is being worked). The pane's two picture buttons do the same. |
| `/factory stop` | Stops following; the story keeps moving on app.codebook.work. |
| `/factory outside` / `/factory inside` | In a factory's checkout: work outside the factory for this session (no story first, no question before a push), or through it again. |

For a local manager that outlives the terminal, start a dedicated session with `claude --bg --name "Payments manager"`
and attach with `claude attach <id>`. Enter `/factory manage Payments --workflow wf12` there. Start new work in that
session or explicitly hand it a story with `/factory follow <story-id> Payments`. Keep one owner for each story. Detach
from the background session when you close the window. If its process exited, check `claude agents --json` and resume
the offline ID with `claude --bg --resume <id>`. Resuming a running ID can create a copy.

The workflow watch reads factory changes every 30 seconds while the host is running and reconciles readiness at least
every five minutes. It reads further readiness pages when the server supplies them. Older servers expose only their
first manager-readiness page. Unchanged and parked work requires no model turn. A rejected submission remains pending
for a later attempt. The status line reports the host submission, which is separate from a model quota or station outcome.
`/factory stop` clears the watch for this session.

To cap an overnight work order, add `--max-usd 25` to the command. Add
`--deadline 2030-05-15T08:00:00-04:00` to set an absolute stop time. Replace
the example date with your deadline. Either limit can be set on its own. The
manager shows the limits CodeBook recorded when you review the proposal. The
USD cap covers the whole order at configured rates. The dedicated manager has
its own token ceiling.

[Walk through an overnight work order](https://app.codebook.work/guides/overnight-work.txt).

The pane shows the story's stations as cards. A station that waits for you shows **Approve** and **Send back**
(with the pull request to look at); both do exactly what the buttons on app.codebook.work do, once you send the
request they put in your prompt box. A question for you (from an agent or the manager) shows its text and **Answer**,
which puts "Answer #57: " in your prompt box for your words. When "proceed?" creates several stories, the pane shows
the first and the plugin follows them all: whatever waits on you in any of them wakes the chat with the question or
the approval.

## In a factory's checkout

You do not have to say "factory". When a session starts in a folder whose git `origin` is a repository one of your
CodeBook factories works on, the plugin finds that out by itself and the session becomes that factory's manager:

1. At session start the plugin reads `git remote get-url origin` and asks CodeBook (`checkout_factory`) which of your
   factories work on that repository. It sends the host and `owner/name`, nothing else.
2. When one does, the conversation's context carries CodeBook's own instructions for that factory's manager: the same
   words ChatGPT and Codex are given. A request that changes code, opens a pull request or merges one becomes a story
   the factory's agents work (story writer, "proceed?", stations). A question or a read is answered as usual.
3. Outside a station's run, `git push`, `gh pr create` and `gh pr merge` in that checkout are put to you before they
   run: "this repository is worked by the factory X". Allow it to do it yourself, this once; or refuse it and ask Claude
   to put the change through the factory.

In any other folder the plugin adds nothing and asks nothing. If you are signed out or offline it learns nothing, does
not hold up a prompt for more than two seconds (once), and tries again a few minutes later.

**What is enforced and what is not.** The question before a push, a pull request or a merge is the only thing a
program stops, and only for commands the plugin can read (`git push`, `gh pr create`, `gh pr merge`, and commands it
cannot read at all, which it asks about). In a session with nobody to ask (`claude -p`), the command is refused.
Everything else is instruction: Claude is told to work through the factory, and nothing forces it. CodeBook's own gates
(station contracts, the merge rule, your host's branch protection) are what hold when an instruction is ignored.

**Turning it off.**

| For | How |
| --- | --- |
| one push | Allow it when asked. |
| this session | `/factory outside` (`/factory inside` turns it back on). |
| always, in this checkout, in every assistant | Tell Claude "I work outside the factory here" (it saves it with `work_outside_factory`), or Factory settings → Your computer in CodeBook. |

**ChatGPT and Codex** have no plugin, so nothing asks before a push there. They are told two ways: the CodeBook
connector's own instructions, and a block in the repository's `AGENTS.md` that an owner or admin adds with one draft pull
request (ask Claude for it: `propose_agents_block`). Codex reads `AGENTS.md` at the
start of every run.
In a trial with the Codex CLI, the block made Codex ask CodeBook first (and stop and ask you when CodeBook was not
connected); the connector's instructions alone did not. So add the block to each repository a factory works on.
Codex has no plugin, so the manager's rules below ("What the manager decides, and what it asks you") reach it from
CodeBook itself: the `AGENTS.md` block, and what `checkout_factory` and `manager_brief` answer. What Codex does
follows the server's text, not this plugin's.

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
it asks you, and the pane says so under Approve. A person approves a merge only at a person's station in the workflow:
CodeBook keeps no factory-wide approval switch (approval rules live in MadeBook, and with MadeBook linked a merge waits
for its `madebook/compliance` check). A factory whose policy keeps work in CodeBook refuses Run here.

**Only the factory's repositories change.** While a CodeBook run is held, the plugin refuses its worker (the agent
that claimed it) any `git push` or `gh pr create` that reaches a repository the run's brief does not list, and refuses
everyone else in the session a push or pull request to the repositories held runs work on: only a run's worker has its
lease (and CodeBook refuses to link a pull request from anywhere else). The rest of the session is not held back: a
push to a repository no held run works on goes through, as with no run held. The guard reads each command in its own folder (`git -C <folder>`, `cd <folder> &&`,
`gh … --repo`), so pushes from your checkout and its worktrees go through and anything else is refused. A push it cannot
attribute with confidence (through a wrapper such as `timeout` or `xargs`, a subshell, a shell or script, git
configuration or a remote changed in the same command, or a `gh api` write to pull requests) is refused too, with the
plain `git -C <checkout> push <remote> <branch>` or `gh pr create --repo <owner/name>` to run instead.

Station workers leave pull requests as drafts. The guard refuses a worker's `gh pr merge` and `gh pr ready` as well
as `gh api` writes that merge or enable auto-merge. CodeBook merges at Done according to the factory's workflow.

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

Claude can change these too, after your yes (`set_parallel`): your computer's number always, a station's cards at once and
its agents only where the factory lets the manager change its settings (below). Many test suites at once slow a computer down, and tests that
share a port or database can fail each other: lower the number if that happens.

**Who is working on what.** Each code worker tells CodeBook its branch, worktree and the files it expects to change. Two
cards touching the same files say so on both cards and in the chat, before they meet at merge; neither is stopped, because
the list is an estimate. The manager decides whether one waits (the one further along goes first) and says so in one
line. If one waits, its run stops, keeps its branch, and starts afresh once
the other is merged: merge order is on the factory, not written in a story.

### Code on your computer

Run here works on your own copy of each of the factory's repositories, wherever you keep it; the session can be opened
anywhere. In the factory's settings on app.codebook.work, **Your computer** holds, for each repository, the folder
of your existing checkout ("This folder already has the code") or a folder to clone it into ("Clone it into this
folder", for example `~/code`). Only you see it, and nothing secret is stored.

Before any research or station, the manager checks each repository (step 0 of the skill): the folder is there, it is a
git checkout whose `origin` is that repository, and git can reach it (`git ls-remote`), then fetches. If no folder is
set, it uses this session's folder when that is a checkout of the repository and says so, or asks you for one and
saves it for you. A missing folder: it offers to `git clone` it there, and clones only on your yes. A folder that is not a git
checkout, or has another `origin`: it says so and asks what to do. It never deletes, moves or overwrites a folder.
Setting this up is not factory work, so it needs no story; cloning and adding a remote need your yes.

Each worker checks the same before it works and reports **blocked**, with what to fix, when the folder is missing or
wrong; it never falls back to the session's folder. Code stations work in a worktree next to the checkout,
`<checkout>-<story number>` (for example `~/code/payments-58`), which QA then tests. With an older CodeBook that has no
**Your computer** setting, the session's folder is the checkout, as before.

Claude chat and ChatGPT on the web cannot reach your computer: stations that change code run here in Claude Code, or in
CodeBook's cloud. Codex can work in a checkout, but Run here, the pane and the question before a push are this
plugin's: from Codex, the factory's stations are started in CodeBook's cloud.

### What the manager decides, and what it asks you

The manager decides how the work gets delivered. It says what it decided in one line, and never asks you about it:
whether to split a story, the order stories merge in, which story a fix belongs in, which agent or model works a
station, and whether to retry a failed run (two retries for the same cause, then it says what blocks the story and
takes the next one).

It asks you only for these: spending money, touching production data, deleting things, secrets and keys, a real
outside account that no stand-in can replace, and a merge where the factory keeps a person's station. Everything else
about delivering the work it decides itself. What you want built is still yours to say: the story writer may ask
about the scope and what "done" looks like, and writes down what it assumed.

A change to the factory itself (an agent, a station, a limit) is offered in one sentence and made on your yes; the
work carries on meanwhile. These rules are CodeBook's own sentences, copied word for word from its server, and where
`manager_brief.rules` words one differently, the server wins.

**The factory's settings.** The manager uses the active approved check revision when it already covers the request. If a new proof definition is needed, the server names who decides. An owner who enables delegated routine changes can see the manager's decision on the saved revision. Person-owned previews still ask for the exact change when approval is missing.

On older servers, a factory's settings are changed only where the factory lets the manager, by its own switch
under Factory settings › Controls ("Let the manager change this factory's settings. It still asks you before each
change."), and only after your yes each time. The switch is off until you turn it on. With it on, the manager says in
the chat which setting it would change and what that does, and changes it (`change_factory_setting`) only after your yes.
With it off, it tells you where the setting is and changes nothing; CodeBook refuses the change anyway. The switch
itself, the factory's autonomy level, the kill switch, emergency revoke and who merges finished work stay yours, on the
website.

**New stories, and the next story.** How far the manager goes alone is the factory's own setting (Factory settings ›
Controls; `manager_brief.goes_alone`):

| Level | New stories | When a story finishes |
| --- | --- | --- |
| Ask before every new story (the default) | It shows you each one with its criteria and asks "proceed?". | It says which story is ready next and asks "proceed?". |
| Its own stories, in a work order you approved | It confirms the stories it wrote for that work order and says so in one line. A new work order, or a story a person wrote, is asked first. | It starts the next ready story itself, up to the factory's limits, until nothing is ready. |
| Any story it wrote | It confirms the stories it wrote, in any work order, and says so in one line. A story a person wrote is asked first. | The same. |

It looks for the next ready story in the runs waiting here, the lines of open proposals and the board's Backlog. After
each finished story it looks at the Backlog too, starts the stories that are ready as the factory's setting allows, and
tells you which ones are parked and on what. With
an older CodeBook that reports no setting, it asks "proceed?" before every new story, as before.

**Tests run on a local copy.** A worker that needs the running app tests on a local copy it builds itself, never
against production. It builds and starts the app from its own worktree, on free ports, with a throwaway database,
seeds it, and creates its own test accounts and organisations there, with stand-ins for sign-in and for outside
services. Never your own running app, ports, database or checkout. A story that can be finished with a stand-in, a
recorded response or a contract test is finished that way, and the card says what was not checked. Only a real
outside account that no stand-in can replace is asked for, with the offer to skip that one check.

**No recipe.** A check or a proof that cannot run because the repository has no recipe does not stop there: the
manager reads the repository and proposes the recipe (`run_recipe_change`). Where the factory lets it go alone the
recipe is saved and the check runs again; otherwise it asks you to save it under Factory settings → Proof runs.
Passing a check by hand is the last resort.

### What the manager does with a new issue

1. **The story writer goes first.** Claude sends the factory's story writer (its business analyst) to look into the
   issue as a sub-agent, with that agent's own skill. It only reads. Its questions about what you want come back to
   Claude, which asks you in the chat with the likely answers; what the request, the code and the board already
   answer it does not ask, and writes into the story as an assumption. Then it writes the stories.
2. **No story writer?** Claude says so in one line, writes the stories itself this time, and offers to add one. On
   your yes it looks at the agents your organization already has, then the marketplace, then writes a new one; it
   says which it picked, installs it, adds its station first in the flow and sets its model (Sonnet by default). The
   first change asks Bookbag for one more permission ("Change your factories' agents and stations").
3. **A story writer that cannot research**: this time a read-only sub-agent researches for it. Claude offers to add a
   Research agent; once there, its findings go on its card and the story writer reads them to write the stories.
4. **"Proceed?"** where the factory's setting for new stories says to ask, then the stations, as above.

On the board, Claude can also move and edit any card (`move_card`, `update_card`), ask you something on a card
(`ask_person`: one of the six things, or what you want, never how to deliver it), and set a station's model
(`set_station_model`, after your yes). It deletes a card (`delete_card`)
only after "proceed?", and CodeBook refuses unless the card's exact title is given.

**The rest of the factory.** Claude can also read and use the factory's other screens: work orders (plan, replan,
edit), test runs, operations (pause and resume,
alerts), a story's outcome (report a production problem) and the dashboard. The order of a work order's items is the
manager's to decide. Anything that spends, deletes or changes the factory waits for your yes; the kill switch and
autonomy stay on the website.

**Models.** Each station's agent runs on the Claude model CodeBook picks for it: the station's own when it is a Claude
model, otherwise Sonnet (or this session's model for a station that writes code). A station that asks for another
provider's model (GPT-5, say) can be kept in CodeBook's cloud on that model, for your stories only (`set_station_cloud`,
after your yes, or Factory settings › Your computer); the rest of the story still runs here. When a run here used
another model than the station asks for, CodeBook notes it on the story.

**Run in CodeBook**: CodeBook's own agents run the stations on its servers, as from the website. The pane still follows
the story and you still approve your stations here. Nothing runs on your computer unless you press **Work it here**.

## Permissions

The plugin itself only **reads** CodeBook, with one exception that is its own work: it reports the proof runs it made
(Proof runs). The pane lists your factories and follows the
story you chose, and at session start the plugin asks which factory works on the folder's repository (In a factory's checkout). Every other change is yours to send. Start, Approve, Send back and moving a story to Claude or to CodeBook put the request,
in plain words, into your prompt box; you press Enter, and Claude makes the call under your usual permission
settings (in auto mode, the auto-mode check judges it like anything you type). The pane picks up the answer.

### Auto mode

In auto mode Claude Code checks each tool call against what you asked for. The pane's own refreshes and the proof runs it
takes come from the plugin, not from a message of yours, so the check refuses them: the pane says "Not reached". Allow them in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_codebook_codebook__list_factories",
      "mcp__plugin_codebook_codebook__story_status",
      "mcp__plugin_codebook_codebook__story_trail",
      "mcp__plugin_codebook_codebook__checkout_factory",
      "mcp__plugin_codebook_codebook__claim_proof"
    ]
  }
}
```

The first four are reads (`checkout_factory` is the question "which factory works on this repository?"; without it the
session may learn it only when Claude asks, as the connector's instructions tell it to). `claim_proof` lets the
plugin take a proof run you or your agent asked for (see Proof runs); the plugin refuses it to Claude. Nothing else skips the check: starting a
story, approving, sending back and changing a factory still go through your prompt box and your permission mode.

## Proof runs

CodeBook counts a check as proven when a program ran it and reported the result itself, not when an agent says it did.
On your computer that program is this plugin.

- **An agent asks, the plugin runs.** When Claude calls `request_proof` for a story, the plugin takes the proof from
  CodeBook, runs the repository's checks in the run's worktree at its pull request's head (below), or, with no run,
  in your checkout (the recipe under Factory settings → Proof runs: test, lint,
  type check, build), and sends CodeBook each command's exit code, its output, a SHA-256 of that output, the commit that
  was checked out and whether anything was uncommitted. The story then shows the command as **Verified · run on a
  person's computer**. Claude reads what CodeBook recorded; it never writes the result.
- **Where it runs.** The plugin picks the folder, not CodeBook. For a run's proof it looks at every working tree of the
  repository on this computer (your checkout and its worktrees): the worktree the run declared (`declare_work`), one
  on the run's branch, or one whose branch names the story (`VF-29`), and runs in the one whose commit is its branch's
  tip on origin, the pull request's head (fetched first). When none is at the head, only the run's own declared
  worktree runs, and the summary says it proves no pull request's head; your checkout on another branch never runs in
  its place, and the proof stays waiting. When CodeBook names the commit, the working tree that has it checked out
  runs, or nothing does.
- **`/factory prove`** runs a proof that is waiting, such as the one "Try it" queues from Factory settings → Proof runs.
- **Boxed.** Each command runs under the system's sandbox where there is one: Seatbelt (`sandbox-exec`) on macOS,
  bubblewrap (`bwrap`) on Linux. It can write only in the checkout, in `~/.codebook/proof` and in the temporary folders;
  it cannot read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.netrc` or
  `~/.npmrc`; it gets a short list of environment variables (`PATH`, `HOME` and a few more), not your session's; and it
  reaches only the computer itself unless the recipe says its checks need the network, or a list of allowed hosts
  names more (below). With no sandbox on the computer the command still runs, and the story says it was not boxed.
- **Allowed hosts.** Between "the computer itself" and "everything" is a list: the hosts a repository's checks may
  reach, and no others. You keep yours in the plugin's `proof_hosts` option (its row in `/config`, or
  `claude plugin configure codebook` in a terminal), separated by commas; the recipe's own
  `hosts` are added when CodeBook sends them. An entry is a host name (`registry.npmjs.org`), a host and port
  (`git.example.com:8443`), every name under a domain (`*.githubusercontent.com`, not the domain itself), or an address
  (`93.184.215.14`, `[2606:4700::6810:84e5]:443`). With no port an entry allows 443 and 80. A name on your own network
  or a private address is written `private:git.lan`. Refused, and said in the summary: `*`, `*.com` and any wildcard
  that is not the first label, an address range (`10.0.0.0/8`), a URL (`https://…`), a port outside 1–65535, the
  computer itself (always reachable, as before) and more than 64 entries. A recipe that says `full` keeps the whole
  network, as before.
- **How the list is enforced.** Neither sandbox can name a host (Seatbelt's network rules take only `localhost` or `*`,
  and bubblewrap has a network or none), so a run with a list keeps the box it has with no network and the plugin
  starts a small filtering proxy outside it, the only way out: on macOS on `127.0.0.1` (a port the system picks); on
  Linux on a socket in `~/.codebook/proof`, reached through a forwarder inside the box's own network on its
  `127.0.0.1:3128`. Each command is told the proxy (`HTTPS_PROXY`, `HTTP_PROXY`, and the spellings npm, yarn and Node
  read). The proxy lets through CONNECT (https, git over https) and plain http to a host and port on the list, resolves
  the name itself and connects to that address, refuses a name that resolves to a private, loopback or link-local
  address unless the entry says `private:`, and answers anything else 403. CodeBook is told the list each result ran
  with, and the summary names the hosts the proxy refused. The proxy needs Node.js on your `PATH`; without it the run
  reaches the computer itself only, and says so.
- **Failures that were already there.** When a check fails, the plugin runs it again on the default branch in a separate
  worktree under `~/.codebook/proof/baseline`, so CodeBook can say which failures are new. Your checkout is never
  switched, stashed or reset. Dependencies are linked from your checkout when both commits pin the same ones; otherwise
  the recipe's install line runs in that worktree, with the network.
- **Commit first.** A run on uncommitted changes is recorded and proves no commit.
- **Limits.** One command runs for at most ten minutes. The sandbox limits a repository's test code; it does not make a
  forged report impossible for a model that set out to send one from your shell, which is why a factory can also
  require its own runner. The list of allowed hosts:
  - works for programs that use an HTTP proxy (curl, git over https, npm, yarn, pip, Node's `fetch` with the variable
    the plugin sets). Anything else (git over ssh, a database or a raw socket to an outside host, a program that
    ignores the proxy variables) reaches nothing beyond the computer: the sandbox refuses it, list or not;
  - is decided by the name the program asks the proxy for, and the address the proxy itself resolves. It does not read
    inside TLS, so an allowed host is allowed whole (every path on it), and `*.example.com` is every name under it; a
    public suffix such as `*.co.uk` is not known as one and is not refused;
  - leaves "the computer itself" as it is today: on macOS anything listening on this computer's loopback (the proxy
    among them, and any other local proxy or service); on Linux the box's own loopback only;
  - keeps the proxy on `127.0.0.1` while a run lasts (macOS), where another program of yours could use it too; it reaches
    only the listed hosts;
  - does not apply to the baseline's install line (Failures that were already there), which has the network, as
    before;
  - is not enforced on a computer with no sandbox: the command is told the proxy and may ignore it, and the summary
    says the run was not boxed.
- **Auto mode** needs `mcp__plugin_codebook_codebook__claim_proof` in `permissions.allow` (below). The plugin refuses that
  tool to Claude whatever your settings say: it is the plugin's own call, and its answer holds the token the result is
  reported with.

## What is sent where

- **To CodeBook (app.codebook.work)**, over the connector, signed in as you: the factory and story you pick, the story
  title you type, your Approve / Send back decisions and reasons, and, for a station worked here, the claim, the
  summary of what was done, the pull request link and the artifacts the station asks for. Never your conversation:
  saving conversations belongs to MadeBook.
  And, for the folder a session is in, when it is a git checkout: the repository's host and `owner/name`, to ask which
  of your factories work on it. Never the address as git holds it (it can carry a token), the folder's path or any file.
  And, for a proof run: each command's exit code, the last million characters of its output, a hash of it, the commit
  and whether the checkout had uncommitted changes, and, when the run had a list of allowed hosts, that list (see Proof
  runs).
- **To your repository's git remote (for example GitHub)**: the branch and the draft pull request, with your own
  `git` and `gh` credentials.
- **Nothing else.** The plugin has no servers of its own, no analytics, and no keys in this repository. Your code
  stays in your checkout except what you push. Privacy: <https://codebook.work/privacy>.

## What is in this repository

| Path | What it is |
| --- | --- |
| `.mcp.json` | The CodeBook connector (`https://app.codebook.work/mcp`), with no credentials. |
| `hooks/` | The Factory pane, `/factory` and the repository guard (a Claude Code hooks module): `register.tsx`, `pane.tsx`, `factory.ts`, `connector.ts`, `guard.ts`, `resolve.ts` (what git and gh decide for a push), `checkout.ts` (a checkout that knows its factory: the lookup, the note for the session and the question before a push), `local.ts` (the checkouts `/factory status` shows), and `art.ts` (the illustrations, small WebP). |
| `skills/factory-manager/` | The manager skill Run here follows: the code on your computer, stories, "proceed?", stations, what it decides and the six things it asks a person, taking the next story, narration. |
| `agents/factory-worker.md` | The sub-agent that works one station run here as that station's agent, testing on a local copy of the app it builds itself. |
| `test/rule-texts.mjs` | Checks, with plain Node, that the skill and the agent carry CodeBook's rule sentences word for word, and that nothing tells the manager to ask about a split, an order or a retry. |
| `hooks/proof.ts` | Proof runs: the repository's checks, run here boxed and reported by the plugin itself. |
| `hooks/egress.ts` | A proof run's list of allowed hosts: reading the list, and the filtering proxy and forwarder that enforce it. |
| `types/index.d.ts` | The pane's state contract. |
| `test/` | Tests for `claude plugin test`. |
| `.claude-plugin/` | The plugin manifest, the marketplace file and the icon. |

## Develop

```bash
claude plugin validate .
claude plugin test .
node --test test/rule-texts.mjs
claude --plugin-dir .
```

`claude plugin test` loads code files only, so the checks on what the skill and the agent say (`test/rule-texts.mjs`)
run with Node.

`scripts/art.sh <folder of PNGs>` rebuilds `hooks/art.ts` from the illustrations.

## License

MIT
