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

IDENT = re.compile(r"[A-Za-z0-9_-]{1,70}")
STORY = re.compile(r"(?:#[1-9][0-9]{0,9}|[A-Za-z0-9_-]{1,70})")
INTERVAL = 30
RECONCILE = 180
MAX_ATTEMPTS = 3


class Hold(Exception):
    pass


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


class Host:
    """Use Codex's own OAuth transport. Only the app server receives credentials."""
    def __init__(self, cwd):
        env = dict(os.environ)
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
            env.pop(key, None)
        self.proc = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.answers = queue.Queue()
        self.serial = 0
        self.approval = False
        threading.Thread(target=self.listen, daemon=True).start()

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def listen(self):
        try:
            for line in self.proc.stdout:
                message = json.loads(line)
                if "id" in message:
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
                self.approval = True
                self.send({"id": msg["id"], "error": {"code": -32603, "message": "Operator interaction required."}})
            elif msg.get("id") == self.serial:
                if "error" in msg:
                    raise Refused(f"Codex refused {method} (RPC {msg['error'].get('code')}); inspect the dedicated thread.")
                return msg["result"]
        raise Hold(f"Codex timed out during {method}.")

    def open(self, cwd):
        self.call("initialize", {"clientInfo": {"name": "codebook_local_manager", "version": "1"},
                                 "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized", "params": {}})
        account = self.call("account/read", {"refreshToken": False}).get("account") or {}
        if account.get("type") != "chatgpt":
            raise Hold("Sign in to Codex using ChatGPT before starting this manager.")
        self.observer = self.call("thread/start", {"ephemeral": True, "cwd": cwd, "sandbox": "read-only",
                                                  "approvalPolicy": "on-request"})["thread"]["id"]

    def tool(self, name, **args):
        result = self.call("mcpServer/tool/call", {"threadId": self.observer, "server": "codebook",
                                                  "tool": name, "arguments": args})
        if result.get("isError"):
            raise Hold(f"CodeBook refused {name}; check OAuth access and the selected scope.")
        data = result.get("structuredContent")
        if not isinstance(data, dict):
            data = json.loads(result["content"][0]["text"])
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


def event_cursor(host, scope, cursor):
    result = host.tool("factory_events", **scope, **({"after": cursor} if cursor else {}), limit=50)
    last = result.get("last_event")
    if last is not None and (type(last) is not int or last < 0):
        raise Hold("Unexpected CodeBook event cursor.")
    return max(cursor, last or 0)


def hosted_here(status):
    location = status.get("run_location")
    if isinstance(location, dict):
        return location.get("where") == "here" and (location.get("person") or {}).get("is_you") is True
    return location == "here"


def eligible(host, config, adopted):
    scope = {k: config[k] for k in ("factory", "workflow")}
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
    candidates = []
    for row in host.tool("list_my_work", factory=scope["factory"])["work"]:
        if (row.get("story") not in allowed and row.get("reference") not in allowed
                or row.get("where") != "here" or row.get("claimed") is not False
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
            if (row.get("ready") is True and row.get("start_with") and row.get("workflow") == name
                    and (config["manage_ready"] or row.get("story") in allowed or row.get("reference") in allowed)
                    and isinstance(proposal.get("proposal"), str) and IDENT.fullmatch(proposal["proposal"])
                    and type(proposal.get("item")) is int and proposal["item"] > 0):
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
        status = host.tool("story_status", **scope, story=story, limit=1)
        if (status.get("factory", {}).get("factory") != scope["factory"]
                or status.get("workflow", {}).get("workflow") != scope["workflow"] or not hosted_here(status)):
            continue
        waiting = status.get("waiting") or {}
        if run:
            if (waiting.get("on") != "runner" or waiting.get("run") != run or waiting.get("on_you") is not True
                    or waiting.get("claimed") is not False):
                continue
        elif not status.get("in_backlog") or status.get("run"):
            continue
        key = f"{story}:{run}" if run else f"{story}:{proposal}:{item}"
        ready.append({"key": key, "story": story, "run": run, "proposal": proposal, "item": item})
    return ready, "Waiting for fresh eligible local work in this scope."


def marker(key):
    return "[CodeBook local wake " + key + "]"


def prompt(scope, item):
    return (f"{marker(item['key'])}\nManage only factory {scope['factory']}, workflow {scope['workflow']}, "
            f"story {item['story']}, " + (f"local station run {item['run']}. " if item["run"] else "manager-ready backlog item. ") +
            "Read the current CodeBook manager brief and revalidate this exact item's ownership, local location, "
            "approval, prerequisites, current stage and capacity before acting. If another manager or worker owns it, leave it. "
            "Use only normal CodeBook stations. Delegate each eligible station to an independent local worker to claim "
            "with a fresh fence and follow its frozen brief. Never self-QA. An approved backlog item may start only "
            "through the current server-provided start operation. Keep production, human decisions, spending and proof gates intact. "
            "For a ready drawer item, confirm only its exact proposal/item on this manager thread so the host can verify ownership. "
            "Return a short dispatch acknowledgement once the independent worker holds a fresh claim, or report the actual hold. "
            "Reuse matching exact-head proof. This wake gives no additional authorization.")


def builder_confirmed(item, target):
    """Only a successful confirmation in our dedicated thread establishes continued ownership."""
    if item.get("type") != "mcpToolCall" or item.get("server") != "codebook" or item.get("tool") != "confirm_stories":
        return False
    args = item.get("arguments") or {}
    result = item.get("result") or {}
    body = result.get("structuredContent")
    if not isinstance(body, dict):
        try:
            body = json.loads(result["content"][0]["text"])
        except (KeyError, IndexError, ValueError, TypeError):
            return False
    created = body.get("created", []) if isinstance(body, dict) else []
    actually_started = any(row.get("story") == target["story"] and row.get("item") == target["item"]
                           and row.get("run_location") == "here" and not row.get("moved_by_hand") for row in created)
    return (actually_started and item.get("status") == "completed" and not item.get("error")
            and args.get("proposal") == target["proposal"] and args.get("stories") == [target["item"]]
            and args.get("decided_by") == "manager" and args.get("run_location", "here") == "here")


class Manager:
    def __init__(self, folder, config, host):
        self.folder, self.config, self.host = folder, config, host
        self.state = read(folder / "status.json", {"cursor": 0, "notices": {}})
        self.state.setdefault("adopted", [])
        self.state.update(pid=os.getpid(), phase="starting")
        self.last_scan = 0
        self.worker = None

    def record(self, reason):
        self.state["reason"] = reason
        save(self.folder / "status.json", self.state)

    def worker_thread(self):
        if self.worker:
            return self.worker
        params = {"cwd": self.config["cwd"], "sandbox": "workspace-write", "approvalPolicy": "on-request",
                  "modelProvider": "openai"}
        previous = self.state.get("thread")
        if previous:
            info = self.host.call("thread/resume", {**params, "threadId": previous})
        else:
            info = self.host.call("thread/start", {**params, "allowProviderModelFallback": False})
        self.worker = self.state["thread"] = info["thread"]["id"]
        self.record("Connected to the dedicated Codex manager thread.")
        return self.worker

    def reconcile(self):
        active = self.state.get("active")
        if not active:
            return False
        thread = self.worker_thread()
        page = self.host.call("thread/turns/list", {"threadId": thread, "limit": 3, "itemsView": "full"})
        for turn in page["data"]:
            found = turn["id"] == active.get("turn") or any(
                i.get("type") == "userMessage" and any(t.get("type") == "text" and
                t.get("text", "").startswith(marker(active["key"])+"\n") for t in i.get("content", []))
                for i in turn.get("items", []))
            if not found:
                continue
            if turn["status"] == "inProgress":
                self.state["phase"] = "working"
                self.record("Dedicated manager turn is active.")
                return True
            active["turn"] = turn["id"]
            active["result"] = turn["status"]
            target = active["item"]
            status = self.host.tool("story_status", factory=self.config["factory"], workflow=self.config["workflow"],
                                    story=target["story"], limit=1)
            waiting = status.get("waiting") or {}
            current = status.get("run") or {}
            if target["run"]:
                progressed = (current.get("run") != target["run"] or waiting.get("claimed") is True
                              or current.get("status") in {"completed", "blocked", "failed", "cancelled"}
                              or status.get("finished") or status.get("question"))
            else:
                progressed = status.get("in_backlog") is False
                if progressed and any(builder_confirmed(i, target) for i in turn.get("items", [])):
                    if target["story"] not in self.state["adopted"]:
                        self.state["adopted"].append(target["story"])
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
        self.state.pop("active")
        self.last_scan = 0
        self.record("The unacknowledged wake will be checked against current eligibility.")
        return False

    def tick(self):
        if not self.config["running"]:
            return
        scope = {k: self.config[k] for k in ("factory", "workflow")}
        cursor = event_cursor(self.host, scope, self.state["cursor"])
        self.state["last_read"] = int(time.time())
        changed = self.state["cursor"] != cursor
        self.state["cursor"] = cursor
        if self.reconcile():
            self.record(self.state.get("reason", "Waiting for the manager receipt."))
            return
        self.state["phase"] = "observing"
        if not changed and time.monotonic() - self.last_scan < RECONCILE:
            self.record(self.state.get("reason", "Waiting for a CodeBook event."))
            return
        self.last_scan = time.monotonic()
        ready, reason = eligible(self.host, self.config, self.state["adopted"])
        keys = {item["key"] for item in ready}
        notices = self.state["notices"]
        # Keep all currently eligible keys. Discard superseded terminal identities to bound storage.
        for key in list(notices):
            if key not in keys and len(notices) > 128:
                del notices[key]
        for item in ready:
            entry = notices.setdefault(item["key"], {"attempts": 0})
            if entry.get("done"):
                continue
            if entry["attempts"] >= MAX_ATTEMPTS:
                reason = "Wake retry limit reached for " + item["key"] + "; inspect the dedicated thread."
                continue
            if time.time() < entry.get("next", 0):
                reason = "Waiting for the bounded retry of " + item["key"] + "."
                continue
            thread = self.worker_thread()
            with locked(self.folder / "control.lock"):
                current = read(self.folder / "control.json", {})
                if current != self.config or not current.get("running"):
                    return
                entry["attempts"] += 1
                entry["next"] = int(time.time()) + min(900, 60 * 2**(entry["attempts"]-1))
                self.state["active"] = {"key": item["key"], "item": item, "at": int(time.time())}
                self.record("Submitting one scoped Codex manager wake.")
                try:
                    turn = self.host.call("turn/start", {"threadId": thread, "input": [{"type": "text", "text": prompt(scope, item)}]})
                except Refused:
                    self.state.pop("active")
                    self.last_scan = 0
                    self.record("Codex rejected the wake. Bounded retry pending; check account limits or access.")
                    return
                self.state["active"]["turn"] = turn["turn"]["id"]
                self.state["phase"] = "working"
                self.record("Dedicated manager turn accepted.")
            return
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
                if manager.host.approval:
                    manager.state["interaction_required"] = True
                    manager.record("An operator decision was requested. Inspect the dedicated Codex thread.")
                    manager.host.approval = False
                failures = 0
            except (OSError, Hold, ValueError, KeyError, TypeError) as error:
                manager.state["phase"] = "held"
                reason = str(error) if isinstance(error, Hold) else "Local host or CodeBook response unavailable (" + type(error).__name__ + ")."
                manager.record(reason)
                if manager.host:
                    manager.host.close()
                    manager.host = None
                failures = min(failures+1, 5)
            delay = min(300, INTERVAL * 2**failures)
            # Recheck local controls promptly without polling CodeBook or a model.
            for _ in range(delay):
                if stop.wait(1) or read(folder / "control.json", {}) != config:
                    break
    finally:
        try:
            active = manager.state.get("active") or {}
            if manager.host and active.get("turn") and manager.state.get("thread"):
                manager.host.call("turn/interrupt", {"threadId": manager.state["thread"], "turnId": active["turn"]})
        except (OSError, Hold):
            pass
        finally:
            if manager.host:
                manager.host.close()
            manager.state["phase"] = "stopped"
            manager.record("The local manager is stopped.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "follow"])
    parser.add_argument("--factory", required=True, type=validated)
    parser.add_argument("--workflow", required=True, type=validated)
    parser.add_argument("--cwd", type=Path)
    parser.add_argument("--manage-ready", action="store_true", help="also manage new server-approved local drawer items")
    parser.add_argument("--story", action="append", type=lambda x: validated(x, STORY), default=[])
    args = parser.parse_args()
    if args.action == "follow" and not args.story:
        parser.error("follow requires an expressly assigned --story")
    if args.story and args.action not in ("follow", "start"):
        parser.error("--story is only valid on start or follow")
    if args.manage_ready and args.action != "start":
        parser.error("--manage-ready is an option for start")
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
                          "stories": config.get("stories", []), "manage_ready": config.get("manage_ready", False), "state_directory": str(folder)}, indent=2))
        return
    with locked(folder/"control.lock"):
        config = read(folder/"control.json", {})
        if args.action == "stop":
            save(folder/"control.json", {**config, "running": False})
            print("Stop recorded. Check status for process exit.")
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
        config = {"factory": args.factory, "workflow": args.workflow, "cwd": cwd, "stories": stories, "manage_ready": args.manage_ready or config.get("manage_ready", False), "running": True}
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
