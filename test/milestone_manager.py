"""Synthetic signed-in CodeBook transport for the real local manager reconciliation loop."""
import json
from pathlib import Path
import runpy
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT/"test/fixtures/milestone-check-routes.mjs").read_text().split("\n", 1)[1])


def exercise():
    api = runpy.run_path(str(ROOT/"scripts/codex-manager.py"))
    factory, workflow = "fixtureFactory", "wf1"
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

        def tool(self, name, **args):
            self.calls.append(name)
            scope = {"factory": {"factory": factory}, "workflow": {"workflow": workflow, "name": "Ship"}}
            if name == "factory_events":
                return {"events": [], "last_event": len(self.calls)}
            if name == "manager_brief":
                return {**scope, "you": {"may_run_here": True}, "settings": {"decision_mode": "ask"}}
            if name == "factory_operations":
                return {"snapshot": {"control": {"paused": False}}}
            if name == "list_my_work":
                return {"work": [{**scope, "story": "ready", "run": 123, "where": "here", "claimed": False}] if self.pending_work else []}
            if name == "story_status":
                return {**scope, "story": {"story": "ready"}, "run_location": "here", "run": {"run": 123},
                        "station": {"name": "QA", "worker": {"type": "agent", "name": "Jade"}},
                        "waiting": {"on": "runner", "run": 123, "on_you": True, "claimed": False}}
            if name == "work_orders":
                assert args == {"factory": factory, "order": self.order}
                r = self.route
                check = {"route": r, "needs_person": bool(self.legacy or r and r["owner"] == "person"),
                         "check_cannot_run": self.policy, "latest": {"id": r["check"] if r else 90, "attempt": 2}, "history": self.history}
                return {"order": self.order, "work_order": {"status": "open"},
                        "milestones": [{"milestone": 1, "check": check}]}
            if name == "needs_you":
                assert args == {"factory": factory}
                r = self.attention
                items = {"for_person": list(self.legacy), "for_manager": []}
                if r and r["owner"] != "none":
                    items["for_"+r["owner"]].append({"kind": "milestone_check", "route": r, "on_you": r["owner"] == "person"})
                if self.change_after_read:
                    self.change_after_read = False
                    self.route = {**self.route, "owner": "none", "action": "hold"}
                    self.policy = "hold"
                return items
            assert name == "decide_milestone_check"
            r = self.route
            assert args == {"decision": "retry", "authority": "manager", "factory": factory, "order": self.order,
                            "check": r["check"], "expected_policy": self.policy}
            assert json.loads((self.folder/"status.json").read_text())["milestone_orders"][self.order]["retries"]
            self.effects.append(args)
            if self.lost:
                raise api["Hold"]("Lost reply")
            return {**args, "requested_check": r["check"], "check": {"id": 99}, "started": {"check_id": 99}}

        def call(self, name, params):
            if name == "thread/start":
                return {"thread": {"id": "independent"}}
            assert name == "turn/start"
            self.turns.append(params["input"])
            return {"turn": {"id": "one"}}

    for case in CASES:
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
                host.legacy = [row]
                manager.tick()
                manager.tick()
                assert len(ledger["seen"]) == 1 and not host.effects
            elif label == "F1":
                host.pending_work = True
                manager.tick()
                assert len(host.turns) == 1 and "decide_milestone_check" not in host.calls


if __name__ == "__main__":
    exercise()
