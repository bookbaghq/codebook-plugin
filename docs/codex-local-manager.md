# Codex local factory manager

On macOS or Linux, use Python 3 and the signed-in Codex CLI with a connected CodeBook OAuth server named `codebook`. The installed CLI must support `app-server`, `mcpServer/tool/call` and `thread/turns/list`. Commands run as your local user. The computer must stay awake and connected.

Start in your dedicated checkout. Substitute the factory and workflow IDs returned by CodeBook.

```sh
python3 scripts/codex-manager.py start --factory FACTORY_ID --workflow wf22 --cwd /absolute/path/to/manager-checkout
python3 scripts/codex-manager.py status --factory FACTORY_ID --workflow wf22
```

For a bounded local trial, add `--local-token-budget N` to `start`. The
supervisor lets one station spend at a time and waits for its verified usage
receipt before dispatching the next. A running turn can exceed the remaining
amount. Once measured gross tokens reach the limit, new turns stop. Missing
measurements also hold new turns. The total and limit survive restarts. The
counter begins with receipts processed under the limit. It covers this local
workflow, and the provider measures account-wide subscription usage separately.

A first start with no assignments observes CodeBook events with zero model calls. To follow a single existing story in this mode, select its ID with the following command. Any active station lease stays with its current worker.

```sh
python3 scripts/codex-manager.py follow --factory FACTORY_ID --workflow wf22 --story '#123'
```

To manage the whole local workflow, add `--manage-ready` when starting the supervisor. It rechecks CodeBook’s current Run here assignments for this account and dispatches an unclaimed agent station even when another signed-in client confirmed the story. It also confirms manager-ready local backlog items after checking the approval and dependency rules. The confirmation journal records which stories this supervisor created. Each station worker still needs its own live claim. Human decisions, existing leases and repository capability holds stay visible in their normal locations. Subsequent starts preserve the saved workflow opt-in. With explicit story assignments alone, the supervisor limits dispatch to those stories and its previously adopted work.

For Development, select an existing isolated HTTPS clone for each approved GitHub repository and a named Codex permissions profile. If you keep that profile in a separate Codex config overlay, also supply its name. This option requires Python 3.11+ and reads only the selected filesystem and domain permission table. A direct story-to-repository assignment is optional when CodeBook already reports an unambiguous repository. Passing `--story` here selects its repository and does not transfer ownership.

```sh
python3 scripts/codex-manager.py route --factory FACTORY_ID --workflow wf22 --repo OWNER/NAME --checkout /absolute/path/to/isolated-clone --permissions PROFILE_ID --config-profile CONFIG_OVERLAY
```

The supervisor verifies the approved workflow repository, selects that profile on a separate Development host, and runs `git fetch --no-tags --no-recurse-submodules origin` in the same sandbox before a model turn. The isolated clone retains the fetched objects, origin-tracking refs and FETCH_HEAD for its worker. A temporary branch and worktree verify that Git can prepare the assignment. Development uses a per-run worktree within that clone. Missing, mismatched or inaccessible routes appear under `development_holds` in status. Update the route or explicitly retry the held story after resolving access. An unchanged hold spends no model turns. Repository routes do not change the QA sandbox, native proof definitions, network grants or Codex defaults.

The detached process holds one lock per factory/workflow. It reads the event cursor every 30 seconds and reconciles current readiness at least every three minutes. The local app server starts a fresh, named station worker on your ChatGPT plan only for a qualifying change. Once the run has a live fence, the supervisor can dispatch other eligible work while the worker finishes. A rejected or unproductive wake receives at most three attempts per identity. Status includes the last successful event read (Unix time), cursor, dedicated thread, active work and reason for waiting.

Interactive approvals park that wake. Even after restart, the supervisor checks pending decisions against the current run and station history in CodeBook. It clears the active hold once CodeBook confirms that the run ended or was superseded, and updates `interaction_required` without a model turn. If the story's status is unavailable, its request stays pending and other eligible stories can proceed. Inspect the recorded worker thread, resolve the decision and use `retry --factory FACTORY_ID --workflow wf22 --story OPAQUE_STORY_ID` to retry that held station explicitly.

```sh
python3 scripts/codex-manager.py stop --factory FACTORY_ID --workflow wf22
python3 scripts/codex-manager.py status --factory FACTORY_ID --workflow wf22
```

After stop records the fence, the supervisor closes its own host. Run start again with the same checkout after a restart or reboot. It restores the cursor, thread, owned stories and previous readiness opt-in. The state file `status.json`, controls and `manager.log` live under `$XDG_STATE_HOME/codebook/codex-manager/FACTORY_ID/wf22/`, defaulting to `~/.local/state/codebook/codex-manager/FACTORY_ID/wf22/`. The local account owns these private files. A disconnected network or unavailable sign-in backs off to a five-minute interval.

For paired private Git on macOS, version 0.32.0 includes the Development routing change and a native Swift device signer. Refresh the installed marketplace and plugin before switching the supervisor to this version.

```sh
claude plugin marketplace update codebook
claude plugin update codebook@codebook --scope user
claude plugin details codebook@codebook
```

Run the updated script from the installed plugin, with its package and state outside the worker workspace and writable clones. Keep the existing factory, workflow and manager checkout when stopping and starting an upgraded supervisor. After configuring the repository with `route`, run the following commands from the updated package.

```sh
python3 scripts/codex-manager.py git-enroll --factory FACTORY_ID --workflow wf22 --repo OWNER/NAME
python3 scripts/codex-manager.py git-status --factory FACTORY_ID --workflow wf22 --repo OWNER/NAME
```

Enrollment creates one Ed25519 device identity for the factory, workflow, repository and canonical clone in the operator’s local login Keychain. Repeating the command displays the same public information. In **Your computer**, select that repository, enter the printed clone path and public key, compare its SHA-256 fingerprint, and save. The signed-in status command reports whether the local identity matches the saved pairing. Each repository needs its own enrollment. Removing the pairing in **Your computer** withdraws access for that clone. A changed clone requires an explicit enrollment and pairing.

The protected signer requires macOS, an available Swift toolchain and an unlocked login Keychain. Its operations are noninteractive. The supervisor holds paired work when the store, restricted worker profile, paired service or enrollment is unavailable. Resolve the reported cause before using `retry` for the held story. The worker claims its own Development station through `factory_git_claim`, creates and declares its per-run worktree and branch, then uses `factory_git_fetch` and `factory_git_push`. These tools return a frozen claim brief or a Git receipt. The native operator handles Git packs, TLS and device signatures outside the model. The server approves each short-lived operation against the current fence and branch. A lost push confirmation requires checking the branch before explicitly retrying. The `last_git_receipt` in manager status records the most recent verified operation.

## Station usage

The supervisor reads the final native counters for its assigned turn and sends one fenced receipt through CodeBook. It exports counts only to EvalBook projects whose trace sharing was on when the run finished. An unmeasured run stays unknown. Delivery retries and idle observation run in the supervisor process. The private supervisor status shows outstanding receipts under `usage_pending`. Interactive chats outside an assigned station have separate usage.

Each new station starts a fresh thread with a 64,000-token automatic compaction threshold. This applies only to supervisor-created threads. Store the task checkpoint, repository revision and evidence on the story so the next station can retrieve what it needs.
