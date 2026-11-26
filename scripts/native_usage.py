"""Read only native meter events for one supervisor-owned Codex station turn."""
import json
from pathlib import Path


def turn_usage(path, thread, turn):
    fields = {"input_tokens": "input_tokens", "output_tokens": "output_tokens",
              "cached_tokens": "cached_input_tokens", "total_tokens": "total_tokens"}
    previous = None
    baseline = None
    active = observed = matched = False
    with Path(path).open(encoding="utf8") as stream:
        for line in stream:
            prefix = line[:320]
            if '"session_meta"' in prefix and not matched:
                row = json.loads(line)
                if row.get("type") == "session_meta":
                    if row["payload"].get("id") != thread:
                        return None
                    matched = True
                continue
            if not matched or '"event_msg"' not in prefix or not any(
                    tag in prefix for tag in ('"token_count"', '"task_started"', '"task_complete"', '"turn_aborted"')):
                continue
            row = json.loads(line)
            if row.get("type") != "event_msg":
                continue
            msg = row.get("payload") or {}
            if msg.get("type") == "task_started":
                if active:
                    return None
                active = msg.get("turn_id") == turn
                if active:
                    baseline = previous or dict.fromkeys(fields, 0)
            elif msg.get("type") == "token_count":
                counts = (msg.get("info") or {}).get("total_token_usage") or {}
                if all(type(counts.get(key)) is int and counts[key] >= 0 for key in fields.values()):
                    previous = {key: counts[raw] for key, raw in fields.items()}
                    if active:
                        observed = True
            elif active and msg.get("turn_id") == turn and msg.get("type") in ("task_complete", "turn_aborted"):
                if not observed:
                    return None
                result = {key: previous[key] - baseline[key] for key in fields}
                if min(result.values()) < 0 or result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
                    return None
                return result
    return None


def completion_fence(turn, run):
    for item in turn.get("items", []):
        args = item.get("arguments")
        if (item.get("type") == "mcpToolCall" and item.get("server") == "codebook"
                and item.get("tool") == "complete_work" and item.get("status") == "completed"
                and not item.get("error") and not (item.get("result") or {}).get("isError")
                and isinstance(args, dict) and args.get("run") == run and type(args.get("fence")) is int):
            return args["fence"]
    return None
