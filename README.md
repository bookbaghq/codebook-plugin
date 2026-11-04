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
alias that pushes, a gh extension, and a script, `npm run` script or Makefile that pushes are refused while a run is
held, and so is a push when your shell sets `GIT_DIR`, `GIT_WORK_TREE` or `GIT_CONFIG_*`.

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

The plugin itself only **reads** CodeBook: the pane lists your factories and follows the story you chose. Every
change is yours to send. Start, Approve, Send back and moving a story to Claude or to CodeBook put the request,
in plain words, into your prompt box; you press Enter, and Claude makes the call under your usual permission
settings (in auto mode, the auto-mode check judges it like anything you type). The pane picks up the answer.

### Auto mode

In auto mode Claude Code checks each tool call against what you asked for. The pane's own refreshes come from the
plugin, not from a message of yours, so the check refuses them and the pane says "Not reached". Allow the pane's
three read-only calls in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_codebook_codebook__list_factories",
      "mcp__plugin_codebook_codebook__story_status",
      "mcp__plugin_codebook_codebook__story_trail"
    ]
  }
}
```

Only those three reads skip the check. Starting a story, approving, sending back and changing a factory still go
through your prompt box and your permission mode.

## What is sent where

- **To CodeBook (app.codebook.work)**, over the connector, signed in as you: the factory and story you pick, the story
  title you type, your Approve / Send back decisions and reasons, and, for a station worked here, the claim, the
  summary of what was done, the pull request link and the artifacts the station asks for.
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
