# CodeBook for Claude Code

Run your [CodeBook](https://app.codebook.work) factories from Claude Code. Start a story, watch its stations move in a
**Factory pane** beside the chat, approve or send back the stations that wait for you, and let the agent stations
**run here**, in your checkout, with your own Claude plan. app.codebook.work shows the same story moving, live.

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

The plugin never sees or stores a password or a token: Claude Code keeps the sign-in, and the connector only lets you
do what you can do on app.codebook.work.

## Use it

| Type | What happens |
| --- | --- |
| `/factory` | Opens the Factory pane. Pick a factory and type what it should make. |
| `/factory run Payments "Let customers refund a payment"` | Starts a story in the Payments factory and follows it in the pane. Add `--here` or `--cloud` to choose for this story. |
| `/factory status` | Where the story is, station by station. |
| `/factory list` | The factories you can see. |
| `/factory follow #57 Payments` | Follows a story that is already on the board. |
| `/factory here` / `/factory cloud` | Where agent stations run: for the next stories, and for the followed story too (while none of its runs is being worked). The pane's two picture buttons do the same. |
| `/factory stop` | Stops following; the story keeps moving on app.codebook.work. |

The pane shows the story's stations as cards. A station that waits for you shows **Approve** and **Send back**
(with the pull request to look at); both do exactly what the buttons on app.codebook.work do, once you send the
request they put in your prompt box.

## The two run modes

**Run here** (the default): the whole factory runs in your Claude Code session, on your Claude plan. Claude becomes the
factory's **manager** (the `factory-manager` skill) and works by CodeBook's rules:

1. **No story, no work.** Your request becomes stories first. The factory's story-writing agent (for example its
   business analyst) writes them here. If the factory has none and you may change it, Claude offers to add one: an
   agent your workspace already has, one from the marketplace (your organization's section first), or a new one it
   writes and publishes to your organization's section only. Each change is asked first, and the first one asks
   Bookbag for one more permission ("Change your factories' agents and stations").
2. **"Proceed?"** Claude shows the proposed stories, with a link that opens them on app.codebook.work, and creates
   nothing until you say yes.
3. **Every station runs here.** For each agent station Claude spawns a **factory-worker** sub-agent that becomes that
   station's agent (its own skill from CodeBook), claims the run, writes its notes and artifacts on the card, works in
   this checkout, runs the tests, and opens a **draft** pull request with your `git` and `gh`. QA stations run the
   repository's tests here with CodeBook's "Test it here" skill. A crew's members each get a sub-agent.
4. **Your stations are asked in the chat**: approve or send back a review, answer a question from the manager.
5. **You see it move**: the chat says what moved, who is working, when an agent is spawned and when a pull request
   opens; the Factory pane shows the stations and what is on the card.
6. **Done** means the card holds every comment (signed "Agent (role) via your Claude Code"), every run (marked "own
   plan, not billed"), the pull requests and the artifacts.

Claude and its workers never merge, push to a default branch or force-push. **Approving a person's station can
merge**: a factory may merge the story's pull request when its station is approved, even a draft. Claude says so before
it asks you, and the pane says so under Approve. A factory whose policy keeps work in CodeBook refuses Run here.

**Only the factory's repositories change.** While a CodeBook run is held in the session, the plugin refuses any
`git push` or `gh pr create` that reaches a repository the run's brief does not list (and CodeBook refuses to link a
pull request from anywhere else). Open Claude Code in the repository the factory works on.

**Run in CodeBook**: CodeBook's own agents run the stations on its servers, as from the website. The pane still follows
the story and you still approve your stations here. Nothing runs on your computer unless you press **Work it here**.

## Permissions

The plugin itself only **reads** CodeBook: the pane lists your factories and follows the story you chose. Every
change is yours to send. Start, Approve, Send back and moving a story to Claude or to CodeBook put the request,
in plain words, into your prompt box; you press Enter, and Claude makes the call under your usual permission
settings (in auto mode, the auto-mode check judges it like anything you type). The pane picks up the answer.

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
| `hooks/` | The Factory pane, `/factory` and the repository guard (a Claude Code hooks module): `register.tsx`, `pane.tsx`, `factory.ts`, `connector.ts`, `guard.ts`, and `art.ts` (the illustrations, small WebP). |
| `skills/factory-manager/` | The manager skill Run here follows: stories, "proceed?", stations, people, narration. |
| `agents/factory-worker.md` | The sub-agent that works one station run here as that station's agent. |
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
