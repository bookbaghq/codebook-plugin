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

To let the manager pick newly authorized local backlog items itself, add `--manage-ready` to the start command. It reads the manager's workflow readiness pages, follows the existing approval and dependency rules, and verifies the current story before submitting a turn. It records its confirmation intent before contacting CodeBook and adopts the story only after receiving the exact manager-authorized local creation receipt. A lost or mismatched reply requires an explicit handoff before that story can be followed. An existing local run needs an explicit story assignment or the manager's own recorded confirmation. An active claim stays with its current worker.

For Development, select an existing isolated HTTPS clone for each approved GitHub repository and a named Codex permissions profile. If you keep that profile in a separate Codex config overlay, also supply its name. This option requires Python 3.11+ and reads only the selected filesystem and domain permission table. A direct story-to-repository assignment is optional when CodeBook already reports an unambiguous repository. Passing `--story` here selects its repository and does not transfer ownership.

```sh
python3 scripts/codex-manager.py route --factory FACTORY_ID --workflow wf22 --repo OWNER/NAME --checkout /absolute/path/to/isolated-clone --permissions PROFILE_ID --config-profile CONFIG_OVERLAY
```

The supervisor verifies the approved workflow repository, selects that profile on a separate Development host, and checks the clone's local write access and HTTPS Git transport inside the same sandbox before a model turn. Development uses a per-run worktree within that clone. Missing, mismatched or inaccessible routes appear under `development_holds` in status. Update the route or explicitly retry the held story after resolving access. An unchanged hold spends no model turns. Repository routes do not change the QA sandbox, native proof definitions, network grants or Codex defaults.

The detached process holds one lock per factory/workflow. It reads the event cursor every 30 seconds and reconciles current readiness at least every three minutes. The local app server starts a fresh, named station worker on your ChatGPT plan only for a qualifying change. Once the run has a live fence, the supervisor can dispatch other eligible work while the worker finishes. A rejected or unproductive wake receives at most three attempts per identity. Status includes the last successful event read (Unix time), cursor, dedicated thread, active work and reason for waiting. Interactive approvals park that wake. Inspect the recorded worker thread, resolve the decision and use `retry --factory FACTORY_ID --workflow wf22 --story OPAQUE_STORY_ID` to retry that held station explicitly.

```sh
python3 scripts/codex-manager.py stop --factory FACTORY_ID --workflow wf22
python3 scripts/codex-manager.py status --factory FACTORY_ID --workflow wf22
```

After stop records the fence, the supervisor closes its own host. Run start again with the same checkout after a restart or reboot. It restores the cursor, thread, owned stories and previous readiness opt-in. The state file `status.json`, controls and `manager.log` live under `$XDG_STATE_HOME/codebook/codex-manager/FACTORY_ID/wf22/`, defaulting to `~/.local/state/codebook/codex-manager/FACTORY_ID/wf22/`. The local account owns these private files. A disconnected network or unavailable sign-in backs off to a five-minute interval.
