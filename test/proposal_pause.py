"""Exercise the local supervisor's confirmation journal using offline CodeBook replies."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

manager = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/codex-manager.py"))
CONFIG = {"factory": "factoryA", "workflow": "wf2", "stories": [], "manage_ready": True}
ITEM = {"key": "storyA:wo3:7", "story": "storyA", "proposal": "wo3", "item": 7, "run": 0}
SCOPE = {"factory": {"factory": "factoryA"}, "workflow": {"workflow": "wf2", "name": "Software"}}


class LocalHost(manager["Host"]):
    def __init__(self):
        self.observer = "fixture"
        self.paused = False
        self.ready = True
        self.refusal = None
        self.submissions = 0

    def call(self, method, params):
        assert method == "mcpServer/tool/call"
        tool = params["tool"]
        if tool == "manager_brief":
            row = {"story": "storyA", "workflow": "Software", "ready": self.ready,
                   "proposal": {"proposal": "wo3", "item": 7},
                   "start_with": 'confirm_stories { proposal: "wo3", stories: [7], decided_by: "manager" }'}
            data = {**SCOPE, "you": {"may_run_here": True}, "backlog": {"stories": [row]}}
        elif tool == "factory_operations":
            data = {"snapshot": {"control": {"paused": self.paused}}}
        elif tool == "list_my_work":
            data = {"work": []}
        elif tool == "story_status":
            data = {**SCOPE, "story": {"story": "storyA"}, "in_backlog": True, "run_location": "here"}
        elif tool == "confirm_stories":
            self.submissions += 1
            if self.refusal:
                return self.refusal
            data = {"proposal": {"proposal": "wo3"}, "decided_by": "manager",
                    "created": [{"story": "storyA", "item": 7, "run_location": "here",
                                 "from_backlog": True, "moved_by_hand": False}]}
        else:
            raise AssertionError(tool)
        return {"structuredContent": data}


class ProposalPause(unittest.TestCase):
    def test_definite_pause_rechecks_readiness_after_restart(self):
        payload = {"error": {"code": "CONFLICT", "goes_alone": {"next_action": "wait_for_resume"}}}
        for refusal in ({"structuredContent": payload}, {"content": [{"type": "text", "text": json.dumps(payload)}]}):
            with self.subTest(refusal=refusal), tempfile.TemporaryDirectory() as temp:
                host = LocalHost()
                host.refusal = {"isError": True, **refusal}
                supervisor = manager["Manager"](Path(temp), CONFIG, host)
                entry = supervisor.state["notices"].setdefault(ITEM["key"], {"attempts": 0})
                supervisor.confirm(ITEM, entry)
                self.assertNotIn("confirmation", entry)
                self.assertFalse(supervisor.state["interaction_required"])

                supervisor = manager["Manager"](Path(temp), CONFIG, host)
                entry = supervisor.state["notices"][ITEM["key"]]
                self.assertNotIn("confirmation", entry)
                host.refusal, host.paused = None, True
                supervisor.confirm(ITEM, entry)
                host.paused, host.ready = False, False  # Resumed with this item now person-owned.
                supervisor.confirm(ITEM, entry)
                self.assertEqual(host.submissions, 1)
                host.ready = True  # Only fresh manager eligibility allows the next submission.
                supervisor.confirm(ITEM, entry)
                self.assertEqual(host.submissions, 2)
                self.assertEqual(entry["confirmation"], "confirmed")
                self.assertEqual(supervisor.state["adopted"], ["storyA"])

    def test_ambiguous_refusals_preserve_pending_receipt(self):
        for error in ({"code": "FORBIDDEN", "goes_alone": {"next_action": "wait_for_resume"}},
                      {"code": "CONFLICT"}, {"code": "CONFLICT", "goes_alone": {"next_action": "ask_person"}}):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as temp:
                host = LocalHost()
                host.refusal = {"isError": True, "structuredContent": {"error": error}}
                supervisor = manager["Manager"](Path(temp), CONFIG, host)
                entry = supervisor.state["notices"].setdefault(ITEM["key"], {"attempts": 0})
                with self.assertRaises(manager["Hold"]):
                    supervisor.confirm(ITEM, entry)
                self.assertEqual(entry["confirmation"], "awaiting_receipt")
                self.assertFalse(supervisor.state["adopted"])


if __name__ == "__main__":
    unittest.main()
