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
        if "id" not in msg:
            continue
        method, params = msg["method"], msg["params"]
        cfg = json.loads((root/"factory.json").read_text())
        turns = json.loads((root/"turns.json").read_text())
        value = {}
        if method == "account/read":
            value = {"account": {"type": "chatgpt"}}
        elif method in ("thread/start", "thread/resume"):
            value = {"thread": {"id": "observe" if params.get("ephemeral") else "dedicated-manager"}}
        elif method == "mcpServer/tool/call":
            assert params["threadId"] == "observe"
            tool, args = params["tool"], params["arguments"]
            if tool == "factory_events":
                data = {"last_event": cfg["cursor"], "events": cfg.get("events", [])}
            elif tool == "manager_brief":
                row = {"ready": cfg["ready"], "workflow": "Software", "story": "newStory", "reference": "#301",
                       "start_with": "confirm via current server", "proposal": {"proposal": "wo2", "item": 9}}
                page = {"stories": [row]} if args.get("backlog_offset") else {"stories": [], "next_offset": 1}
                data = {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf9", "name": "Software"},
                        "you": {"may_run_here": True}, "backlog": page}
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
                        "in_backlog": story == "newStory" and cfg["ready"], "run": None, "waiting": None}
                if current:
                    run, claimed = current
                    data.update(run={"run": run, "status": "external"},
                                waiting={"run": run, "on": "runner", "on_you": True, "claimed": claimed})
            else:
                raise AssertionError(tool)
            value = {"isError": False, "structuredContent": data, "content": []}
        elif method == "turn/start":
            assert params["threadId"] == "dedicated-manager"
            turn = {"id": "t"+str(len(turns)+1), "status": "inProgress",
                    "items": [{"type": "userMessage", "content": params["input"]}]}
            turns.insert(0, turn)
            write(root/"turns.json", turns)
            value = {"turn": turn}
        elif method == "thread/turns/list":
            value = {"data": turns}
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
        cfg = {"cursor": 7, "paused": False, "ready": True, "work": [["foreign", 20, False], ["claimed", 21, True]]}
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
            assert not turns() and status()["cursor"] == 7
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
            assert "[CodeBook local wake newStory:wo2:9]" in first["items"][0]["content"][0]["text"]
            assert "foreign" not in first["items"][0]["content"][0]["text"]
            # Stopping/restarting keeps the submitted turn in history; observing it cannot issue another wake.
            stop()
            cli("start", "--cwd", str(root))
            until(lambda: status().get("phase") == "working")
            assert len(turns()) == 1
            cfg.update(cursor=8, ready=False, work=[["foreign", 20, False], ["newStory", 22, False], ["claimed", 21, True]])
            write(root/"factory.json", cfg)
            first["status"] = "completed"
            first["items"].append({"type": "mcpToolCall", "server": "codebook", "tool": "confirm_stories",
                "status": "completed", "arguments": {"proposal": "wo2", "stories": [9], "decided_by": "manager"},
                "result": {"structuredContent": {"created": [{"item": 9, "story": "newStory", "run_location": "here"}]}}})
            write(root/"turns.json", [first])
            cli("follow", "--story", "idle1")  # local control change requests prompt reconciliation
            until(lambda: len(turns()) == 2)
            assert "newStory" in status()["adopted"] and status()["cursor"] == 8
            second, previous = turns()
            assert "[CodeBook local wake newStory:22]" in second["items"][0]["content"][0]["text"]
            second["status"] = "completed"  # successful transport with unchanged server state
            write(root/"turns.json", [second, previous])
            cli("follow", "--story", "idle2")
            until(lambda: not status().get("active"))
            notice = status()["notices"]["newStory:22"]
            assert notice["attempts"] == 1 and not notice.get("done") and notice["next"] > time.time()
            assert len(turns()) == 2
            cfg.update(cursor=9, work=[["newStory", 23, False]])
            write(root/"factory.json", cfg)
            cli("follow", "--story", "idle3")
            until(lambda: len(turns()) == 3)
            active_turns = turns()
            active_turns[0]["status"] = "completed"
            cfg["work"] = [["newStory", 23, True]]
            write(root/"factory.json", cfg)
            write(root/"turns.json", active_turns)
            cli("follow", "--story", "idle4")
            until(lambda: status()["notices"].get("newStory:23", {}).get("done"))
            # A real expired lease reopens the same run. Duplicate feed delivery creates one fresh wake.
            cfg.update(cursor=10, work=[["newStory", 23, False], ["foreign", 24, False]],
                       events=[{"id": 10, "kind": "run.claim_expired", "card": {"key": "newStory"}, "run": 23}])
            write(root/"factory.json", cfg)
            cli("follow", "--story", "idle5")
            until(lambda: len(turns()) == 4)
            assert "[CodeBook local wake newStory:23:expiry:10]" in turns()[0]["items"][0]["content"][0]["text"]
            cli("follow", "--story", "idle6")
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
