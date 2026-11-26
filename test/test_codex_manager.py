"""One disposable local host lifecycle. No network, account, model or actual factory."""
import json
import os
import runpy
import shutil
import threading
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

NAME = "Codex local manager resumes one owned workflow from actionable CodeBook events without idle model calls"
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/codex-manager.py"
SCOPE = {"factory": "factoryA", "workflow": "wf9"}


def write(path, obj):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(obj))
    temporary.replace(path)


def fake_server():
    root = Path(os.environ["CODEBOOK_TEST_FIXTURE"])
    for raw in sys.stdin:
        msg = json.loads(raw)
        if "id" not in msg or "method" not in msg:
            continue
        method, params = msg["method"], msg["params"]
        cfg = json.loads((root/"factory.json").read_text())
        turns = json.loads((root/"turns.json").read_text())
        value = {}
        if method == "account/read":
            value = {"account": {"type": "chatgpt"}}
        elif method == "thread/start":
            count = len(turns) + 1
            value = {"thread": {"id": "observe" if params.get("ephemeral") else f"worker-{count}"}}
        elif method == "thread/resume":
            value = {"thread": {"id": params["threadId"]}}
        elif method == "mcpServer/tool/call":
            assert params["threadId"] == "observe"
            tool, args = params["tool"], params["arguments"]
            if tool == "factory_events":
                data = {"last_event": cfg["cursor"], "events": cfg.get("events", [])}
            elif tool == "manager_brief":
                rows = [{"ready": ready, "workflow": "Software", "story": story,
                         "start_with": f'confirm_stories {{ proposal: "wo2", stories: [{item}], decided_by: "manager" }}',
                         "proposal": {"proposal": "wo2", "item": item}} for story, item, ready in
                        (("uncertain", 8, cfg.get("ambiguous", False)), ("newStory", 9, cfg["ready"]))]
                page = {"stories": rows} if args.get("backlog_offset") else {"stories": [], "next_offset": 1}
                data = {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9", "name": "Software"},
                        "you": {"may_run_here": True}, "backlog": page}
            elif tool == "confirm_stories":
                assert args == {**{"factory": "factoryA", "proposal": "wo2", "stories": args["stories"]},
                                "decided_by": "manager", "run_location": "here", "start": True}
                item = args["stories"][0]
                story = "newStory" if item == 9 else "uncertain"
                state = json.loads((root/"state/codebook/codex-manager/factoryA/wf9/status.json").read_text())
                assert state["notices"][f"{story}:wo2:{item}"]["confirmation"] == "awaiting_receipt"
                assert (root/"factory.json").exists() and not cfg["paused"]
                if item == 9:
                    assert cfg["ready"]
                    cfg["ready"] = False
                    cfg["work"].append(["newStory", 22, False])
                    created = [{"item": 9, "story": "newStory", "run_location": "here", "from_backlog": True, "moved_by_hand": False}]
                else:
                    assert item == 8 and cfg["ambiguous"]
                    cfg["ambiguous"] = False
                    cfg["work"].append(["uncertain", 44, False])
                    created = []  # raced another manager; post-state alone grants no ownership
                (root/"confirmations.log").open("a").write(story + "\n")
                write(root/"factory.json", cfg)
                data = {"decided_by": "manager", "proposal": {"proposal": "wo2"}, "created": created}
            elif tool == "factory_operations":
                data = {"snapshot": {"control": {"paused": cfg["paused"]}, "holds": []}}
            elif tool == "list_my_work":
                data = {"work": [{"story": story, "run": run, "claimed": claimed, "where": "here",
                                  "factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"}}
                                 for story, run, claimed in cfg["work"]]}
            elif tool == "story_status":
                story = args["story"]
                current = next(((r, c) for s,r,c in cfg["work"] if s == story), None)
                data = {"story": {"story": story}, "factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"},
                        "run_location": {"where": "here", "person": {"is_you": True}},
                        "in_backlog": (story == "newStory" and cfg["ready"]) or (story == "uncertain" and cfg.get("ambiguous")),
                        "station": {"name": "QA", "worker": {"type": "agent", "name": "Jade"}},
                        "run": None, "waiting": None}
                if current:
                    run, claimed = current
                    data.update(run={"run": run, "status": "external"},
                                waiting={"run": run, "on": "runner", "on_you": True, "claimed": claimed,
                                         "lease": {"fence": 1, "expired": False} if claimed else None})
            else:
                raise AssertionError(tool)
            value = {"isError": False, "structuredContent": data, "content": []}
        elif method == "turn/start":
            assert params["threadId"].startswith("worker-")
            turn = {"id": "t"+str(len(turns)+1), "status": "inProgress", "workerThread": params["threadId"],
                    "items": [{"type": "userMessage", "content": params["input"]}]}
            turns.insert(0, turn)
            write(root/"turns.json", turns)
            value = {"turn": turn}
        elif method == "thread/turns/list":
            if cfg.get("approval_thread") == params["threadId"] and not (root/"approval").exists():
                (root/"approval").touch()
                print(json.dumps({"id": "request-approval", "method": "item/commandExecution/requestApproval",
                                  "params": {"threadId": params["threadId"]}}), flush=True)
            value = {"data": [t for t in turns if t["workerThread"] == params["threadId"]]}
        elif method == "turn/interrupt":
            if cfg.get("shutdown_approval_thread") == params["threadId"]:
                print(json.dumps({"id": "shutdown-approval", "method": "item/commandExecution/requestApproval",
                                  "params": {"threadId": params["threadId"]}}), flush=True)
        elif method != "initialize":
            raise AssertionError(method)
        print(json.dumps({"id": msg["id"], "result": value}), flush=True)


def until(fn):
    end = time.monotonic()+12
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError("Timed out waiting for fixture transition")


def rehearsal():
    with tempfile.TemporaryDirectory(prefix="codebook-codex-manager-") as scratch:
        root = Path(scratch)
        executable = root/"codex"
        executable.write_text("#!"+sys.executable+"\nimport runpy, sys\nsys.argv=['fixture', '--host-fixture']\nrunpy.run_path("+repr(str(Path(__file__).resolve()))+", run_name='__main__')\n")
        executable.chmod(0o700)
        env = {**os.environ, "PATH": str(root)+os.pathsep+os.environ["PATH"], "XDG_STATE_HOME": str(root/"state"),
               "CODEBOOK_TEST_FIXTURE": str(root)}
        args = ["--factory", "factoryA", "--workflow", "wf9"]
        def cli(action, *extra, check=True):
            call = subprocess.run([sys.executable, str(SCRIPT), action, *args, *extra], env=env,
                                  capture_output=True, text=True, timeout=8, check=check)
            return call
        state = root/"state/codebook/codex-manager/factoryA/wf9/status.json"
        def status():
            return json.loads(state.read_text()) if state.exists() else {}
        def turns():
            return json.loads((root/"turns.json").read_text())
        cfg = {"cursor": 7, "paused": False, "ready": True, "ambiguous": True, "work": [["foreign", 20, False], ["claimed", 21, True]]}
        write(root/"factory.json", cfg)
        write(root/"turns.json", [])
        def acknowledged():
            return status().get("last_read") and status().get("phase") == "observing"
        def stop():
            cli("stop")
            until(lambda: not json.loads(cli("status").stdout)["running"])
        try:
            cli("start", "--cwd", str(root))
            until(acknowledged)
            assert not turns() and status()["cursor"] == 7 and not (root/"confirmations.log").exists()
            assert cli("start", "--cwd", str(root), check=False).returncode
            stop()
            cfg["paused"] = True
            write(root/"factory.json", cfg)
            cli("start", "--cwd", str(root), "--manage-ready")
            until(lambda: "pause" in status().get("reason", ""))
            assert not turns()
            cfg["paused"] = False
            write(root/"factory.json", cfg)
            cli("follow", "--story", "claimed")
            until(lambda: len(turns()) == 1)
            first = turns()[0]
            assert "[CodeBook local wake newStory:22]" in first["items"][0]["content"][0]["text"]
            assert "claim_work" in first["items"][0]["content"][0]["text"]
            assert status()["adopted"] == ["newStory"]
            assert (root/"confirmations.log").read_text().splitlines() == ["uncertain", "newStory"]
            assert not any("uncertain:44" in t["items"][0]["content"][0]["text"] for t in turns())
            stop()
            cli("start", "--cwd", str(root))
            until(lambda: status().get("phase") == "working")
            assert len(turns()) == 1
            cfg = json.loads((root/"factory.json").read_text())
            cfg.update(cursor=8, work=[["foreign", 20, False], ["newStory", 22, True], ["other", 23, False]])
            write(root/"factory.json", cfg)
            cli("follow", "--story", "other")
            until(lambda: len(turns()) == 2)
            assert "newStory:22" in status()["workers"] and turns()[1]["status"] == "inProgress"
            second, first = turns()
            assert second["workerThread"] != first["workerThread"]
            assert "[CodeBook local wake other:23]" in second["items"][0]["content"][0]["text"]
            second["status"] = "completed"  # transport success without actual station transition
            write(root/"turns.json", [second, first])
            cli("follow", "--story", "idle2")
            until(lambda: not status().get("active"))
            notice = status()["notices"]["other:23"]
            assert notice["attempts"] == 1 and not notice.get("done") and notice["next"] > time.time()
            assert len(turns()) == 2
            # A real expired lease reopens the same run. Duplicate feed delivery creates one fresh wake.
            cfg.update(cursor=10, work=[["newStory", 22, False], ["foreign", 24, False]],
                       events=[{"id": 10, "kind": "run.claim_expired", "card": {"key": "newStory"}, "run": 22}])
            write(root/"factory.json", cfg)
            cli("follow", "--story", "idle5")
            until(lambda: len(turns()) == 3)
            assert "[CodeBook local wake newStory:22:expiry:10]" in turns()[0]["items"][0]["content"][0]["text"]
            records = turns()
            records[0]["status"] = "completed"
            cfg["approval_thread"] = records[0]["workerThread"]
            write(root/"factory.json", cfg)
            write(root/"turns.json", records)
            cli("follow", "--story", "idle6")
            until(lambda: status().get("run_holds", {}).get("newStory:22"))
            assert len(turns()) == 3
            stop()
            cfg.update(cursor=11, events=[{"id": 11, "kind": "run.claim_expired", "card": {"key": "newStory"}, "run": 22}])
            write(root/"factory.json", cfg)
            cli("start", "--cwd", str(root))
            until(lambda: status().get("cursor") == 11 and "Operator decision pending" in status().get("reason", ""))
            assert len(turns()) == 3 and status()["run_holds"]["newStory:22"]
            cli("retry", "--story", "newStory")
            until(lambda: len(turns()) == 4)
            # The host can deliver a fresh approval during the final interrupt of a fenced worker.
            cfg.update(shutdown_approval_thread=turns()[0]["workerThread"], work=[["newStory", 22, True]])
            write(root/"factory.json", cfg)
            cli("follow", "--story", "idle7")
            until(lambda: status().get("workers", {}).get("newStory:22:expiry:11"))
            stop()
            assert status()["phase"] == "stopped" and status()["run_holds"].get("newStory:22")
            cfg.update(cursor=12, work=[["newStory", 22, False]],
                       events=[{"id": 12, "kind": "run.claim_expired", "card": {"key": "newStory"}, "run": 22}])
            write(root/"factory.json", cfg)
            cli("start", "--cwd", str(root))
            until(lambda: status().get("cursor") == 12 and "Operator decision pending" in status().get("reason", ""))
            assert len(turns()) == 4
            cli("retry", "--story", "newStory")
            until(lambda: len(turns()) == 5)
            stop()
            assert len(turns()) == 5 and not json.loads(cli("status").stdout)["enabled"]
        finally:
            if json.loads(cli("status").stdout)["running"]:
                stop()


def obsolete_operator_holds():
    api = runpy.run_path(str(SCRIPT))
    ended = {"run": 7, "status": "completed", "state": "passed", "finished_at": "2026-11-25"}
    history = {"run": None, "waiting": None, "stations": [{"station": "qa", **ended}]}
    records = {
        "ambiguous": {"run": {"run": 7, "state": "with_outside_agent"}, "stations": [ended]},
        "done": {"finished": "done"},
        "dropped": {**history, "finished": "dropped"},
        "ended": {"run": {"run": 7, "state": "blocked", "finished_at": "2026-11-25"}},
        "foreign": {"workflow": {"workflow": "another"}, "finished": "done"},
        "history": history,
        "later": {"run": {"run": 8, "state": "queued"}},
        "live": {"run": {"run": 7, "state": "with_outside_agent"}},
        "missing_finish": {"run": {"run": 7, "state": "superseded"}},
        "older": {"run": {"run": 6, "state": "passed", "finished_at": "2026-11-25"}},
        "sent_back": {"run": {**ended, "status": "rejected", "state": "sent_back"}},
        "superseded": {"run": {**ended, "status": "superseded", "state": "superseded"}},
        "unrelated_history": {**history, "stations": [{**ended, "run": 6}]},
        "unknown": None,
        "waiting": {**history, "waiting": {"run": 7, "on": "runner"}},
        "wrong_story": {"story": {"story": "another"}, "finished": "done"},
    }
    calls = []

    class Observer:
        approval_threads = set()

        def __init__(self, work=None):
            self.turns = []
            self.work = work or {}

        def tool(self, name, **args):
            if name == "factory_events":
                return {"last_event": 99}
            if name == "manager_brief":
                return {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9", "name": "Software"},
                        "you": {"may_run_here": True}}
            if name == "factory_operations":
                return {"snapshot": {"control": {"paused": False}}}
            if name == "list_my_work":
                return {"work": [{"story": story, "run": run, "where": "here", "claimed": False,
                                  "factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"}}
                                 for story, run in self.work.items()]}
            assert name == "story_status" and args["limit"] == 1
            story = args["story"]
            calls.append(story)
            if records[story] is None:
                raise api["Hold"]("Snapshot unavailable")
            return {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"},
                    "story": {"story": story}, **records[story]}

        def call(self, method, params):
            if method == "thread/start":
                return {"thread": {"id": "ready-thread"}}
            assert method == "turn/start"
            self.turns.append(params["input"][0]["text"])
            return {"turn": {"id": "ready-turn"}}

    cfg = {**SCOPE, "stories": [], "manage_ready": False, "running": True}
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        notices = {story + ":7": {"operator_hold": 123} for story in records}
        write(folder/"status.json", {"cursor": 99, "notices": notices})
        manager = api["Manager"](folder, cfg, Observer())
        manager.tick()
        assert len(calls) == 4 and manager.state["interaction_required"]
        manager.tick()
        assert len(calls) == 4  # no repeated reads while polling
        for _ in range(3):
            manager.next_hold_read = 0
            manager.tick()
        assert "wrong_story" in calls  # keep rotating past the refused story in the same batch
        expected = {key + ":7" for key in ("ambiguous", "foreign", "live", "missing_finish", "older",
                                          "unknown", "unrelated_history", "waiting", "wrong_story")}
        assert set(manager.holds) == expected
        assert manager.state["notices"] == notices
        manager = api["Manager"](folder, cfg, Observer())
        assert set(manager.holds) == expected
        records.update({key.split(":")[0]: {"finished": "done"} for key in expected})
        for _ in range(3):
            manager.next_hold_read = 0
            manager.tick()
        persisted = json.loads((folder/"status.json").read_text())
        assert persisted["run_holds"] == {} and not persisted["interaction_required"]

    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        observer = Observer({"held": 7, "ready": 8})
        cfg = {**cfg, "cwd": directory, "stories": list(observer.work)}
        write(folder/"control.json", cfg)
        write(folder/"status.json", {"cursor": 99, "notices": {"held:7": {"operator_hold": 123}},
                                     "interaction_required": True})
        records.update(held=None, ready={
            "run": {"run": 8}, "waiting": {"run": 8, "on": "runner", "on_you": True, "claimed": False},
            "station": {"name": "QA", "worker": {"type": "agent", "name": "Jade"}},
            "run_location": {"where": "here", "person": {"is_you": True}},
        })
        calls.clear()
        manager = api["Manager"](folder, cfg, observer)
        with patch.object(time, "monotonic", return_value=100):
            manager.tick()
        persisted = json.loads((folder/"status.json").read_text())
        assert persisted["run_holds"] == {"held:7": 123} and persisted["interaction_required"]
        assert persisted["active"]["key"] == "ready:8"
        assert calls == ["held", "ready"]
        assert len(observer.turns) == 1 and observer.turns[0].startswith("[CodeBook local wake ready:8]")


def refused_worker_creation():
    # Advance only the fixture clock. Each observer reconnects with the real durable checkpoint.
    api = runpy.run_path(str(SCRIPT))
    manager_class = api["Manager"]
    globals_for_tick = manager_class.tick.__globals__
    item = {"key": "startup:17", "story": "startup", "run": 17}
    attempts = []

    class DeniedHost:
        approval_threads = set()

        def call(self, method, params):
            assert method == "thread/start"
            attempts.append(method)
            raise api["Refused"]("Worker startup denied.")

    with tempfile.TemporaryDirectory(prefix="codebook-refused-worker-") as scratch:
        folder = Path(scratch)
        config = {**SCOPE, "running": True, "cwd": scratch, "stories": ["startup"], "manage_ready": False}
        write(folder/"control.json", config)
        with patch.dict(globals_for_tick, {
                "read_events": lambda host, scope, cursor: (cursor + 1, []),
                "eligible": lambda *args, **kwargs: ([item.copy()], "Eligible.")}):
            for i in range(5):
                manager = manager_class(folder, config, DeniedHost())
                with patch.object(time, "time", return_value=10000 + i*1000):
                    manager.tick()
            assert len(attempts) == 3
            checkpoint = json.loads((folder/"status.json").read_text())
            assert checkpoint["notices"]["startup:17"]["attempts"] == 3
            assert "retry limit reached" in checkpoint["reason"]


def development_routing():
    api = runpy.run_path(str(SCRIPT))
    manager_type = api["Manager"]
    declared = [{"name": repo, "url": "https://github.com/"+repo, "writable": True} for repo in ("acme/app", "acme/plugin")]
    states = {"private": (10, "Development", "acme/app"), "public": (11, "Development", "acme/plugin"),
              "review": (12, "QA", "acme/app")}
    claimed = set()
    calls = []
    probes = []
    cursor = 0

    class Observer:
        approval_threads = set()

        def tool(self, name, **args):
            nonlocal cursor
            if name == "factory_events":
                cursor += 1
                return {"last_event": cursor}
            if name == "manager_brief":
                return {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9", "name": "Software"},
                        "repositories": declared, "you": {"may_run_here": True, "on_my_computer": {"working_now": len(claimed), "limit": 2}}}
            if name == "factory_operations":
                return {"snapshot": {"control": {"paused": False}, "tiles": {"working": len(claimed), "max_concurrent_runs": 2}}}
            if name == "list_my_work":
                return {"work": [{"story": story, "where": "here", "run": run, "claimed": story in claimed,
                                  "factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"}}
                                 for story, (run, _, _) in states.items()]}
            assert name == "story_status"
            story = args["story"]
            run, station, repo = states[story]
            return {"story": {"story": story, "repository": repo}, "run": {"run": run},
                    "factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"},
                    "station": {"name": station, "worker": {"type": "agent", "name": "Alex" if station == "Development" else "Jade"}},
                    "run_location": {"where": "here", "person": {"is_you": True}},
                    "waiting": {"run": run, "on": "runner", "on_you": True, "claimed": story in claimed,
                                "lease": {"fence": 1, "expired": False} if story in claimed else None}}

        def call(self, method, params):
            calls.append(("ordinary", method, params))
            if method == "thread/start":
                return {"thread": {"id": "qa-thread"}}
            if method == "turn/start":
                return {"turn": {"id": "qa-turn"}}
            if method == "thread/turns/list":
                return {"data": [{"id": "qa-turn", "status": "inProgress", "items": []}]}
            raise AssertionError(method)

    with tempfile.TemporaryDirectory(prefix="codebook-dev-route-") as scratch:
        root = Path(scratch)
        git = shutil.which("git")
        routes = {}
        for repo in ("acme/app", "acme/plugin"):
            project = root/repo.split("/")[1]
            subprocess.run([git, "init", "-q", str(project)], check=True)
            subprocess.run([git, "-C", str(project), "remote", "add", "origin", f"https://github.com/{repo}.git"], check=True)
            routes[repo] = {"repository": repo, "checkout": str(project), "permissions": project.name+"-permissions",
                            "config_profile": "development-fixture", "revision": 1, "stories": []}
        # Replace only the HTTPS endpoint with a disposable local Git repository.
        upstream = root/"fixture-upstream"
        subprocess.run([git, "init", "-q", "-b", "main", str(upstream)], check=True)
        subprocess.run([git, "-C", str(upstream), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "upstream", "--allow-empty"], check=True)
        upstream_head = subprocess.check_output([git, "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
        standin = root/"bin"
        standin.mkdir()
        (standin/"git").write_text("#!"+sys.executable+"\nimport os,sys\nfrom pathlib import Path\n"
                "if sys.argv[1:2] == ['fetch']:\n"
                " if Path.cwd().name == 'app':\n  print('could not read Username: terminal prompts disabled',file=sys.stderr); sys.exit(128)\n"
                " sys.argv[1:1] = ['-c', "+repr("url."+str(upstream)+".insteadOf=https://github.com/acme/plugin.git")+"]\n"
                "os.execv("+repr(git)+", ['git', *sys.argv[1:]])\n")
        (standin/"git").chmod(0o700)
        env = {**os.environ, "PATH": str(standin)+os.pathsep+os.environ["PATH"]}

        class RoutedHost:
            def __init__(self, cwd, development):
                self.route = development
                assert cwd == development["checkout"] and development["config_profile"] == "development-fixture"
                self.approval_threads = set()

            def open(self, cwd, observe):
                assert cwd == self.route["checkout"] and not observe

            def call(self, method, params):
                route = self.route
                calls.append((route["repository"], method, params))
                if method == "experimentalFeature/list":
                    return {"data": [{"name": "network_proxy", "enabled": True}]}
                if method == "permissionProfile/list":
                    return {"data": [{"id": route["permissions"], "allowed": True}]}
                if method == "command/exec":
                    assert params["cwd"] == route["checkout"] and params["permissionProfile"] == route["permissions"]
                    child = subprocess.run(params["command"], cwd=params["cwd"], env={**env, **params["env"]},
                                           capture_output=True, timeout=10)
                    probes.append((route["repository"], child.returncode))
                    return {"exitCode": child.returncode}
                if method == "thread/start":
                    assert params["permissions"] == route["permissions"] and params["runtimeWorkspaceRoots"] == [route["checkout"]]
                    assert params["cwd"] == route["checkout"] and "sandbox" not in params
                    return {"thread": {"id": "development-thread"}}
                if method == "turn/start":
                    return {"turn": {"id": "development-turn"}}
                if method == "thread/turns/list":
                    return {"data": [{"id": "development-turn", "status": "inProgress", "items": []}]}
                raise AssertionError(method)

        overlay = root/"development-fixture.config.toml"
        overlay.write_text('[permissions.plugin-permissions.filesystem]\n":minimal" = "read"\n'
                           '[permissions.plugin-permissions.network]\nenabled = true\n'
                           '[permissions.plugin-permissions.network.domains]\n"github.com" = "allow"\n'
                           '[permissions.unrelated]\ndescription = "other"\n')
        with patch.dict(os.environ, {"CODEX_HOME": scratch}), patch.object(subprocess, "Popen") as spawn, patch.object(threading.Thread, "start"):
            if sys.version_info >= (3, 11):
                api["Host"](routes["acme/plugin"]["checkout"], development=routes["acme/plugin"])
                argv = spawn.call_args.args[0]
                assert argv[:4] == ["codex", "-c", "features.network_proxy=true", "-c"]
                assert argv[5:] == ["-c", 'default_permissions="plugin-permissions"', "app-server", "--stdio"]
                assert argv[4].startswith("permissions.plugin-permissions=") and '"github.com" = "allow"' in argv[4] and "unrelated" not in argv[4]
            else:
                try:
                    api["Host"](routes["acme/plugin"]["checkout"], development=routes["acme/plugin"])
                except api["Hold"]:
                    assert not spawn.called
                else:
                    raise AssertionError("An unavailable overlay parser must hold before dispatch.")
        config = {**SCOPE, "running": True, "cwd": scratch, "stories": list(states), "manage_ready": False, "development_routes": routes}
        write(root/"control.json", config)
        manager = manager_type(root, config, Observer())
        with patch.dict(manager_type.tick.__globals__, {"Host": RoutedHost}):
            manager.tick()
            assert manager.state["active"]["key"] == "public:11"
            assert probes == [("acme/app", 5), ("acme/plugin", 0)]
            assert "authentication" in manager.state["development_holds"]["private:10"]["reason"]
            claimed.add("public")
            manager.tick()
            assert manager.state["active"]["key"] == "review:12" and len(probes) == 2
            turns = [(repo, method) for repo, method, _ in calls if method == "turn/start"]
            assert turns == [("acme/plugin", "turn/start"), ("ordinary", "turn/start")]
            qa_start = next(params for repo, method, params in calls if repo == "ordinary" and method == "thread/start")
            assert qa_start["sandbox"] == "workspace-write" and "permissions" not in qa_start and qa_start["cwd"] == scratch
            assert not any("proof" in method for _, method, _ in calls)
            project = Path(routes["acme/plugin"]["checkout"])
            subprocess.run([git, "-C", str(project), "cat-file", "-e", upstream_head+"^{commit}"], check=True)
            assert upstream_head in (project/".git"/"FETCH_HEAD").read_text()
            assert subprocess.check_output([git, "-C", str(project), "rev-parse", "refs/remotes/origin/main"], text=True).strip() == upstream_head
            list_refs = [git, "-C", str(project), "for-each-ref", "--format=%(refname)"]
            normal_refs = subprocess.check_output(list_refs, text=True).splitlines()
            assert set(normal_refs) in ({"refs/remotes/origin/main"}, {"refs/remotes/origin/HEAD", "refs/remotes/origin/main"})

            # Exercise the same cached clone with each denied Git metadata path and a writable control.
            repository = project/".git"
            for index, relative in enumerate(("objects", "refs/heads", "refs/remotes/origin", "FETCH_HEAD")):
                held_folder = root/("held-"+str(index))
                held_folder.mkdir()
                held_config = {**config, "stories": ["public", "review"]}
                write(held_folder/"control.json", held_config)
                manager = manager_type(held_folder, held_config, Observer())
                claimed.clear()
                target = repository/relative
                mode = target.stat().st_mode
                target.chmod(0o555 if target.is_dir() else 0o444)
                try:
                    manager.tick()
                    assert manager.state["active"]["key"] == "review:12" and probes[-1] == ("acme/plugin", 3), relative
                    assert "Git object store" in manager.state["development_holds"]["public:11"]["reason"]
                    claimed.add("review")
                    probe_count = len(probes)
                    manager.tick()
                    assert len(probes) == probe_count and "active" not in manager.state
                finally:
                    target.chmod(mode)
                manager.config = {**held_config, "retries": {"public": 1}}
                write(held_folder/"control.json", manager.config)
                manager.tick()
                assert probes[-1] == ("acme/plugin", 0) and manager.state["active"]["key"] == "public:11"
                assert subprocess.check_output(list_refs, text=True).splitlines() == normal_refs
                assert not list(project.glob(".codebook-preflight-*"))
                trees = subprocess.check_output([git, "-C", str(project), "worktree", "list", "--porcelain"], text=True)
                assert trees.count("worktree ") == 1 and upstream_head in (repository/"FETCH_HEAD").read_text()



if __name__ == "__main__":
    if sys.argv[1:] == ["--host-fixture"]:
        fake_server()
    else:
        rehearsal()
        refused_worker_creation()
        print("ok 1 - "+NAME)
        development_routing()
        print("ok 2 - Development dispatch respects repository capabilities and leaves proof permissions intact")
        obsolete_operator_holds()
        print("ok 3 - local manager reconciles obsolete operator holds while preserving live decisions")
        print("1..3")
