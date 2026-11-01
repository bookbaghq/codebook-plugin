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
| `/factory follow #57 Payments` | Follows a story that is already on the board. |
| `/factory here` / `/factory cloud` | Where the agent stations of the next stories run. |
| `/factory stop` | Stops following; the story keeps moving on app.codebook.work. |

The pane shows the story's stations as cards. A station that waits for you shows **Approve** and **Send back**
(with the pull request to look at); both do exactly what the buttons on app.codebook.work do.

## The two run modes

**Run here** (the default): the factory's agent stations come to this Claude Code. When one is ready, the pane asks
Claude to work it with the **factory-worker** agent, which:

1. claims the station's run in CodeBook and reads its brief (instructions, the story, what to produce);
2. checks it is in the right repository, with no uncommitted work of yours in the way;
3. makes the change on a new branch, runs the tests;
4. opens a **draft** pull request with your local `git` and `gh`;
5. keeps its claim alive while it works, then reports pass, fail or blocked with a short summary.

It never merges, never pushes to your default branch, and never force-pushes. The work uses your Claude plan;
CodeBook records the run but does not bill it.

**Run in CodeBook**: the agent stations run in CodeBook's cloud as they do from the website. The pane still follows the
story and you still approve your stations here. Nothing runs on your computer unless you press **Work it here**.

Open Claude Code in the repository the factory works on: the worker works in the current checkout and stops (blocked)
if it is the wrong one.

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
| `hooks/` | The Factory pane and `/factory` (a Claude Code hooks module): `register.tsx`, `pane.tsx`, `factory.ts`, `connector.ts`, and `art.ts` (the illustrations, small WebP). |
| `agents/factory-worker.md` | The agent that works a run-here station. |
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
