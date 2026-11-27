#!/usr/bin/env python3
"""Observe a CodeBook workflow and wake its dedicated, signed-in local Codex manager."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

# runpy-based local hosts load the script without adding its directory to sys.path.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import paired_git
import native_usage
import milestone_routes

IDENT = re.compile(r"[A-Za-z0-9_-]{1,70}")
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
STORY = re.compile(r"(?:#[1-9][0-9]{0,9}|[A-Za-z0-9_-]{1,70})")
INTERVAL = 30
RECONCILE = 180
MAX_ATTEMPTS = 3
CLAIM_TOOL = "factory_station_claim"


class Hold(Exception):
    pass


class ProposalPaused(Hold):
    """CodeBook explicitly refused the confirmation before creating any stories."""


class Refused(Hold):
    pass


def validated(value, pattern=IDENT):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Invalid factory, workflow or story identifier.")
    return value


def read(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def save(path, data):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)


@contextlib.contextmanager
def locked(path):
    with path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def running(folder):
    with (folder / "owner.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def development_options(route):
    options = ["-c", "features.network_proxy=true"]
    name = route.get("config_profile")
    if not name:
        return options
    # app-server rejects the runtime CLI's -p option. Pass only the selected permission table.
    try:
        import tomllib
        config_home = Path(os.environ.get("CODEX_HOME", Path.home()/".codex"))
        with (config_home/(validated(name) + ".config.toml")).open("rb") as stream:
            profile = tomllib.load(stream)["permissions"][validated(route["permissions"])]
        filesystem, network = profile["filesystem"], profile["network"]
        if (set(profile) - {"description", "filesystem", "network"}
                or set(network) - {"enabled", "allow_local_binding", "domains"}
                or not all(isinstance(value, str) for value in filesystem.values())
                or network.get("enabled") is not True or not isinstance(network.get("domains"), dict)):
            raise ValueError
        # A single TOML inline table preserves literal filesystem paths and dotted domain names.
        def inline(value):
            if isinstance(value, dict):
                return "{" + ", ".join(json.dumps(k, ensure_ascii=False) + " = " + inline(v) for k,v in value.items()) + "}"
            if not isinstance(value, (str, bool)):
                raise ValueError
            return json.dumps(value, ensure_ascii=False)
        table = inline({"filesystem": filesystem, "network": network})
        options += ["-c", "permissions." + route["permissions"] + "=" + table,
                    "-c", "default_permissions=" + json.dumps(route["permissions"])]
    except (ImportError, OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        raise Hold("Cannot load the selected filesystem and domain permission table from the local overlay (Python 3.11+ required).") from error
    return options


class Host:
    """Use Codex's own OAuth transport. Only the app server receives credentials."""
    def __init__(self, cwd, development=None):
        env = dict(os.environ)
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
            env.pop(key, None)
        argv = ["codex"] + (development_options(development) if development else [])
        self.proc = subprocess.Popen(argv + ["app-server", "--stdio"], cwd=cwd, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.answers = queue.Queue()
        self.git_requests = queue.Queue()
        self.accept_git = bool(development and development.get("git_pairing"))
        self.serial = 0
        self.approval_threads = set()
        threading.Thread(target=self.listen, daemon=True).start()

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def listen(self):
        try:
            for line in self.proc.stdout:
                message = json.loads(line)
                if (message.get("method") == "item/tool/call" and "id" in message and ((message.get("params") or {}).get("tool") == CLAIM_TOOL
                        or (self.accept_git and (message.get("params") or {}).get("tool") in paired_git.TOOLS))):
                    self.git_requests.put(message)
                elif "id" in message:
                    self.answers.put(message)
        finally:
            self.answers.put(None)

    def call(self, method, params):
        self.serial += 1
        self.send({"id": self.serial, "method": method, "params": params})
        end = time.monotonic() + 30
        while time.monotonic() < end:
            try:
                msg = self.answers.get(timeout=max(0, end-time.monotonic()))
            except queue.Empty:
                break
            if msg is None:
                raise Hold("Codex app server disconnected.")
            if "method" in msg:
                # This unattended transport never answers approval, elicitation or tool requests for a person.
                self.approval_threads.add((msg.get("params") or {}).get("threadId"))
                self.send({"id": msg["id"], "error": {"code": -32603, "message": "Operator interaction required."}})
            elif msg.get("id") == self.serial:
                if "error" in msg:
                    raise Refused(f"Codex refused {method} (RPC {msg['error'].get('code')}); inspect the dedicated thread.")
                return msg["result"]
        raise Hold(f"Codex timed out during {method}.")

    def open(self, cwd, observe=True):
        self.call("initialize", {"clientInfo": {"name": "codebook_local_manager", "version": "1"},
                                 "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized", "params": {}})
        account = self.call("account/read", {"refreshToken": False}).get("account") or {}
        if account.get("type") != "chatgpt":
            raise Hold("Sign in to Codex using ChatGPT before starting this manager.")
        if observe:
            self.observer = self.call("thread/start", {"ephemeral": True, "cwd": cwd, "sandbox": "read-only",
                                                      "approvalPolicy": "on-request"})["thread"]["id"]

    def tool(self, name, **args):
        return self.tool_in(self.observer, name, **args)

    def tool_in(self, thread, name, **args):
        result = self.call("mcpServer/tool/call", {"threadId": thread, "server": "codebook",
                                                  "tool": name, "arguments": args})
        data = result.get("structuredContent")
        if not isinstance(data, dict):
            text = next((part.get("text") for part in result.get("content", []) if part.get("type") == "text"), None)
            try:
                data = json.loads(text) if isinstance(text, str) else None
            except ValueError:
                data = None
        if result.get("isError"):
            error = data.get("error") if isinstance(data, dict) else None
            if name == "confirm_stories" and isinstance(error, dict) and error.get("code") == "CONFLICT":
                route = error.get("goes_alone")
                if isinstance(route, dict) and route.get("next_action") == "wait_for_resume":
                    raise ProposalPaused("CodeBook paused this proposal. Waiting for resume and current readiness.")
            raise Hold(f"CodeBook refused {name}; check OAuth access and the selected scope.")
        if not isinstance(data, dict):
            raise Hold(f"CodeBook returned an unsupported response for {name}.")
        return data

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def read_events(host, scope, cursor):
    result = host.tool("factory_events", **scope, **({"after": cursor} if cursor else {}), limit=50)
    last = result.get("last_event")
    if last is not None and (type(last) is not int or last < 0):
        raise Hold("Unexpected CodeBook event cursor.")
    return max(cursor, last or 0), result.get("events", [])


def hosted_here(status):
    location = status.get("run_location")
    if isinstance(location, dict):
        return location.get("where") == "here" and (location.get("person") or {}).get("is_you") is True
    return location == "here"


def scoped_story_status(host, scope, story, statuses):
    if story not in statuses:
        try:
            status = host.tool("story_status", **scope, story=story, limit=1)
        except Hold:
            status = {}
        identities = {**scope, "story": story}
        statuses[story] = status if all(
            isinstance(status.get(field), dict) and status[field].get(field) == expected
            for field, expected in identities.items()
        ) else None
    return statuses[story]


def development_route(config, brief, status, story):
    """A host assignment never authorizes a new story or an unrelated checkout."""
    routes = config.get("development_routes", {})
    fields = status.get("story") or {}
    selected = {name for name, route in routes.items()
                if {story, fields.get("reference")} & set(route.get("stories", []))}
    declared = {row["repository"].lower() for row in (status.get("working_on") or {}).get("work", [])
                if row.get("source") == "declared" and isinstance(row.get("repository"), str)}
    assigned = fields.get("repository")
    if isinstance(assigned, dict):
        assigned = assigned.get("full_name") or assigned.get("name")
    if isinstance(assigned, str) and REPOSITORY.fullmatch(assigned):
        declared.add(assigned.lower())
    names = selected | declared
    if len(names) != 1:
        return None, "Set one unambiguous repository assignment for this story."
    repo = next(iter(names))
    origins = {"https://github.com/" + repo, "https://github.com/" + repo + ".git"}
    allowed = any(row.get("name", "").lower() == repo and row.get("writable") is True
                  and (row.get("url") or "").lower() in origins
                  for row in brief.get("repositories", []))
    if not allowed or not REPOSITORY.fullmatch(repo):
        return None, "The story repository is unavailable for writes in this workflow."
    route = routes.get(repo)
    if not route:
        return None, f"Configure a Development route for {repo} or hand this run to an eligible host."
    binding = config.get("git_pairings", {}).get(repo)
    if binding:
        route = {**route, "git_pairing": binding}
        try:
            paired_git.match_binding(route, binding, brief)
        except paired_git.Unavailable as error:
            return route, str(error)
    return route, None


# Run through command/exec inside the exact worker permissions. Print only an exit code.
GIT_PROBE = r"""
set -eu
root=$(pwd -P)
top=$(git rev-parse --show-toplevel) || exit 2
test "$(cd "$top" && pwd -P)" = "$root" || exit 2
common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 2
gitdir=$(cd "$common" && pwd -P) || exit 2
case "$gitdir/" in "$root/"*) ;; *) exit 2 ;; esac
origin=$(git remote get-url origin | tr '[:upper:]' '[:lower:]') || exit 2
case "$origin" in "https://github.com/$1"|"https://github.com/$1.git") ;; *) exit 2 ;; esac
# A fetch of a cached head may never write the object store. Check its real path, too.
for dir in "$root" "$gitdir" "$gitdir/objects" "$gitdir/objects/pack" "$gitdir/refs/heads" "$gitdir/refs/remotes/origin" "$gitdir/worktrees"; do
    # Origin refs and worktree administration may legitimately be created for the first time below.
    test -d "$dir" || continue
    physical=$(cd "$dir" && pwd -P) || exit 3
    case "$physical/" in "$root/"*) ;; *) exit 2 ;; esac
    tmp=$(mktemp "$dir/.codebook-preflight-XXXXXXXX") || exit 3
    rm -f "$tmp" || exit 3
done
scratch=$(mktemp -d "$root/.codebook-preflight-XXXXXXXX") || exit 3
name=${scratch##*/}
name=${name#.}
branch="codebook/$name"
tracked="refs/remotes/origin/$name"
localref="refs/heads/$branch"
if git show-ref --verify --quiet "$tracked" || git show-ref --verify --quiet "$localref"; then
    rmdir "$scratch"
    exit 3
fi
commit=
cleanup() {
    result=$?
    trap - EXIT
    if test -e "$scratch/tree/.git"; then
        git -c core.hooksPath=/dev/null worktree remove --force "$scratch/tree" >/dev/null 2>&1 || result=3
    fi
    # Remove only the private refs at the object fetched by this invocation.
    if test -n "$commit"; then
        if git show-ref --verify --quiet "$localref"; then
            git update-ref -d "$localref" "$commit" >/dev/null 2>&1 || result=3
        fi
        git update-ref -d "$tracked" "$commit" >/dev/null 2>&1 || result=3
    fi
    rmdir "$scratch" || result=3
    exit "$result"
}
trap cleanup EXIT
trap 'exit 3' HUP INT TERM
# Perform the worker's actual fetch. The isolated clone retains the fetched state for its worker.
if test "$2" = paired; then
    commit=$(git rev-parse --verify 'HEAD^{commit}') || exit 3
elif ! diagnostic=$(git fetch --no-tags --no-recurse-submodules origin 2>&1); then
    case "$diagnostic" in
        *"FETCH_HEAD"*|*"cannot lock ref"*|*"unable to update"*|*"repository database"*|*"insufficient permission"*|*"unable to create temporary file"*|*"unable to write"*|*"cannot store"*) exit 3 ;;
        *uthenticat*|*"could not read Username"*|*"could not read Password"*|*"terminal prompts disabled"*|*eychain*|*securityd*|*"epository not found"*|*"ccess denied"*) exit 5 ;;
        *) exit 4 ;;
    esac
else
    commit=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || exit 3
fi
# Even an up-to-date origin must permit a tracking-ref write for new work.
git update-ref "$tracked" "$commit" "" || exit 3
# Use Git's own branch, reflog, and worktree registration paths for the factory branch namespace.
git -c core.hooksPath=/dev/null worktree add --quiet --no-checkout -b "$branch" "$scratch/tree" "$commit" || exit 3
"""


def preflight(host, route, scope=None):
    # Both the command sandbox and subsequent worker use this process's approved overlay and named permissions.
    def enabled(method, params, field, identifier, flag):
        while True:
            page = host.call(method, params)
            if any(row.get(field) == identifier and row.get(flag) is True for row in page["data"]):
                return True
            cursor = page.get("nextCursor")
            if not cursor or cursor == params.get("cursor"):
                return False
            params = {**params, "cursor": cursor}
    if not enabled("experimentalFeature/list", {}, "name", "network_proxy", "enabled"):
        raise Hold("Codex has not enabled the network proxy for this Development host.")
    if not enabled("permissionProfile/list", {"cwd": route["checkout"]}, "id", route["permissions"], "allowed"):
        raise Hold("Codex does not allow the selected Development permissions profile.")
    binding = route.get("git_pairing")
    if binding:
        protected = [Path(__file__).resolve().parent, Path(scope["state_directory"]).resolve()]
        writable = [Path(scope["cwd"]).resolve(), *[Path(r["checkout"]).resolve() for r in scope["development_routes"].values()]]
        if any(p == root or root in p.parents for root in writable for p in protected):
            raise Hold("Run the installed supervisor and keep its state outside the worker workspace and configured clones.")
        public = paired_git.device("public", scope, route)
        paired_git.require(paired_git.public_fields(route, public) == binding, "The operator's protected clone key differs.")
        paired_git.isolated_key(host, scope, route)
        host.paired_isolated = True
    result = host.call("command/exec", {"command": ["/bin/sh", "-c", GIT_PROBE, "codebook-git-probe", route["repository"],
                                                   "paired" if binding else "direct"],
                      "cwd": route["checkout"], "permissionProfile": route["permissions"], "timeoutMs": 15000,
                      "outputBytesCap": 256, "env": {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}})
    code = result.get("exitCode")
    if code != 0:
        reasons = {2: "The isolated clone or its HTTPS origin does not match the assigned repository.",
                   3: "The selected profile cannot write the isolated checkout, Git object store, FETCH_HEAD, branch, remote-tracking ref or worktree metadata.",
                   4: "The selected profile cannot reach the assigned HTTPS Git remote.",
                   5: "Git authentication or private repository access failed. Use an approved repository-scoped credential or another eligible host."}
        raise Hold(reasons.get(code, "The sandboxed Development capability check did not pass."))


def eligible(host, config, adopted, only=None, statuses=None, access=None):
    scope = {k: config[k] for k in ("factory", "workflow")}
    if statuses is None:
        statuses = {}
    allowed = set(config["stories"]) | set(adopted)
    if not allowed and not config["manage_ready"]:
        return [], "Observing only; assign a story or opt into manager-ready drawer work."
    brief = host.tool("manager_brief", **scope)
    if (brief.get("factory", {}).get("factory") != scope["factory"]
            or brief.get("workflow", {}).get("workflow") != scope["workflow"]
            or brief.get("you", {}).get("may_run_here") is not True):
        return [], "The signed-in person cannot run this workflow locally."
    snapshot = host.tool("factory_operations", factory=scope["factory"])["snapshot"]
    control = snapshot["control"]
    if control["paused"] or control.get("autonomy") == "observe":
        return [], "The factory is paused or its autonomy is set to Observe."
    if (snapshot.get("status") or {}).get("word") == "on_hold_budget":
        return [], "The factory token budget has been reached."
    tiles = snapshot.get("tiles") or {}
    if tiles.get("token_budget") is not None and tiles.get("tokens_today", 0) >= tiles["token_budget"]:
        return [], "The factory token budget has been reached."
    if tiles.get("max_concurrent_runs") is not None and tiles.get("working", 0) >= tiles["max_concurrent_runs"]:
        return [], "The factory concurrency limit has been reached."
    capacity = brief["you"].get("on_my_computer") or {}
    if capacity.get("limit") is not None and capacity.get("working_now", 0) >= capacity["limit"]:
        return [], "The local worker capacity is full."
    if access is not None:
        access["may_work"] = True
    candidates = []
    for row in host.tool("list_my_work", factory=scope["factory"])["work"]:
        followed = row.get("story") in allowed or row.get("reference") in allowed
        if not followed and not config["manage_ready"]:
            continue
        if (row.get("where") != "here" or row.get("claimed") is not False
                or row.get("factory", {}).get("factory") != scope["factory"]
                or row.get("workflow", {}).get("workflow") != scope["workflow"]):
            continue
        run = row.get("run")
        if type(run) is int and run > 0:
            candidates.append((validated(row["story"]), run, None, None))
    name = brief["workflow"]["name"]
    page = brief.get("backlog") or {}
    offset = 0
    while True:
        for row in page.get("stories", []):
            proposal = row.get("proposal") or {}
            if (config["manage_ready"] and row.get("ready") is True and row.get("workflow") == name
                    and isinstance(proposal.get("proposal"), str) and IDENT.fullmatch(proposal["proposal"])
                    and type(proposal.get("item")) is int and proposal["item"] > 0):
                action = 'confirm_stories { proposal: "%s", stories: [%d], decided_by: "manager" }' % (proposal["proposal"], proposal["item"])
                if row.get("start_with") == action:
                    candidates.append((validated(row["story"]), 0, proposal["proposal"], proposal["item"]))
        following = page.get("next_offset")
        if following is None:
            break
        if type(following) is not int or following <= offset:
            raise Hold("CodeBook returned a repeated readiness page.")
        offset = following
        page = host.tool("manager_brief", **scope, backlog_offset=offset)["backlog"]
    ready = []
    for story, run, proposal, item in dict.fromkeys(candidates):
        if only and (story, proposal, item) != (only["story"], only["proposal"], only["item"]):
            continue
        status = scoped_story_status(host, scope, story, statuses)
        if status is None or not hosted_here(status):
            continue
        waiting = status.get("waiting") or {}
        if run:
            current = status.get("run") or {}
            if (status.get("finished") or status.get("in_backlog") or status.get("question")
                    or current.get("run") != run or current.get("finished_at")
                    or waiting.get("on") != "runner" or waiting.get("run") != run or waiting.get("on_you") is not True
                    or waiting.get("claimed") is not False):
                continue
        elif not status.get("in_backlog") or status.get("run"):
            continue
        key = f"{story}:{run}" if run else f"{story}:{proposal}:{item}"
        candidate = {"key": key, "story": story, "run": run, "proposal": proposal, "item": item}
        if run:
            station = status.get("station") or {}
            worker = station.get("worker") or {}
            if worker.get("type") != "agent":
                continue
            for field, label in (("station", station.get("name")), ("agent", worker.get("name"))):
                candidate[field] = label if isinstance(label, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9 ._-]{0,47}", label) else field
            uri = urlsplit(status.get("url") or "")
            board = parse_qs(uri.query).get("board", [""])[0]
            if (uri.scheme == "https" and uri.netloc == "app.codebook.work"
                    and re.fullmatch(r"/workspace/[A-Za-z0-9_-]+/factory/"+re.escape(config["factory"]), uri.path)
                    and parse_qs(uri.query).get("card") == [story] and board.isascii() and board.isdecimal()):
                candidate["url"] = "https://app.codebook.work" + uri.path + "?card=" + story + "&board=" + board
        if candidate.get("station") == "Development":
            route, problem = development_route(config, brief, status, story)
            candidate.update(development=True, route=route, capability_problem=problem)
        ready.append(candidate)
    return ready, "Waiting for fresh eligible local work in this scope."


def marker(key):
    return "[CodeBook local wake " + key + "]"


def prompt(scope, item):
    route = item.get("route") or {}
    paired = bool(route.get("git_pairing"))
    claim = "factory_git_claim" if paired else CLAIM_TOOL
    routing = ""
    if paired:
        routing = ("The supervisor has verified the paired clone for " + route["repository"] +
                   ". After claiming, create your per-run worktree on a local base inside this clone, declare its exact branch and path "
                   "to CodeBook, then call factory_git_fetch. Use the fetched origin refs for your base. "
                   "Publish only the declared feature branch with factory_git_push. These tools take no arguments. ")
    elif route:
        routing = ("Your current directory is the isolated clone for " + route["repository"] +
                   ". The supervisor just ran git fetch --no-tags --no-recurse-submodules origin in this profile. Use the fetched refs, "
                   "create a per-run worktree within this clone and leave its checked-out branch in place. ")
    return (f"{marker(item['key'])}\nYou are the independently assigned {item['agent']} station worker at "
            f"{item['station']}. Your only assignment is CodeBook run {item['run']} on story {item['story']}, "
            f"factory {scope['factory']}, workflow {scope['workflow']}. "
            + (f"Card: {item['url']}. " if item.get("url") else "") +
            routing + f"The local manager already validated station, ownership and readiness. First call {claim} "
            "for this run. If refused, leave it to its holder and finish. Follow the returned frozen brief, agent "
            "instructions and exact fence, heartbeating during work. Start with the server PR and proof records and "
            "git worktree list --porcelain to find the exact local checkout. Claiming needs no remote git operation, "
            "repo search, work-order history or test. Reuse matching verified receipts, investigate only actual gaps, "
            "and finish using complete_work with your valid fence. Respect the approved scope, proof and human gates. "
            "Do not run another station or manager, self-QA, merge or change settings.")


def exact_confirmation(result, target):
    created = result.get("created")
    if (result.get("decided_by") != "manager" or (result.get("proposal") or {}).get("proposal") != target["proposal"]
            or not isinstance(created, list) or len(created) != 1):
        return False
    row = created[0]
    return (isinstance(row, dict) and row.get("story") == target["story"] and row.get("item") == target["item"]
            and row.get("run_location") == "here" and row.get("from_backlog") is True and row.get("moved_by_hand") is False)


def run_holds(state):
    # Older checkpoints attached their holds to individual lease generations.
    if "run_holds" not in state:
        held = {}
        for key, entry in state.get("notices", {}).items():
            since = entry.get("operator_hold")
            if since:
                run = key.partition(":expiry:")[0]
                held[run] = max(since, held.get(run, 0))
        state["run_holds"] = held
    return state["run_holds"]


def station_run_ended(run):
    finished_at = run.get("finished_at")
    return (isinstance(finished_at, str) and bool(finished_at)
            and run.get("state") in ("passed", "failed", "blocked", "cancelled", "superseded", "sent_back"))


def operator_hold_ended(status, held):
    current = status.get("run")
    if current is not None:
        if not isinstance(current, dict) or type(current.get("run")) is not int:
            return False
        if current["run"] == held:
            return station_run_ended(current)
    waiting = status.get("waiting")
    if waiting is not None and (not isinstance(waiting, dict) or waiting.get("run") == held):
        return False
    if current is not None and current["run"] > held:
        return True
    if current is None and waiting is None and status.get("finished") in ("done", "dropped"):
        return True
    # The current station can have no run while a previous station records the exact run's end.
    stations = status.get("stations")
    if not isinstance(stations, list):
        return False
    exact = [run for run in stations if isinstance(run, dict) and type(run.get("run")) is int and run["run"] == held]
    return bool(exact) and all(station_run_ended(run) for run in exact)


class Manager:
    def __init__(self, folder, config, host):
        self.folder, self.config, self.host = folder, config, host
        self.state = read(folder / "status.json", {"cursor": 0, "notices": {}})
        self.state.setdefault("adopted", [])
        self.state.setdefault("lease_events", {})
        self.state.setdefault("workers", {})
        if "milestone_orders" not in self.state:
            # A pre-upgrade confirmed receipt establishes ownership; an unacknowledged proposal does not.
            self.state["milestone_orders"] = {}
            for key, entry in self.state["notices"].items():
                parts = key.split(":")
                if entry.get("confirmation") == "confirmed" and len(parts) == 3 and re.fullmatch(r"wo[1-9]\d*", parts[1]):
                    self.state["milestone_orders"].setdefault(parts[1], milestone_routes.journal())
        self.holds = run_holds(self.state)
        self.state["interaction_required"] = bool(self.holds or any(o["questions"] for o in self.state["milestone_orders"].values()))
        self.next_hold_read = 0
        self.last_held_story = ""
        self.state.update(pid=os.getpid(), phase="starting")
        self.last_scan = 0
        self.immediate = False
        self.worker = None
        self.development_hosts = {}
        self.usage_thread = None
        self.usage_results = queue.Queue()
        self.capability_holds = self.state.setdefault("development_holds", {})

    def record(self, reason):
        self.state["reason"] = reason
        save(self.folder / "status.json", self.state)

    @staticmethod
    def route_key(route):
        return (route["repository"], route["checkout"], route["permissions"], route.get("config_profile"), route.get("revision"),
                (route.get("git_pairing") or {}).get("fingerprint"))

    def host_for(self, route):
        if not route:
            return self.host
        key = self.route_key(route)
        process = getattr(self.development_hosts.get(key), "proc", None)
        if process and process.poll() is not None:
            del self.development_hosts[key]
        if key not in self.development_hosts:
            host = Host(route["checkout"], development=route)
            try:
                host.open(route["checkout"], observe=False)
            except Exception:
                host.close()
                raise
            self.development_hosts[key] = host
        return self.development_hosts[key]

    def worker_thread(self, previous=None, route=None):
        host = self.host_for(route)
        if previous and previous == self.worker:
            return previous
        params = {"cwd": route["checkout"] if route else self.config["cwd"],
                  "approvalPolicy": "on-request", "modelProvider": "openai"}
        if route:
            params.update(permissions=route["permissions"], runtimeWorkspaceRoots=[route["checkout"]])
        else:
            params["sandbox"] = "workspace-write"
        if previous:
            info = host.call("thread/resume", {**params, "threadId": previous})
        else:
            if not (route and route.get("git_pairing")):
                params["dynamicTools"] = [{"type": "function", "name": CLAIM_TOOL,
                    "description": "Claim the station assigned to this thread. Returns its frozen brief and lease.",
                    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]
            else:
                params["dynamicTools"] = [{"type": "function", "name": name, "description": desc,
                                           "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}
                                          for name, desc in paired_git.TOOLS.items()]
            # Compact only this station thread; global account and model selection remain the operator's.
            params["config"] = {"model_auto_compact_token_limit": 64000}
            info = host.call("thread/start", {**params, "allowProviderModelFallback": False})
        self.worker = self.state["thread"] = info["thread"]["id"]
        self.record("Connected to the independent station worker thread.")
        return self.worker

    def approvals(self):
        sessions = {**self.state["workers"]}
        active = self.state.get("active")
        if active:
            sessions[active["key"]] = active
        for host_key, host in [(None, self.host), *self.development_hosts.items()]:
            if not host or not host.approval_threads:
                continue
            assigned = {}
            for key, details in sessions.items():
                route = details.get("route") or (details.get("item") or {}).get("route")
                if (self.route_key(route) if route else None) == host_key:
                    assigned[key] = details.get("thread")
            for thread in host.approval_threads:
                for key, worker_thread in assigned.items():
                    if worker_thread == thread or (thread is None and len(assigned) == 1):
                        self.hold_for_operator(key)
            host.approval_threads.clear()

    def close_host(self):
        if self.host:
            try:
                # An interrupt or a failed final RPC can receive an approval before its reply.
                # Attribute the denial while this host and its worker-to-thread mapping still exist.
                self.approvals()
            finally:
                self.host.close()
                self.host = None
                for host in self.development_hosts.values():
                    host.close()
                self.development_hosts.clear()

    def queue_usage(self, worker, turn):
        # Keep recovery pointers in the existing private supervisor state. No transcript is copied.
        target = worker.get("item") or worker
        thread = worker["thread"]
        self.state.setdefault("usage_pending", {})[thread] = {
            "run": target["run"], "thread": thread, "turn": turn["id"],
            "fence": worker.get("native_fence") or (worker.get("git") or {}).get("fence") or native_usage.completion_fence(turn, target["run"]),
        }

    def deliver_usage(self, entry):
        # Separate read-only observer transport. Slow disk, OAuth or network cannot hold a station.
        host = None
        try:
            host = Host(self.config["cwd"])
            host.open(self.config["cwd"])
            thread = entry["thread"]
            if not entry.get("fence"):
                turns = host.call("thread/turns/list", {"threadId": thread, "itemsView": "full", "limit": 3})
                turn = next((t for t in turns["data"] if t["id"] == entry["turn"]), {})
                entry["fence"] = native_usage.completion_fence(turn, entry["run"])
            if not entry.get("usage"):
                info = host.call("thread/read", {"threadId": thread, "includeTurns": False})["thread"]
                if info.get("id") == thread and not info.get("forkedFromId") and info.get("path"):
                    entry["usage"] = native_usage.turn_usage(info["path"], thread, entry["turn"])
            if not entry.get("fence") or entry.get("usage") is None:
                raise Hold("Final native usage or claim receipt unavailable.")
            result = host.tool("report_native_usage", run=entry["run"], fence=entry["fence"], usage=entry["usage"])
            if result.get("recorded") is not True or result.get("run") != entry["run"]:
                raise Hold("Native usage delivery is awaiting a receipt.")
            entry["delivered"] = True
        except (Hold, OSError, KeyError, TypeError, ValueError):
            attempts = entry["attempts"] = entry.get("attempts", 0) + 1
            entry["next"] = int(time.time()) + min(3600, 30 * 2 ** min(attempts, 7))
            if attempts >= 8:
                entry["unavailable"] = True
                entry["reason"] = "Missing native measurement or claim" if not entry.get("usage") or not entry.get("fence") else "No server receipt after eight attempts"
        finally:
            self.usage_results.put(entry)
            if host:
                host.close()

    def report_usage(self):
        pending = self.state.setdefault("usage_pending", {})
        # The worker queues exactly one answer before it exits. Consume it before
        # selecting a retry, even if it finishes between supervisor ticks.
        if self.usage_thread and self.usage_thread.is_alive():
            return
        try:
            answered = self.usage_results.get_nowait()
        except queue.Empty:
            pass
        else:
            existing = pending.get(answered["thread"])
            if existing and existing["turn"] == answered["turn"] and answered.get("delivered"):
                # Removing the pending receipt and charging it are persisted together.
                # A duplicate reply or a restart cannot charge the same turn twice.
                if self.config.get("local_token_budget") is not None:
                    self.state["local_tokens_used"] = self.state.get("local_tokens_used", 0) + answered["usage"]["total_tokens"]
                del pending[answered["thread"]]
            elif existing and existing["turn"] == answered["turn"]:
                pending[answered["thread"]] = answered
        for entry in pending.values():
            if int(time.time()) >= entry.get("next", 0) and not entry.get("unavailable"):
                self.usage_thread = threading.Thread(target=self.deliver_usage, args=(dict(entry),), daemon=True)
                self.usage_thread.start()
                break

    def observe_workers(self):
        for key, worker in list(self.state["workers"].items()):
            try:
                page = self.host_for(worker.get("route")).call("thread/turns/list", {"threadId": worker["thread"], "limit": 1})
            except Refused:
                continue
            except (OSError, Hold):
                if worker.get("route"):
                    continue
                raise
            ended = next((t for t in page["data"] if t["id"] == worker["turn"] and t["status"] != "inProgress"), None)
            if ended:
                self.queue_usage(worker, ended)
                self.approvals()
                del self.state["workers"][key]

    def local_budget_hold(self):
        limit = self.config.get("local_token_budget")
        if limit is None:
            return None
        if self.state.get("usage_pending"):
            return "Waiting for a verified native usage receipt before spending more of the local token budget."
        if self.state.get("local_tokens_used", 0) >= limit:
            return "The local workflow token budget has been reached."
        if self.state.get("workers"):
            return "A local station is still spending against this workflow's token budget."
        return None

    def reconcile(self):
        active = self.state.get("active")
        if not active:
            return False
        route = active["item"].get("route")
        thread = self.worker_thread(active.get("thread") or self.state.get("thread"), route)
        page = self.host_for(route).call("thread/turns/list", {"threadId": thread, "limit": 3, "itemsView": "full"})
        for turn in page["data"]:
            found = turn["id"] == active.get("turn") or any(
                i.get("type") == "userMessage" and any(t.get("type") == "text" and
                t.get("text", "").startswith(marker(active["key"])+"\n") for t in i.get("content", []))
                for i in turn.get("items", []))
            if not found:
                continue
            active["turn"] = turn["id"]
            active["result"] = turn["status"]
            target = active["item"]
            status = self.host.tool("story_status", factory=self.config["factory"], workflow=self.config["workflow"],
                                    story=target["story"], limit=1)
            waiting = status.get("waiting") or {}
            current = status.get("run") or {}
            self.approvals()
            if turn["status"] == "inProgress":
                lease = waiting.get("lease") or {}
                if (target["run"] and current.get("run") == target["run"] and waiting.get("claimed") is True
                        and type(lease.get("fence")) is int and lease["fence"] > 0 and lease.get("expired") is False):
                    self.state["workers"][active["key"]] = {"thread": thread, "turn": turn["id"], "run": target["run"],
                            "story": target["story"], "route": target.get("route"), "git": active.get("git", {}), "native_fence": active.get("native_fence")}
                    self.state["notices"][active["key"]]["done"] = True
                    self.state.pop("active")
                    self.last_scan = 0
                    self.record("The station run has a live fence. The independent worker is continuing.")
                    return False
                self.state["phase"] = "working"
                self.record("Waiting for the independently dispatched worker's live station claim.")
                return True
            if target.get("run"):
                self.queue_usage(active, turn)
            # A pre-upgrade backlog turn cannot establish ownership from a model transcript.
            progressed = (current.get("run") != target["run"] or waiting.get("claimed") is True
                          or current.get("status") in {"completed", "blocked", "failed", "cancelled"}
                          or status.get("finished") or status.get("question"))
            self.state.pop("active")
            if progressed:
                self.state["notices"][active["key"]]["done"] = True
            self.last_scan = 0
            self.record("Server confirmed a transition or hold." if progressed else "No station transition; bounded retry pending.")
            return False
        if active.get("turn"):
            raise Hold("An accepted turn is temporarily unavailable. Waiting for its recorded outcome.")
        # May have lost the acknowledgement. Give history time to materialize before rechecking eligibility.
        if time.time() - active["at"] < 60:
            return True
        if self.config.get("local_token_budget") is not None:
            self.record("Waiting for the unacknowledged turn before spending more local tokens.")
            return True
        self.state.pop("active")
        self.last_scan = 0
        self.record("The unacknowledged wake will be checked against current eligibility.")
        return False

    def hold_for_operator(self, key):
        self.holds[key.partition(":expiry:")[0]] = time.time_ns()
        self.state["interaction_required"] = True
        self.record("An operator decision is required for " + key + "; retry that story explicitly after resolution.")

    def reconcile_operator_holds(self, scope, statuses):
        """Retire old host decisions only after CodeBook confirms the run has ended."""
        now = time.monotonic()
        if not self.holds or now < self.next_hold_read:
            return
        self.next_hold_read = now + INTERVAL
        by_story = {}
        for key in self.holds:
            story, _, number = key.partition(":")
            if STORY.fullmatch(story) and re.fullmatch(r"[1-9][0-9]{0,18}", number):
                by_story.setdefault(story, []).append((key, int(number)))
        # Rotate a small batch. A live hold or an unavailable story cannot starve the others.
        stories = sorted(by_story, key=lambda story: (story <= self.last_held_story, story))
        for story in stories[:4]:
            self.last_held_story = story
            status = scoped_story_status(self.host, scope, story, statuses)
            if status is None:
                continue
            for key, held in by_story[story]:
                if operator_hold_ended(status, held):
                    del self.holds[key]
        self.state["interaction_required"] = bool(self.holds or any(o["questions"] for o in self.state["milestone_orders"].values()))

    def confirm(self, item, entry):
        """Caller holds the control fence; record intent before the single allowed MCP mutation."""
        if not self.config["manage_ready"]:
            return
        fresh, _ = eligible(self.host, self.config, self.state["adopted"], only=item)
        if not any(row["key"] == item["key"] and not row["run"] for row in fresh):
            return
        entry["confirmation"] = "awaiting_receipt"
        self.record("Submitting one manager-authorized local backlog confirmation for " + item["key"] + ".")
        # A lost reply or crash retains the intent. A later snapshot alone cannot establish our ownership.
        try:
            reply = self.host.tool("confirm_stories", factory=self.config["factory"], proposal=item["proposal"],
                                   stories=[item["item"]], decided_by="manager", run_location="here", start=True)
        except ProposalPaused as pause:
            del entry["confirmation"]
            self.record(str(pause))
            return
        if exact_confirmation(reply, item):
            entry["confirmation"] = "confirmed"
            self.state["milestone_orders"].setdefault(item["proposal"], milestone_routes.journal())
            if item["story"] not in self.state["adopted"]:
                self.state["adopted"].append(item["story"])
        else:
            entry["confirmation"] = "no_matching_receipt"
        entry["done"] = True
        self.last_scan = 0
        self.immediate = True
        self.record("Received " + entry["confirmation"] + " for " + item["key"] + ".")

    def milestone_snapshot(self, order):
        factory = self.config["factory"]
        view = self.host.tool("work_orders", factory=factory, order=order)
        if view.get("order") != order or not isinstance(view.get("milestones"), list):
            raise Hold("The owned work order could not be reconciled.")
        needs = self.host.tool("needs_you", factory=factory)
        if not all(isinstance(needs.get(k), list) for k in ("for_person", "for_manager")):
            raise Hold("Milestone attention is unavailable.")
        return view, milestone_routes.decisions(view, needs, factory, order)

    def reconcile_milestones(self, may_work):
        orders = self.state["milestone_orders"]
        candidates = []
        if not orders:
            return candidates
        factory = self.config["factory"]
        order = min(orders, key=lambda o: (o <= self.state.get("last_milestone_order", ""), o))
        self.state["last_milestone_order"] = order
        ledger = orders[order]
        try:
            view, actions = self.milestone_snapshot(order)
            milestone_routes.recover(view, ledger)
            targets = ledger.setdefault("recovery", {})
            for key, record in targets.items():
                record["current"] = key in actions
                if record["state"] != "pending":
                    continue
                target = record["target"]
                if target["kind"] == "proof":
                    try:
                        receipt = self.host.tool("proof_result", factory=factory, story=target["member_story"], proof=target["proof"])
                    except (Hold, OSError):
                        continue
                    outcome = milestone_routes.proof_outcome(target, receipt)
                else:
                    fix = milestone_routes.fix_for(view, record["check"], target)
                    outcome = "completed" if fix and fix.get("state") == "finished" else None
                if outcome:
                    record["state"] = outcome
            ledger["prerequisites"] = {key: route["reason"] for key, (route, _) in actions.items() if route["action"] == "hold"}
            ledger.pop("read_pending", None)
            ledger["questions"] = {k: v for k, v in ledger["questions"].items() if k in actions}
            for key, (route, policy) in actions.items():
                question = f"{factory} / {order}, check #{route['check']}: {route['reason']} What would you like to do with this check?"
                if key in ledger["seen"] and route["action"] == "review":
                    ledger["questions"][key] = question
                if route["action"] == "hold" or key in ledger["seen"] or key in ledger["retries"]:
                    continue
                if route["owner"] == "manager" and not (may_work and self.config["manage_ready"]):
                    continue
                with locked(self.folder / "control.lock"):
                    if read(self.folder / "control.json", {}) != self.config:
                        return candidates
                    if self.milestone_snapshot(order)[1].get(key) != (route, policy):
                        continue
                    check = route["check"]
                    if route["action"] == "repair":
                        target = route["recovery"]
                        if target["kind"] == "proof":
                            if key not in targets:
                                note = (f"Run /factory prove {target['proof']} with the signed-in local Claude proof plugin."
                                        if target["executor"] == "here" else f"Waiting for registered executor proof {target['proof']}.")
                                targets[key] = dict(target=target, check=check, state="pending", current=True, note=note)
                                self.record(note)
                        elif milestone_routes.fix_for(view, check, target):
                            available, _ = eligible(self.host, self.config, self.state["adopted"])
                            for candidate in available:
                                if candidate["run"] and candidate["story"] == target["story"]:
                                    candidate["milestone_recovery"] = {"order": order, "key": key, "route": route, "policy": policy}
                                    candidates.append(candidate)
                                    targets[key] = dict(target=target, check=check, state="pending", current=True, run=candidate["run"])
                        continue
                    if route["action"] == "review":
                        ledger["seen"].append(key)
                        ledger["questions"][key] = question
                        self.record("An operator question is available for " + key + ".")
                    else:
                        record = ledger["retries"][key] = dict(requested=check, state="pending", reason=route["reason"])
                        self.record("Awaiting the server receipt for " + key + ".")
                        reply = self.host.tool("decide_milestone_check", factory=factory, order=order, check=check,
                                               authority="manager", decision="retry", **({"expected_policy": policy} if policy else {}))
                        if milestone_routes.confirmed(reply, route):
                            record.update(state="confirmed", actor="manager", check=reply["check"]["id"])
            if (view.get("work_order") or {}).get("status") in ("done", "cancelled") and not ledger["retries"]:
                del orders[order]
        except (Hold, OSError):
            ledger["read_pending"] = True
        self.state["interaction_required"] = bool(self.holds or any(o["questions"] for o in orders.values()))
        return candidates

    def development_ready(self, item, base):
        route = item.get("route")
        retry = self.config.get("retries", {}).get(item["story"], 0)
        signature = [route.get("revision") if route else None, retry, item.get("capability_problem")]
        old = self.capability_holds.get(base, {})
        if old.get("signature") == signature:
            return False
        try:
            if item.get("capability_problem"):
                raise Hold(item["capability_problem"])
            preflight(self.host_for(route), route, {**self.config, "state_directory": str(self.folder)})
        except (Hold, OSError, paired_git.Unavailable) as error:
            message = str(error) if isinstance(error, (Hold, paired_git.Unavailable)) else "The configured isolated checkout or local host is unavailable."
            self.capability_holds[base] = {"signature": signature, "reason": message}
            self.record(f"Development hold {base}: {message}")
            return False
        self.capability_holds.pop(base, None)
        return True

    def service_git(self):
        for host_key, host in [(None, self.host), *self.development_hosts.items()]:
            pending = getattr(host, "git_requests", None)
            for _ in range(8):
                if not pending:
                    break
                try:
                    request = pending.get_nowait()
                except queue.Empty:
                    break
                try:
                    receipt = self.worker_git(host_key, host, request.get("params") or {})
                    success = True
                except (paired_git.Unavailable, Hold, ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
                    success = False
                    receipt = {"outcome": "held", "reason": str(error) if isinstance(error, (paired_git.Unavailable, Hold))
                               else "The local Git or device operation could not be verified."}
                host.send({"id": request["id"], "result": {"success": success,
                           "contentItems": [{"type": "inputText", "text": json.dumps(receipt)}]}})

    def worker_git(self, host_key, host, params):
        verify = paired_git.require
        thread, turn = params.get("threadId"), params.get("turnId")
        name, call = params.get("tool"), params.get("callId")
        verify((name == CLAIM_TOOL or name in paired_git.TOOLS) and params.get("arguments") == {} and not params.get("namespace")
               and isinstance(call, str) and len(call) <= 160 and bool(call) and thread and turn,
               "Invalid native station operation.")
        sessions = dict(self.state["workers"])
        active = self.state.get("active")
        if active:
            sessions[active["key"]] = active
        matches = [(k, row) for k, row in sessions.items() if row["thread"] == thread and row.get("turn") == turn]
        verify(len(matches) == 1, "This request has no current assigned worker.")
        key, worker = matches[0]
        item = worker.get("item") or worker
        route, story, run = item.get("route"), item["story"], item["run"]
        if name == CLAIM_TOOL:
            verify((self.route_key(route) if route else None) == host_key and not (route or {}).get("git_pairing"),
                   "This claim does not belong to this worker host.")
            verify(read(self.folder/"control.json", {}) == self.config and self.config.get("running"),
                   "The operator changed or stopped this worker.")
            receipt = host.tool_in(thread, "claim_work", run=run)
            fence = (receipt.get("lease") or {}).get("fence")
            verify(receipt.get("run") == run and receipt.get("where") == "here" and type(fence) is int and fence > 0,
                   "CodeBook did not confirm the assigned local claim.")
            worker["native_fence"] = fence
            self.record("Recorded this native thread's station claim.")
            return receipt
        binding = route.get("git_pairing")
        verify(binding and self.route_key(route) == host_key, "This worker has no paired Development route.")
        scope = {field: self.config[field] for field in ("factory", "workflow")}
        assignment = {**scope, "run": run, "story": story}
        def live():
            # Re-read local revocations even during a multi-request smart HTTP exchange.
            control = read(self.folder/"control.json", {})
            verify(control.get("running") and control.get("git_pairings", {}).get(route["repository"]) == binding
                   and control.get("development_routes", {}).get(route["repository"]) == {k:v for k,v in route.items() if k != "git_pairing"},
                   "The operator stopped or changed this Development route.")
            brief = self.host.tool("manager_brief", **scope)
            verify((brief.get("you") or {}).get("may_run_here") is True
                   and (brief.get("factory") or {}).get("factory") == scope["factory"]
                   and (brief.get("workflow") or {}).get("workflow") == scope["workflow"], "The workflow is no longer available locally.")
            paired_git.match_binding(route, binding, brief)
            status = self.host.tool("story_status", **scope, story=story, limit=1)
            verify((status.get("story") or {}).get("story") == story and (status.get("run") or {}).get("run") == run
                   and (status.get("factory") or {}).get("factory") == scope["factory"]
                   and (status.get("workflow") or {}).get("workflow") == scope["workflow"]
                   and (status.get("station") or {}).get("name") == "Development" and hosted_here(status),
                   "The assigned local Development station changed.")
            return status
        if not getattr(host, "paired_isolated", False):
            paired_git.isolated_key(host, {**scope, "state_directory": str(self.folder)}, route)
            host.paired_isolated = True
        status = live()
        journal = worker.setdefault("git", {})
        if name == "factory_git_claim":
            waiting = status.get("waiting") or {}
            verify(not journal.get("claim") and waiting.get("on") == "runner" and waiting.get("run") == run
                   and waiting.get("on_you") is True and waiting.get("claimed") is False,
                   "This station already has a holder or an unresolved claim attempt.")
            journal["claim"] = "awaiting_receipt"
            self.record("Submitting the assigned station worker's fenced claim.")
            receipt = host.tool_in(thread, "claim_work", run=run)
            fence = (receipt.get("lease") or {}).get("fence")
            verify(receipt.get("run") == run and receipt.get("story") == story and receipt.get("where") == "here"
                   and type(fence) is int and fence > 0 and (receipt.get("brief") or {}).get("station") == "Development",
                   "CodeBook did not return this station worker's exact claim receipt.")
            journal.update(claim="held", fence=fence)
            self.record("Recorded the paired worker's station fence.")
            return receipt
        verify(journal.get("claim") == "held", "Only the station worker that received the native claim may transfer Git.")
        fence = journal["fence"]
        bound = paired_git.declaration(status, assignment, fence, route)
        verify(not journal.get("calls", {}).get(call), "This native Git call was already accepted.")
        action = "fetch" if name == "factory_git_fetch" else "push"
        if action == "push" and journal.get("pending_push"):
            verify(self.config.get("retries", {}).get(story, 0) > journal["pending_push"],
                   "The prior push has an uncertain outcome. Inspect the branch and explicitly retry the story.")
        public = paired_git.device("public", scope, route)
        verify(paired_git.public_fields(route, public) == binding, "The protected device key differs from its enrollment.")
        def transfer(op, body):
            verify(paired_git.declaration(live(), assignment, fence, route) == bound, "The declared Git operation changed.")
            if op == "push_pack":
                journal["pending_push"] = time.time_ns()
                self.record("Awaiting the upstream's exact assigned-branch update receipt.")
            return paired_git.exchange(scope, route, binding, bound, op, body,
                                       lambda **args: host.tool_in(thread, "prepare_run_here_git", **args), public)
        try:
            receipt = paired_git.perform(action, bound, paired_git.git_runner(route, bound, development_options(route)), transfer)
        except Exception:
            if action == "push" and journal.get("pending_push"):
                self.hold_for_operator(key)
            raise
        if action == "push":
            journal.pop("pending_push", None)
        journal["calls"] = dict(list({**journal.get("calls", {}), call: True}.items())[-32:])
        self.state["last_git_receipt"] = receipt
        self.record("Verified the paired station worker's Git receipt.")
        return receipt

    def tick(self):
        if not self.config["running"]:
            return
        scope = {k: self.config[k] for k in ("factory", "workflow")}
        previous = self.state["cursor"]
        cursor, events = read_events(self.host, scope, previous)
        # Expiry gives an already delivered local station a new opportunity on its SAME job ID.
        # Keep the event generation with the cursor and only act after re-reading the current unclaimed state.
        for event in events:
            card = event.get("card") or {}
            story, run, event_id = card.get("key"), event.get("run"), event.get("id")
            if (event.get("kind") != "run.claim_expired" or not isinstance(story, str)
                    or not IDENT.fullmatch(story) or type(run) is not int or run < 1
                    or type(event_id) is not int or not previous < event_id <= cursor):
                continue
            base = f"{story}:{run}"
            if base in self.state["notices"] or base in self.state["lease_events"]:
                self.state["lease_events"][base] = event_id
        self.state["last_read"] = int(time.time())
        changed = self.state["cursor"] != cursor
        self.state["cursor"] = cursor
        self.approvals()
        self.service_git()
        self.observe_workers()
        self.report_usage()
        statuses = {}
        self.reconcile_operator_holds(scope, statuses)
        if self.reconcile():
            self.record(self.state.get("reason", "Waiting for the manager receipt."))
            return
        budget_hold = self.local_budget_hold()
        if budget_hold:
            self.state["phase"] = "held"
            self.record(budget_hold)
            return
        self.state["phase"] = "observing"
        if not changed and self.last_scan and time.monotonic() - self.last_scan < RECONCILE:
            self.record(self.state.get("reason", "Waiting for a CodeBook event."))
            return
        self.last_scan = time.monotonic()
        access = {}
        ready, reason = eligible(self.host, self.config, self.state["adopted"], statuses=statuses, access=access)
        recovery = self.reconcile_milestones(access.get("may_work", False))
        selected = {item["key"] for item in recovery}
        ready = recovery + [item for item in ready if item["key"] not in selected]
        for item in ready:
            expired_at = self.state["lease_events"].get(item["key"])
            if item["run"] and expired_at:
                item["key"] += f":expiry:{expired_at}"
        keys = {item["key"] for item in ready}
        notices = self.state["notices"]
        # Keep all currently eligible keys. Discard superseded terminal identities to bound storage.
        for key in list(notices):
            if key not in keys and len(notices) > 128:
                del notices[key]
        for base in list(self.state["lease_events"]):
            if not any(key == base or key.startswith(base + ":expiry:") for key in notices):
                del self.state["lease_events"][base]
        for item in ready:
            entry = notices.setdefault(item["key"], {"attempts": 0})
            if entry.get("done") or entry.get("confirmation"):
                continue
            held_run = item["key"].partition(":expiry:")[0]
            if held_run in self.holds:
                retry = self.config.get("retries", {}).get(item["story"], 0)
                if retry <= self.holds[held_run]:
                    reason = "Operator decision pending for " + item["key"] + "; other eligible work can continue."
                    continue
                del self.holds[held_run]
                entry.update(attempts=0, next=0)
                self.state["interaction_required"] = bool(self.holds or any(o["questions"] for o in self.state["milestone_orders"].values()))
            if entry["attempts"] >= MAX_ATTEMPTS:
                reason = "Wake retry limit reached for " + item["key"] + "; inspect the dedicated thread."
                continue
            if time.time() < entry.get("next", 0):
                reason = "Waiting for the bounded retry of " + item["key"] + "."
                continue
            with locked(self.folder / "control.lock"):
                current = read(self.folder / "control.json", {})
                if current != self.config or not current.get("running"):
                    return
                if not item["run"]:
                    self.confirm(item, entry)
                    return
                recovery = item.get("milestone_recovery")
                if recovery:
                    view, actions = self.milestone_snapshot(recovery["order"])
                    route = recovery["route"]
                    active = actions.get(recovery["key"]) == (route, recovery["policy"])
                    if not active or not milestone_routes.fix_for(view, route["check"], route["recovery"]):
                        continue
                    eligible_now, _ = eligible(self.host, self.config, self.state["adopted"], only=item)
                    if not any(row["run"] == item["run"] for row in eligible_now):
                        continue
                if item.get("development") and not self.development_ready(item, held_run):
                    reason = f"Development hold {held_run}: " + self.capability_holds[held_run]["reason"]
                    continue
                # The attempt starts with worker creation. Persist it before either host RPC.
                entry["attempts"] += 1
                entry["next"] = int(time.time()) + min(900, 60 * 2**(entry["attempts"]-1))
                self.record("Starting an independent station thread for " + item["key"] + ".")
                try:
                    thread = self.worker_thread(route=item.get("route"))
                except Refused:
                    self.last_scan = 0
                    self.record("Codex refused worker startup for " + item["key"] + "; bounded retry pending.")
                    return
                self.state["active"] = {"key": item["key"], "item": item, "thread": thread, "at": int(time.time())}
                self.record("Submitting one scoped Codex manager wake.")
                try:
                    turn = self.host_for(item.get("route")).call("turn/start", {"threadId": thread, "input": [{"type": "text", "text": prompt(scope, item)}]})
                except Refused:
                    self.approvals()
                    self.state.pop("active")
                    self.last_scan = 0
                    self.record("Codex rejected the wake. Bounded retry pending; check account limits or access.")
                    return
                self.state["active"]["turn"] = turn["turn"]["id"]
                self.state["phase"] = "working"
                self.record("Dedicated manager turn accepted.")
            return
        uncertain = [k for k, n in notices.items() if n.get("confirmation") == "awaiting_receipt"]
        if uncertain:
            reason += " Confirmation receipt missing for " + ", ".join(uncertain[:3]) + "; a later station must independently qualify in this workflow."
        self.record(reason)


def supervise(folder):
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    manager = Manager(folder, read(folder / "control.json", {}), None)
    failures = 0
    try:
        while not stop.is_set():
            config = read(folder / "control.json", {})
            if not config.get("running"):
                break
            if config != manager.config:
                manager.config, manager.last_scan = config, 0
            try:
                if manager.host is None:
                    manager.host = Host(config["cwd"])
                    manager.host.open(config["cwd"])
                    manager.worker = None
                    manager.last_scan = 0
                manager.tick()
                manager.approvals()
                failures = 0
            except (OSError, Hold, ValueError, KeyError, TypeError) as error:
                manager.state["phase"] = "held"
                reason = str(error) if isinstance(error, Hold) else "Local host or CodeBook response unavailable (" + type(error).__name__ + ")."
                manager.record(reason)
                manager.close_host()
                failures = min(failures+1, 5)
            delay = 0 if manager.immediate and not failures else min(300, INTERVAL * 2**failures)
            manager.immediate = False
            # Recheck local controls promptly without polling CodeBook or a model.
            for _ in range(delay):
                if (stop.wait(1) or read(folder / "control.json", {}) != config
                        or any(not h.git_requests.empty() for h in manager.development_hosts.values())):
                    break
    finally:
        try:
            active = manager.state.get("active") or {}
            workers = list(manager.state["workers"].values()) + [active]
            for worker in workers:
                thread = worker.get("thread") or manager.state.get("thread")
                if manager.host and worker.get("turn") and thread:
                    route = worker.get("route") or (worker.get("item") or {}).get("route")
                    manager.host_for(route).call("turn/interrupt", {"threadId": thread, "turnId": worker["turn"]})
        except (OSError, Hold):
            pass
        finally:
            manager.close_host()
            manager.state["phase"] = "stopped"
            manager.record("The local manager is stopped.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "follow", "retry", "route", "git-enroll", "git-status"])
    parser.add_argument("--factory", required=True, type=validated)
    parser.add_argument("--workflow", required=True, type=validated)
    parser.add_argument("--cwd", type=Path)
    parser.add_argument("--repo", type=lambda value: validated(value, REPOSITORY).lower())
    parser.add_argument("--checkout", type=Path)
    parser.add_argument("--permissions", type=validated)
    parser.add_argument("--config-profile", type=validated)
    parser.add_argument("--manage-ready", action="store_true", help="also manage server-authorized local agent runs and ready drawer items in this workflow")
    parser.add_argument("--local-token-budget", type=int, help="stop new local turns once this workflow's measured gross tokens reach the limit")
    parser.add_argument("--story", action="append", type=lambda x: validated(x, STORY), default=[])
    args = parser.parse_args()
    if args.action == "route":
        if not (args.repo and args.checkout and args.permissions):
            parser.error("route requires --repo, --checkout and --permissions")
    elif args.action in ("git-enroll", "git-status"):
        if not args.repo or any((args.checkout, args.permissions, args.config_profile)):
            parser.error("git-enroll/git-status require --repo and an existing Development route")
    elif any((args.repo, args.checkout, args.permissions, args.config_profile)):
        parser.error("repository routes must be configured with the route command")
    if args.action in ("follow", "retry") and not args.story:
        parser.error("follow/retry requires --story")
    if args.story and args.action not in ("follow", "start", "retry", "route"):
        parser.error("--story is valid on start, follow, retry or route")
    if args.manage_ready and args.action != "start":
        parser.error("--manage-ready is an option for start")
    if args.local_token_budget is not None and (args.action != "start" or args.local_token_budget < 1):
        parser.error("--local-token-budget requires start and a positive number of tokens")
    if args.cwd and args.action != "start":
        parser.error("--cwd is only valid on start")
    os.umask(0o077)
    state_root = Path(os.environ.get("XDG_STATE_HOME") or Path.home()/".local/state")
    folder = state_root / "codebook/codex-manager" / args.factory / args.workflow
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    if args.action == "status":
        state = read(folder/"status.json", {})
        config = read(folder/"control.json", {})
        print(json.dumps({**state, "running": running(folder), "enabled": config.get("running", False),
                          "stories": config.get("stories", []), "development_routes": config.get("development_routes", {}),
                          "git_pairings": config.get("git_pairings", {}),
                          "manage_ready": config.get("manage_ready", False), "local_token_budget": config.get("local_token_budget"),
                          "state_directory": str(folder)}, indent=2))
        return
    with locked(folder/"control.lock"):
        config = read(folder/"control.json", {})
        if args.action == "git-status":
            route = config.get("development_routes", {}).get(args.repo)
            binding = config.get("git_pairings", {}).get(args.repo)
            if not route or not binding:
                print(json.dumps({"repository": args.repo, "state": "not_enrolled"}))
                return
            scope = {"factory": args.factory, "workflow": args.workflow}
            host = None
            try:
                public = paired_git.device("public", scope, route)
                paired_git.require(paired_git.public_fields(route, public) == binding, "The protected device key differs.")
                cwd = config.get("cwd") or route["checkout"]
                host = Host(cwd)
                host.open(cwd)
                paired_git.match_binding(route, binding, host.tool("manager_brief", **scope))
                result = {"state": "paired"}
            except (OSError, Hold, paired_git.Unavailable) as error:
                result = {"state": "unavailable", "reason": str(error) if isinstance(error, (Hold, paired_git.Unavailable))
                          else "The local Codex host is unavailable."}
            finally:
                if host:
                    host.close()
            print(json.dumps({**binding, **result}, indent=2))
            return
        if args.action == "git-enroll":
            route = config.get("development_routes", {}).get(args.repo)
            if not route:
                parser.error("configure the repository route before enrolling its device key")
            try:
                public = paired_git.device("enroll", {"factory": args.factory, "workflow": args.workflow}, route)
                binding = paired_git.public_fields(route, public)
            except paired_git.Unavailable as error:
                parser.error(str(error))
            save(folder/"control.json", {**config, "git_pairings": {**config.get("git_pairings", {}), args.repo: binding}})
            print(json.dumps({**binding, "state": "awaiting_person_pairing"}, indent=2))
            return
        if args.action == "route":
            if not args.checkout.is_absolute() or not args.checkout.is_dir():
                parser.error("provide the absolute path of an existing isolated checkout")
            checkout = str(args.checkout.resolve(strict=True))
            routes = dict(config.get("development_routes", {}))
            if any(r["checkout"] == checkout and name != args.repo for name, r in routes.items()):
                parser.error("each repository must have its own isolated checkout")
            rows = sorted(set(args.story))
            if len(rows) > 64 or (args.repo not in routes and len(routes) >= 64):
                parser.error("use at most 64 stories per route and 64 routes per workflow")
            routes[args.repo] = {"repository": args.repo, "checkout": checkout, "permissions": args.permissions,
                                 "config_profile": args.config_profile, "stories": rows, "revision": time.time_ns()}
            save(folder/"control.json", {**config, "development_routes": routes})
            print("Development route recorded. The supervisor verifies the repository and probes the selected sandbox before dispatch.")
            return
        if args.action == "stop":
            save(folder/"control.json", {**config, "running": False})
            print("Stop recorded. Check status for process exit.")
            return
        if args.action == "retry":
            # The status display provides the opaque story ID embedded in each recorded wake.
            state = read(folder/"status.json", {})
            held = {run.split(":")[0] for run in (*run_holds(state), *state.get("development_holds", {}))}
            if not set(args.story).issubset(held):
                parser.error("retry requires the opaque story ID of a recorded operator or capability hold")
            retries = {**config.get("retries", {}), **{story: time.time_ns() for story in args.story}}
            save(folder/"control.json", {**config, "retries": retries})
            print("Retry recorded for the held story. Local eligibility will be checked again.")
            return
        if args.action == "follow":
            if not running(folder) or not config.get("running"):
                parser.error("start the local manager before assigning a story")
            stories = sorted(set(config["stories"] + args.story))
            if len(stories) > 64:
                parser.error("use at most 64 explicitly owned stories per workflow")
            save(folder/"control.json", {**config, "stories": stories})
            print("Story ownership recorded. The manager will recheck live eligibility.")
            return
        if running(folder):
            parser.error("a manager already owns this workflow; use status or follow")
        cwd = str((args.cwd or Path(config.get("cwd", os.getcwd()))).resolve(strict=True))
        if not Path(cwd).is_dir() or (config.get("cwd") and config["cwd"] != cwd):
            parser.error("use the same dedicated checkout when resuming this manager")
        stories = sorted(set(args.story or config.get("stories", [])))
        if len(stories) > 64:
            parser.error("use at most 64 explicitly owned stories per workflow")
        config = {**config, "factory": args.factory, "workflow": args.workflow, "cwd": cwd, "stories": stories, "retries": config.get("retries", {}), "development_routes": config.get("development_routes", {}), "manage_ready": args.manage_ready or config.get("manage_ready", False), "running": True}
        if args.local_token_budget is not None:
            config["local_token_budget"] = args.local_token_budget
        owner = (folder/"owner.lock").open("a+")
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        save(folder/"control.json", config)
        # The child inherits the held lock, so two starters cannot race before its initialization.
        with (folder/"manager.log").open("a") as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_observe", str(folder), str(owner.fileno())],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                                     pass_fds=(owner.fileno(),))
        print(f"Started local CodeBook manager {child.pid}. State: {folder}")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "_observe":
        # Holding this inherited descriptor for the process lifetime is the ownership fence.
        fd = int(sys.argv[3])
        folder = Path(sys.argv[2])
        if not os.path.samestat(os.fstat(fd), (folder/"owner.lock").stat()):
            sys.exit("Missing local ownership lock.")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        supervise(folder)
    else:
        main()
