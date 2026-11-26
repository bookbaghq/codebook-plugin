"""One disposable local host lifecycle. No network, account, model or actual factory."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

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
                data = {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9"},
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
            pass
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
            until(lambda: status()["notices"]["newStory:22:expiry:10"].get("operator_hold"))
            assert len(turns()) == 3
            cli("retry", "--story", "newStory")
            until(lambda: len(turns()) == 4)
            stop()
            assert len(turns()) == 4 and not json.loads(cli("status").stdout)["enabled"]
        finally:
            if json.loads(cli("status").stdout)["running"]:
                stop()


if __name__ == "__main__":
    if sys.argv[1:] == ["--host-fixture"]:
        fake_server()
    else:
        rehearsal()
        print("ok 1 - "+NAME)
        print("1..1")
