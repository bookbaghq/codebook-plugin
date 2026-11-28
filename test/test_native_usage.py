import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from native_usage import completion_fence, turn_usage


class NativeUsage(unittest.TestCase):
    def test_upgrade_preserves_receipts_fences_and_uncertain_operations(self):
        manager_type = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/codex-manager.py"))["Manager"]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            settled = {"run": 20, "wake": "past:20", "settled": True, "gross": 66}
            uncertain = {"run": 21, "wake": "open:21:expiry:4", "pending": {"write": {"fence": 3}}}
            stop = {"limit": 60, "overrun": 6}
            receipt = {"thread": "new", "turn": "new-turn", "run": 22, "fence": 4}
            state = {"cursor": 55, "notices": {}, "run_holds": {"other:23": 10},
                     "workers": {"past:20": {"run": 20, "thread": "old", "native_fence": 2}},
                     "local_tokens_used": 66, "budget_stop": stop,
                     "budget_turns": {"old": {"paid": settled}, "pending": {"write": uncertain}},
                     "usage_pending": {"new": {**receipt, "unavailable": True}}}
            (folder/"status.json").write_text(json.dumps(state))
            manager = manager_type(folder, {}, None)
            self.assertEqual(manager.state["previous_token_trial"], {"stop": stop, "turns": state["budget_turns"]})
            self.assertNotIn("budget_stop", manager.state)
            self.assertEqual(manager.state["workers"], state["workers"])
            self.assertEqual(manager.state["cursor"], 55)
            self.assertEqual(manager.holds["other:23"], 10)
            self.assertIn("open:21", manager.holds)
            manager.queue_usage(state["workers"]["past:20"], {"id": "paid"})
            self.assertEqual(manager.state["usage_pending"], state["usage_pending"])
            delivered = {**receipt, "delivered": True, "usage": {"total_tokens": 14}}
            for answer in [{**delivered, "run": 21}, delivered, delivered]:
                manager.usage_results.put(answer)
                manager.report_usage()
            manager.record("Recorded receipt")
            restored = manager_type(folder, {}, None)
            self.assertEqual(restored.state["local_tokens_used"], 80)
            self.assertEqual(restored.state["usage_pending"], {})
            self.assertEqual(manager.holds, restored.holds)

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
            unmetered = [rows[0], event("task_started", turn_id="previous"), event("task_complete", turn_id="previous"), *rows[2:]]
            path.write_text("".join(json.dumps(row) + "\n" for row in unmetered))
            self.assertIsNone(turn_usage(path, "own", "station"))
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
