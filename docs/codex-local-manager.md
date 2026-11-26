# Codex local factory manager

On macOS or Linux, use Python 3 and the signed-in Codex CLI with a connected CodeBook OAuth server named `codebook`. The installed CLI must support `app-server`, `mcpServer/tool/call` and `thread/turns/list`. Commands run as your local user. The computer must stay awake and connected.

Start in your dedicated checkout. Substitute the factory and workflow IDs returned by CodeBook.

```sh
python3 scripts/codex-manager.py start --factory FACTORY_ID --workflow wf22 --cwd /absolute/path/to/manager-checkout
python3 scripts/codex-manager.py status --factory FACTORY_ID --workflow wf22
```

First start observes CodeBook events with zero model calls. To put this manager in charge of a particular existing story, explicitly transfer its ownership from the previous session, then run the following command.

```sh
python3 scripts/codex-manager.py follow --factory FACTORY_ID --workflow wf22 --story '#123'
```

To let the manager pick newly authorized local backlog items itself, add `--manage-ready` to the start command. It reads the manager's workflow readiness pages, follows the existing approval and dependency rules, and verifies the current story before submitting a turn. It remembers the stories that its dedicated thread successfully confirms. An existing local run needs an explicit story assignment or the manager's own recorded confirmation. An active claim stays with its current worker.

The detached process holds one lock per factory/workflow. It reads the event cursor every 30 seconds and reconciles current readiness at least every three minutes. The local app server starts a model turn on your ChatGPT plan only for a qualifying change. A rejected or unproductive wake receives at most three attempts per identity. Status includes the last successful event read (Unix time), cursor, dedicated thread, active work and reason for waiting. Interactive approvals require the operator. Open the dedicated thread to inspect a hold.

```sh
python3 scripts/codex-manager.py stop --factory FACTORY_ID --workflow wf22
python3 scripts/codex-manager.py status --factory FACTORY_ID --workflow wf22
```

After stop records the fence, the supervisor closes its own host. Run start again with the same checkout after a restart or reboot. It restores the cursor, thread, owned stories and previous readiness opt-in. The state file `status.json`, controls and `manager.log` live under `$XDG_STATE_HOME/codebook/codex-manager/FACTORY_ID/wf22/`, defaulting to `~/.local/state/codebook/codex-manager/FACTORY_ID/wf22/`. The local account owns these private files. A disconnected network or unavailable sign-in backs off to a five-minute interval.
