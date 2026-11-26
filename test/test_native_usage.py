import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from native_usage import completion_fence, turn_usage


class NativeUsage(unittest.TestCase):
    def test_budget_holds_dispatch_until_receipt_and_survives_restart(self):
        manager_type = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/codex-manager.py"))["Manager"]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = {"local_token_budget": 60}
            manager = manager_type(folder, config, None)
            self.assertIsNone(manager.local_budget_hold())
            manager.state["workers"]["story"] = {"thread": "own"}
            self.assertIn("still spending", manager.local_budget_hold())
            manager.state["workers"].clear()
            receipt = {"thread": "own", "turn": "assigned"}
            manager.state["usage_pending"] = {"own": {**receipt, "unavailable": True}}
            self.assertIn("verified native usage", manager.local_budget_hold())
            manager.config = {}
            self.assertIsNone(manager.local_budget_hold())
            manager.config = config
            delivered = {**receipt, "delivered": True, "usage": {"total_tokens": 66}}
            for answer in [delivered, {**receipt, "unavailable": True}, delivered]:
                manager.usage_results.put(answer)
                manager.report_usage()
            self.assertEqual(manager.state["local_tokens_used"], 66)
            manager.record("stopped")
            restored = manager_type(folder, config, None)
            self.assertIn("budget has been reached", restored.local_budget_hold())

    def test_finished_turn_isolated_from_adjacent_work_and_repeated_events(self):
        def event(kind, **payload):
            return {"type": "event_msg", "payload": {"type": kind, **payload}}

        def meter(n):
            return event("token_count", info={"total_token_usage": {
                "input_tokens": n * 10, "cached_input_tokens": n * 8, "output_tokens": n, "total_tokens": n * 11}})
        rows = [{"type": "session_meta", "payload": {"id": "own"}}, meter(3),
                event("task_started", turn_id="station"), meter(5), meter(5), meter(9),
                event("task_complete", turn_id="station"), meter(10)]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rollout.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            self.assertEqual(turn_usage(path, "own", "station"), {
                "input_tokens": 60, "output_tokens": 6, "cached_tokens": 48, "total_tokens": 66})
            self.assertIsNone(turn_usage(path, "other", "station"))
            self.assertIsNone(turn_usage(path, "own", "missing"))
            path.write_text("".join(json.dumps(row) + "\n" for row in rows[:-2]))
            self.assertIsNone(turn_usage(path, "own", "station"))

    def test_fence_requires_completed_tool_for_exact_assignment(self):
        item = {"type": "mcpToolCall", "server": "codebook", "tool": "complete_work",
                "status": "completed", "result": {}, "arguments": {"run": 70, "fence": 3}}
        self.assertEqual(completion_fence({"items": [item]}, 70), 3)
        self.assertIsNone(completion_fence({"items": [item]}, 7))
        self.assertIsNone(completion_fence({"items": [{**item, "status": "failed"}]}, 70))


if __name__ == "__main__":
    unittest.main()
