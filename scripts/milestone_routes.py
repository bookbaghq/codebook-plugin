"""Read the exact CodeBook milestone authority within an already owned order."""
import re
import json

OWNERS = {"wait": "none", "hold": "none", "settled": "none", "repair": "manager", "retry": "manager", "review": "person"}


def journal():
    return {"seen": [], "questions": {}, "retries": {}}


def positive(value):
    return type(value) is int and value > 0


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,70}", value) is not None


def recovery_id(target):
    if not isinstance(target, dict) or len(target) != 7 or not positive(target.get("member_item")) or not identifier(target.get("member_story")):
        return None
    if not isinstance(target.get("repository"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", target["repository"]):
        return None
    if not isinstance(target.get("commit"), str) or not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", target["commit"]):
        return None
    if target.get("kind") == "proof" and positive(target.get("proof")) and target.get("executor") in ("here", "runner"):
        return json.dumps(target, sort_keys=True, separators=(",", ":"))
    if target.get("kind") == "repair" and positive(target.get("item")) and identifier(target.get("story")):
        return json.dumps(target, sort_keys=True, separators=(",", ":"))
    return None


def decisions(view, attention, factory, order):
    out = {}
    if (view.get("order") != order or not re.fullmatch(r"wo[1-9]\d*", order)
            or not all(isinstance(attention.get(k), list) for k in ("for_manager", "for_person"))
            or not isinstance(view.get("milestones"), list)):
        return out
    work = view.get("work_order") or {}
    if not work or work.get("status") in ("done", "cancelled"):
        return out
    for milestone in view["milestones"]:
        if not isinstance(milestone, dict) or not isinstance(milestone.get("check"), dict):
            continue
        check = milestone["check"]
        if check.get("check_cannot_run") is not None and check["check_cannot_run"] not in ("ask", "hold", "pass_on_story_tests", "manager_recovery"):
            continue
        attempt = (check.get("latest") or {}).get("id")
        if type(attempt) is not int or attempt <= 0:
            continue
        rows = []
        for owner in ("manager", "person"):
            for row in attention["for_" + owner]:
                if not isinstance(row, dict) or row.get("kind") != "milestone_check":
                    continue
                target = row.get("route") or row
                if not isinstance(target, dict):
                    continue
                room = target.get("factory")
                room = room.get("factory") if isinstance(room, dict) else room
                number = target.get("check", target.get("check_id"))
                if room == factory and target.get("order") == order and type(number) is int and number == attempt:
                    rows.append((owner, row))
        policy = check.get("check_cannot_run")
        route = check.get("route")
        if policy == "manager_recovery" and not rows and isinstance(route, dict) and (
                route.get("factory") == factory and route.get("order") == order and route.get("check") == attempt
                and route.get("owner") == "none" and route.get("action") == "hold" and not route.get("recovery")
                and check.get("needs_person") is not True and isinstance(route.get("reason"), str) and route["reason"].strip()):
            out[f"{factory}:{order}:{attempt}:hold"] = (route, policy)
            continue
        if len(rows) != 1:
            continue
        owner, row = rows[0]
        if policy != "manager_recovery" and route is None and row.get("route") is None and owner == "person" and check.get("needs_person") is True and row.get("why"):
            route = dict(factory=factory, order=order, check=attempt, owner=owner, action="review", reason=row["why"])
        elif not isinstance(route, dict) or route != row.get("route"):
            continue
        action = route.get("action")
        target = recovery_id(route.get("recovery"))
        recovery = policy == "manager_recovery" and action == "repair" and target
        if ("recovery" in route and not recovery) or (action == "repair" and not recovery):
            continue
        if (route.get("owner") != owner or action not in ("retry", "review", "repair") or OWNERS.get(action) != owner
                or not isinstance(route.get("reason"), str) or not route["reason"].strip()
                or (type(check.get("needs_person")) is bool and check["needs_person"] != (action == "review"))
                or (action == "review" and row.get("on_you") is not True)):
            continue
        if action in ("retry", "repair") and (view.get("factory_paused") or work.get("paused") or (work.get("execution_limits") or {}).get("deadline_reached")):
            continue
        key = f"{factory}:{order}:{attempt}:{action}"
        out[key + (":" + target if target else "")] = (route, policy)
    return out


def recover(view, ledger):
    for milestone in view.get("milestones") or []:
        check = milestone.get("check") or {}
        history = check.get("history") or []
        for record in ledger["retries"].values():
            old = next((a for a in history if a.get("id") == record["requested"] and a.get("status") == "fixed"
                        and a.get("decision") == "manager_retry" and a.get("decided_at") and type(a.get("attempt")) is int), None)
            if old:
                successor = next((a for a in history + [check.get("latest") or {}] if a.get("attempt") == old["attempt"] + 1), {})
                if type(successor.get("id")) is int:
                    record.update(state="confirmed", actor="manager", check=successor["id"], at=old["decided_at"],
                                  decided_by_user_id=old.get("decided_by_user_id"), reason=old.get("retry_note"))


def confirmed(reply, route):
    actual = (reply.get("check") or {}).get("id")
    return (all(reply.get(field) == route[field] for field in ("factory", "order"))
            and reply.get("decision") == "retry" and reply.get("authority") == "manager"
            and reply.get("requested_check") == route["check"] and type(actual) is int and actual > 0
            and actual != route["check"] and (reply.get("started") or {}).get("check_id") == actual)


def fix_for(view, check, target):
    return next((fix for m in view.get("milestones", []) for fix in m.get("fixes", [])
                 if fix.get("check_id") == check and fix.get("item_id") == target["item"]
                 and (fix.get("card") or {}).get("public_id") == target["story"]), None)


def proof_outcome(target, reply):
    if reply.get("proof") != target["proof"] or reply.get("finished") is not True:
        return None
    for cmd in reply.get("commands") or []:
        if (cmd.get("run") == target["proof"] and cmd.get("name") == "test" and cmd.get("verified") is True
                and cmd.get("commit") == target["commit"] and cmd.get("status") in ("passed", "failed")):
            return "completed" if cmd["status"] == "passed" else "failed"
    return None
