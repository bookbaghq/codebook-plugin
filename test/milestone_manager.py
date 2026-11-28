"""Synthetic signed-in CodeBook transport for the real local manager reconciliation loop."""
import json
from pathlib import Path
import runpy
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT/"test/fixtures/milestone-check-routes.mjs").read_text().split("\n", 1)[1])


API = runpy.run_path(str(ROOT/"scripts/codex-manager.py"))
FACTORY, WORKFLOW = "fixtureFactory", "wf1"

class Host:
    approval_threads = set()
    def __init__(self, order, route):
        self.order, self.route = order, route
        self.calls, self.effects, self.turns = [], [], []
        self.pending_work = self.lost = False
        self.attention = route
        self.history, self.legacy = [], []
        self.policy = "ask"
        self.change_after_read = False
        self.fixes, self.receipts = [], {}
        self.ready_story = "ready"

    def tool(self, name, **args):
        self.calls.append(name)
        scope = {"factory": {"factory": FACTORY}, "workflow": {"workflow": WORKFLOW, "name": "Ship"}}
        if name == "factory_events":
            return {"events": [], "last_event": len(self.calls)}
        if name == "manager_brief":
            return {**scope, "you": {"may_run_here": True}, "settings": {"decision_mode": "ask"}}
        if name == "factory_operations":
            return {"snapshot": {"control": {"paused": False}}}
        if name == "list_my_work":
            return {"work": [{**scope, "story": self.ready_story, "run": 123, "where": "here", "claimed": False}] if self.pending_work else []}
        if name == "story_status":
            return {**scope, "story": {"story": self.ready_story}, "run_location": "here", "run": {"run": 123},
                    "station": {"name": "QA", "worker": {"type": "agent", "name": "Jade"}},
                    "waiting": {"on": "runner", "run": 123, "on_you": True, "claimed": False}}
        if name == "work_orders":
            assert args == {"factory": FACTORY, "order": self.order}
            r = self.route
            check = {"route": r, "needs_person": bool(self.legacy or r and r["owner"] == "person"),
                     "check_cannot_run": self.policy, "latest": {"id": r["check"] if r else 90, "attempt": 2}, "history": self.history}
            return {"order": self.order, "work_order": {"status": "open"},
                    "milestones": [{"milestone": 1, "check": check, "fixes": self.fixes}]}
        if name == "needs_you":
            assert args == {"factory": FACTORY}
            r = self.attention
            items = {"for_person": list(self.legacy), "for_manager": []}
            if r and r["owner"] != "none":
                items["for_"+r["owner"]].append({"kind": "milestone_check", "route": r, "on_you": r["owner"] == "person"})
            if self.change_after_read:
                self.change_after_read = False
                self.route = {**self.route, "owner": "none", "action": "hold"}
                self.policy = "hold"
            return items
        if name == "proof_result":
            assert args["factory"] == FACTORY
            return self.receipts.get((args["story"], args["proof"]), {"proof":args["proof"], "finished":False})
        assert name == "decide_milestone_check"
        r = self.route
        assert args == {"decision": "retry", "authority": "manager", "factory": FACTORY, "order": self.order,
                        "check": r["check"], "expected_policy": self.policy}
        assert json.loads((self.folder/"status.json").read_text())["milestone_orders"][self.order]["retries"]
        self.effects.append(args)
        if self.lost:
            raise API["Hold"]("Lost reply")
        return {**args, "requested_check": r["check"], "check": {"id": 99}, "started": {"check_id": 99}}

    def tool_in(self, thread, name, *, run):
        assert thread == "independent" and name == "claim_work" and run == 123
        return {"run": run, "story": self.ready_story, "where": "here", "lease": {"fence": 1}, "brief": {"station": "QA"}}

    def call(self, name, params):
        if name == "thread/start":
            return {"thread": {"id": "independent"}}
        assert name == "turn/start"
        self.turns.append(params["input"])
        return {"turn": {"id": "one"}}


def exercise():
    factory, workflow, api = FACTORY, WORKFLOW, API
    for case in (c for c in CASES if c["id"].startswith("F")):
        route, label = case["route"], case["id"]
        order = route["order"] if route else "wo39"
        host = Host(order, route)
        with tempfile.TemporaryDirectory() as scratch:
            folder = host.folder = Path(scratch)
            config = {"running": True, "cwd": scratch, "factory": factory, "workflow": workflow, "manage_ready": True, "stories": []}
            api["save"](folder/"control.json", config)
            api["save"](folder/"status.json", {"cursor": 0, "notices": {"mine:"+order+":1": {"confirmation": "confirmed"}}})
            restart = lambda: api["Manager"](folder, config, host)
            manager = restart()
            host.lost = label == "F6"
            manager.tick()
            ledger = manager.state["milestone_orders"][order]
            assert len(ledger["questions"]) == int(label == "F5")
            assert len(host.effects) == int(label == "F6")
            if label == "F5":
                assert "#43" in next(iter(ledger["questions"].values()))
            if label == "F6":
                assert next(iter(ledger["retries"].values()))["state"] == "pending"
            manager = restart()
            manager.tick()
            ledger = manager.state["milestone_orders"][order]
            assert len(ledger["seen"]) == int(label == "F5") and len(host.effects) == int(label == "F6")
            if label == "F5":
                host.route = {**route, "owner": "none", "action": "hold"}
                manager.tick()
                assert not ledger["questions"] and not manager.state["interaction_required"]
                host.route = host.attention = {**route, "check": 104}
                host.pending_work = True
                manager.tick()
                assert len(ledger["seen"]) == 2 and len(host.turns) == 1 and len(ledger["questions"]) == 1
            elif label == "F6":
                old = route["check"]
                host.route = host.attention = {**route, "owner":"none", "action":"wait", "check": 97}
                manager.tick()
                record = next(iter(ledger["retries"].values()))
                assert record["state"] == "pending"
                host.history = [{"id": old, "attempt": 1, "decision": "manager_retry", "status": "fixed",
                                 "decided_at": "2026-11-26", "retry_note": "Fix finished"}]
                manager.tick()
                assert record["state"] == "confirmed" and record["check"] == 97 and len(host.effects) == 1
                host.route = host.attention = {**route, "check": 100}
                host.change_after_read = True
                manager.tick()
                assert len(host.effects) == 1
            elif label == "F8":
                row = dict(kind="milestone_check", factory=factory, order=order, check_id=90, on_you=True, why="Existing question")
                host.legacy = [{**row, "on_you": False}, {**row, "check_id": 88}]
                manager.tick()
                assert not ledger["questions"]
                host.legacy = [{**row, "delivery":"board_only"}]
                manager.tick()
                assert not ledger["questions"]
                manager = restart()
                manager.tick()
                ledger = manager.state["milestone_orders"][order]
                assert not ledger["questions"] and not manager.state["interaction_required"]
                host.legacy = [{**row, "delivery":"chat"}]
                manager.tick()
                manager.tick()
                assert len(ledger["seen"]) == 1 and not host.effects
            elif label == "F1":
                host.pending_work = True
                manager.tick()
                assert len(host.turns) == 1 and "decide_milestone_check" not in host.calls


if __name__ == "__main__":
    exercise()


def manager_recovery():
    from contextlib import contextmanager
    from copy import deepcopy

    routes = {case["id"]: case["route"] for case in CASES}

    @contextmanager
    def owned(route):
        order = route["order"]
        with tempfile.TemporaryDirectory() as scratch:
            folder = Path(scratch)
            config = dict(running=True, cwd=scratch, factory=FACTORY, workflow=WORKFLOW, manage_ready=True, stories=[])
            API["save"](folder/"control.json", config)
            API["save"](folder/"status.json", {"cursor":0, "notices":{"mine:"+order+":1":{"confirmation":"confirmed"}}})
            host = Host(order, deepcopy(route))
            host.folder, host.policy = folder, "manager_recovery"
            restart = lambda: API["Manager"](folder, config, host)
            yield host, restart(), restart

    for label in ("R1", "R3"):
        route = routes[label]
        with owned(route) as (host, manager, restart):
            target = route["recovery"]
            manager.tick()
            ledger = manager.state["milestone_orders"][host.order]
            record = next(iter(ledger["recovery"].values()))
            assert record["target"] == target and record["state"] == "pending" and not ledger["questions"]
            assert ("/factory prove 701" if label == "R1" else "registered executor proof 702") in record["note"]
            host.route = host.attention = {**route, "action":"wait", "owner":"none"}
            host.route.pop("recovery")
            host.receipts[target["member_story"],target["proof"]] = {"proof":target["proof"], "finished":True,
                "commands":[{"run":target["proof"],"name":"test","status":"passed","verified":True,"commit":"b"*40}]}
            second = restart()
            second.tick()
            record = next(iter(second.state["milestone_orders"][host.order]["recovery"].values()))
            assert record["state"] == "pending" and not record["current"]
            host.receipts[target["member_story"],target["proof"]]["commands"][0]["commit"] = target["commit"]
            second.tick()
            assert record["state"] == "completed" and not host.effects and "claim_proof" not in host.calls

    with owned(routes["R2"]) as (host, manager, _):
        target = host.route["recovery"]
        host.fixes = [{"check_id":host.route["check"], "item_id":target["item"], "card":{"public_id":target["story"]}}]
        host.pending_work = True
        host.ready_story = target["story"]
        manager.tick()
        assert len(host.turns) == 1
        item = manager.state["active"]["item"]
        assert item["story"] == target["story"] and item["milestone_recovery"]["route"]["recovery"] == target
        record = next(iter(manager.state["milestone_orders"][host.order]["recovery"].values()))
        assert record["run"] == 123 and record["target"] == target

    with owned(routes["F6"]) as (host, manager, restart):
        host.change_after_read = True
        manager.tick()
        assert not host.effects
        host.policy, host.route, host.attention = "manager_recovery", routes["F6"], routes["F6"]
        host.lost = True
        manager.tick()
        assert len(host.effects) == 1 and host.effects[0]["expected_policy"] == "manager_recovery"
        manager = restart()
        manager.tick()
        assert len(host.effects) == 1
        host.history = [{"id":44,"attempt":1,"status":"fixed","decision":"manager_retry","decided_at":"2026-11-27"}]
        host.route = host.attention = {**host.route, "check":99, "action":"wait", "owner":"none"}
        manager.tick()
        assert next(iter(manager.state["milestone_orders"][host.order]["retries"].values()))["check"] == 99

    with owned(routes["R2"]) as (host, manager, _):
        host.attention = {**host.route, "recovery":{**host.route["recovery"],"commit":"b"*40}}
        manager.tick()
        ledger = manager.state["milestone_orders"][host.order]
        assert not ledger["recovery"] and not host.effects
        host.route = host.attention = {**host.route, "action":"hold", "owner":"none", "reason":"Connect a local executor."}
        host.route.pop("recovery")
        host.pending_work = True
        manager.tick()
        assert list(ledger["prerequisites"].values()) == ["Connect a local executor."] and len(host.turns) == 1
        assert not ledger["questions"]

    for policy in ("future_policy","ask","hold","pass_on_story_tests"):
        with owned(routes["R1"]) as (host, manager, _):
            host.policy = policy
            manager.tick()
            ledger = manager.state["milestone_orders"][host.order]
            assert not ledger["recovery"] and not host.effects and not ledger["questions"]


def held_observation():
    from copy import deepcopy
    from unittest.mock import patch
    import time

    routes = {row["id"]: row["route"] for row in CASES}
    route = routes["R1"]
    order, target = route["order"], route["recovery"]

    class Observer(Host):
        cursor = 1
        offline = None

        def tool(self, name, **args):
            if name == self.offline:
                self.calls.append(name)
                raise API["Hold"]("Fixture read unavailable.")
            if name == "factory_events":
                self.calls.append(name)
                assert args["factory"] == FACTORY and args["workflow"] == WORKFLOW and args["limit"] == 50
                assert args.get("after", 0) <= self.cursor
                return {"last_event": self.cursor, "events": []}
            return super().tool(name, **args)

        def call(self, name, params):
            self.calls.append(name)
            if name in ("thread/resume", "thread/turns/list"):
                assert params["threadId"] == "waiting-thread"
                return {"thread": {"id": "waiting-thread"}} if name == "thread/resume" else {"data": []}
            return super().call(name, params)

    with tempfile.TemporaryDirectory() as scratch:
        folder = Path(scratch)
        host = Observer(order, route)
        host.folder, host.policy = folder, "manager_recovery"
        config = dict(running=True, cwd=scratch, factory=FACTORY, workflow=WORKFLOW,
                      manage_ready=True, stories=[])
        API["save"](folder/"control.json", config)
        API["save"](folder/"status.json", {"cursor": 0, "notices": {"mine:"+order+":1": {"confirmation": "confirmed"}}})
        restart = lambda: API["Manager"](folder, config, host)
        manager = restart()
        manager.tick()  # An ordinary eligible tick recorded this exact proof target.
        ledger = manager.state["milestone_orders"][order]
        proof_key = next(iter(ledger["recovery"]))
        assert ledger["recovery"][proof_key]["target"] == target
        fix = routes["R2"]["recovery"]
        ledger["recovery"]["prior-fix"] = dict(target=fix, state="pending", check=42)
        host.fixes = [{"item_id": fix["item"], "check_id": 42, "card": {"public_id": fix["story"]}, "state": "finished"}]
        ledger["questions"]["old"] = "An earlier review"
        ledger["retries"]["uncertain"] = {"requested": 39, "state": "pending"}
        manager.holds["ready:122"] = 1
        manager.state["notices"]["unacknowledged"] = {"confirmation": "awaiting_receipt"}
        active = dict(key="ready:123", thread="waiting-thread", at=int(time.time()),
                      item={"story": "ready", "run": 123}, git={"claim": "awaiting_receipt"})
        manager.state.update(local_tokens_used=100, active=deepcopy(active))
        manager.record("Fixture restart with a pending acknowledgement and an exhausted allowance.")
        host.route = host.attention = {**routes["F5"], "order": order}
        host.policy = "ask"
        host.pending_work = True
        host.receipts[target["member_story"], target["proof"]] = {
            "proof": target["proof"], "finished": True, "commands": [{"run": target["proof"], "name": "test",
            "verified": True, "commit": target["commit"], "status": "passed"}]}

        manager = restart()
        host.calls.clear()
        host.offline, host.cursor = "proof_result", 2
        with patch.object(time, "time", return_value=1100):
            manager.tick()
        ledger = manager.state["milestone_orders"][order]
        assert set(host.calls) == {"factory_events", "story_status", "work_orders", "needs_you", "proof_result", "thread/resume", "thread/turns/list"}
        assert ledger["read_pending"] and ledger["recovery"][proof_key]["state"] == "pending"
        assert ledger["recovery"]["prior-fix"]["state"] == "completed"
        assert not ledger["questions"] and not manager.holds and not manager.state["interaction_required"]
        assert manager.state["last_read"] == 1100 and manager.state["cursor"] == 2
        assert manager.state["phase"] == "awaiting_receipt" and manager.state["observation"] == "watching"
        host.calls.clear()
        manager.tick()
        assert host.calls == ["factory_events", "thread/turns/list"]  # Only the pending turn needs rechecking.

        # An event outage leaves the last good cursor/time intact; existing receipts can still arrive.
        manager = restart()
        last_read = manager.state["last_read"]
        host.calls.clear()
        host.offline = "factory_events"
        try:
            manager.tick()
            raise AssertionError("Event failure must hold scheduling")
        except API["Hold"] as error:
            manager.record(str(error))  # supervise() checkpoints failed ticks before reconnecting.
        assert manager.state["observation"] == "events_unavailable" and manager.state["last_read"] == last_read
        assert manager.state["milestone_orders"][order]["recovery"][proof_key]["state"] == "completed"
        host.offline, host.cursor = None, 3
        manager = restart()
        host.calls.clear()
        manager.tick()
        assert host.calls == ["factory_events", "work_orders", "needs_you", "thread/resume", "thread/turns/list"]
        assert manager.state["cursor"] == 3 and manager.state["local_tokens_used"] == 100
        assert manager.state["active"] == active and manager.state["notices"]["unacknowledged"]["confirmation"] == "awaiting_receipt"

        # Fresh observations continue while the same unrelated claim receipt is pending.
        ledger = manager.state["milestone_orders"][order]
        ledger["recovery"][proof_key]["state"] = "pending"
        host.route = host.attention = {**routes["F6"], "order": order}
        host.cursor += 1
        host.calls.clear()
        manager.tick()
        assert ledger["recovery"][proof_key]["state"] == "completed" and not host.effects
        assert ledger["retries"] == {"uncertain": {"requested": 39, "state": "pending"}}
        assert manager.state["active"] == active and not host.turns and manager.state["local_tokens_used"] == 100
        assert set(host.calls) == {"factory_events", "work_orders", "needs_you", "proof_result", "thread/turns/list"}

        assert manager.state["phase"] == "awaiting_receipt"
        # A long-lived, unreadable set must not monopolize a tick or starve the next receipt.
        manager.state["local_tokens_used"] = 100
        for proof in range(710, 715):
            pending = {**target, "proof": proof}
            key = proof_key.split(":repair:")[0] + ":repair:" + API["milestone_routes"].recovery_id(pending)
            ledger["recovery"][key] = dict(target=pending, check=route["check"], state="pending")
        pending = ledger["recovery"][key]
        host.receipts[target["member_story"], 714] = {"proof": 714, "finished": True, "commands": [
            {"run": 714, "name": "test", "verified": True, "commit": target["commit"], "status": "passed"}]}
        host.cursor += 1
        host.calls.clear()
        manager.tick()
        assert host.calls.count("proof_result") == 4 and pending["state"] == "pending"
        host.cursor += 1
        manager.tick()
        assert host.calls.count("proof_result") == 8 and pending["state"] == "completed"
