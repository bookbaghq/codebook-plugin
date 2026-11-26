"""Disposable native operator and two independent, stateless local Git upstreams."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


def git(cwd, *args, data=None):
    return subprocess.run(["git", "-C", str(cwd), *args], input=data, capture_output=True, check=True).stdout


def rejected(code, fn):
    try:
        fn()
    except code:
        return
    raise AssertionError("Expected the scoped operation to be held.")


def exercise(api):
    native, manager_type = api["paired_git"], api["Manager"]
    scope = {"factory": "test-factory", "workflow": "wf1"}
    branch = "codebook/SD-12"
    signer = """
const c=require('node:crypto'),fs=require('node:fs');
const [op,file]=process.argv.slice(1);
if(op==='enroll'&&!fs.existsSync(file))fs.writeFileSync(file,c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const key=c.createPrivateKey(fs.readFileSync(file)), pub=c.createPublicKey(key);
if(op==='sign')process.stdout.write(c.sign(null,fs.readFileSync(0),key).toString('base64'));
else if(op==='verify')process.exit(c.verify(null,fs.readFileSync(0),pub,Buffer.from(process.argv[3],'base64'))?0:1);
else process.stdout.write(pub.export({format:'der',type:'spki'}).subarray(-32).toString('base64'));
"""
    with tempfile.TemporaryDirectory(prefix="paired-git-") as tmp:
        root = Path(tmp).resolve()
        keys = root/"operator"
        keys.mkdir(mode=0o700)
        control = {**scope, "running": True, "development_routes": {}, "git_pairings": {}}
        live, workers, challenges, records = {}, {}, {}, []
        deny = {}
        def device(op, selected_scope, route, data=b"", expected=None):
            path = keys/native.account(selected_scope, route)
            if op != "enroll" and not path.exists():
                raise native.Unavailable("Missing fixture device.")
            argv = ["node", "-e", signer, op, str(path)]
            return subprocess.check_output(argv, input=data).decode()
        for i, repo in enumerate(("org/app", "org/plugin"), 12):
            short = repo.split("/")[1]
            upstream, source, clone = root/(short+".git"), root/(short+"-source"), root/short
            git(root, "init", "-q", "--bare", "--initial-branch=main", str(upstream))
            git(root, "init", "-q", "--initial-branch=main", str(source))
            def commit(cwd, filename, content):
                (cwd/filename).write_text(content)
                git(cwd, "add", filename)
                git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", filename)
            commit(source, "base", repo)
            git(source, "push", "-q", str(upstream), "main")
            git(root, "clone", "-q", "--no-local", str(upstream), str(clone))
            git(clone, "remote", "set-url", "origin", "https://github.com/"+repo+".git")
            worktree = clone/"run"
            git(clone, "worktree", "add", "-qb", branch, str(worktree))
            commit(source, "next", short)
            git(source, "push", "-q", str(upstream), "main")
            route = {"repository":repo, "checkout":str(clone), "permissions":"fixture", "revision":1}
            public = device("enroll", scope, route)
            saved = native.public_fields(route, public)
            assert public == device("enroll", scope, route) and len(base64.b64decode(public)) == 32
            control["development_routes"][repo] = route
            control["git_pairings"][repo] = saved
            row = {**route, "git_pairing":saved}
            live[short] = {"factory":{"factory":scope["factory"]}, "workflow":{"workflow":scope["workflow"]},
                "story":{"story":short}, "station":{"name":"Development"},
                "run":{"run":i, "where":"here"}, "run_location":{"where":"here", "person":{"is_you":True}},
                "waiting":{"on":"runner", "run":i, "on_you":True, "claimed":False},
                "working_on":{"work":[{"source":"declared", "run":i, "repository":repo,
                "branch":branch, "worktree":str(worktree)}]}}
            workers[short+":"+str(i)] = {"thread":short, "turn":"turn-"+short, "story":short, "run":i, "route":row}
        assert control["git_pairings"]["org/app"]["public_key"] != control["git_pairings"]["org/plugin"]["public_key"]
        api["save"](root/"control.json", control)
        class Observer:
            def tool(self, name, **args):
                if name == "manager_brief":
                    return {"factory":{"factory":scope["factory"]}, "workflow":{"workflow":scope["workflow"]},
                        "you":{"may_run_here":True,"local_code":{"repositories":[{"repository":r, "git_transport":v}
                               for r,v in control["git_pairings"].items() if r != deny.get("revoked")]}}}
                assert name == "story_status"
                return live[args["story"]]
        class Host:
            paired_isolated = True
            def tool_in(self, thread, name, **args):
                s = live[thread]
                if name == "claim_work":
                    assert args == {"run":s["run"]["run"]} and not s["waiting"]["claimed"]
                    s["waiting"]["claimed"] = True
                    s["run"]["claim"] = {"fence":9, "expired":False, "by":{"is_you":True}}
                    return {"run":args["run"], "story":thread, "where":"here", "lease":{"fence":9}, "brief":{"station":"Development"}}
                assert name == "prepare_run_here_git" and args["fence"] == s["run"]["claim"]["fence"]
                oid = secrets.token_hex(16)
                challenge = {**args, "operation_id":oid, "nonce":secrets.token_hex(16), "url":native.ORIGIN+oid,
                        "expires_at":int(time.time()*1000)+90000, "ref":"refs/heads/"+branch}
                challenge.update(deny.get("tamper", {}))
                challenges[oid] = challenge
                return challenge
        def send(url, data, headers, content_type, timeout):
            assert url.startswith(native.ORIGIN) and 0 < timeout <= 120
            ch = challenges.pop(url.split("/")[-1])
            repo = ch["repository"]
            route = control["development_routes"][repo]
            digest = hashlib.sha256(data).hexdigest()
            assert digest == headers["X-CodeBook-Git-Digest"]
            if deny.get("replay") and ch["operation"] == "push_pack":
                raise native.Unavailable("Lost upstream receipt")
            message = ["codebook-run-here-git-v1", ch["operation_id"], ch["nonce"], ch["run"], ch["fence"], repo,
                       ch["clone"], ch["worktree"], ch["operation"], "", digest]
            subprocess.run(["node", "-e", signer, "verify", str(keys/native.account(scope, route)), headers["X-CodeBook-Git-Signature"]],
                    input=json.dumps(message,separators=(",", ":")).encode(), check=True)
            op = ch["operation"]
            service = "upload-pack" if op.startswith("fetch") else "receive-pack"
            assert content_type == "application/x-git-"+service+("-advertisement" if op.endswith("advertise") else "-result")
            upstream = root/(repo.split("/")[1]+".git")
            argv = ["git", service, "--stateless-rpc"]
            records.append((repo, op))
            tip = None
            if op.endswith("advertise"):
                assert not data
                reply = native.pkt(b"# service=git-"+service.encode()+b"\n")+b"0000"+subprocess.check_output([*argv, "--advertise-refs", str(upstream)])
            else:
                reply = subprocess.check_output([*argv, str(upstream)], input=data, stderr=subprocess.DEVNULL)
                if op == "push_pack":
                    tip = git(upstream, "rev-parse", ch["ref"]).decode().strip()
            receipt = {k:ch[k] for k in ("repository", "ref", "run", "fence")}
            receipt.update(outcome="done", commit=tip)
            receipt.update(deny.get("receipt", {}))
            return reply, base64.urlsafe_b64encode(json.dumps(receipt).encode()).decode().rstrip("=")
        real_exchange = native.exchange
        def exchange(*args):
            return real_exchange(*args, signer=device, send=send)
        real_bounded = native.bounded
        def sandbox(argv, data, limit, cwd, env):
            assert "-P" in argv and argv[argv.index("-P")+1] == "fixture" and "-C" in argv and not (set(env) & {"CODEX_API_KEY", "GITHUB_TOKEN"})
            assert str(keys) not in str(argv)
            return real_bounded(argv[argv.index("--")+1:], data, limit, cwd, env)
        manager = manager_type(root, control, Observer())
        manager.state["workers"] = workers
        host = Host()
        def action(story, name, **change):
            worker = next(w for w in manager.state["workers"].values() if w["story"] == story)
            params = {"threadId":worker["thread"], "turnId":worker["turn"], "tool":"factory_git_"+name, "arguments":{}, "callId":secrets.token_hex(8)}
            return manager.worker_git(manager.route_key(worker["route"]), host, {**params, **change})
        with patch.object(native, "device", device), patch.object(native, "exchange", exchange), patch.object(native, "bounded", sandbox):
            for short in ("app","plugin"):
                assert action(short, "claim")["lease"]["fence"] == 9
                rejected(native.Unavailable, lambda: action(short, "claim"))
            manager.record("checkpoint")
            manager = manager_type(root, api["read"](root/"control.json",{}), Observer())
            assert set(manager.config["git_pairings"]) == {"org/app", "org/plugin"}
            rejected(native.Unavailable, lambda: action("app","fetch", turnId="another"))
            live["app"]["run"]["claim"]["fence"] = 10
            rejected(native.Unavailable, lambda: action("app","fetch"))
            live["app"]["run"]["claim"]["fence"] = 9
            for field, value in (("ref","refs/heads/foreign"), ("url","https://other.invalid/"), ("clone",str(root/"plugin"))):
                deny["tamper"] = {field:value}
                rejected(native.Unavailable, lambda: action("app","fetch"))
            deny.clear()
            deny["revoked"] = "org/app"
            rejected(native.Unavailable, lambda: action("app","fetch"))
            deny.clear()
            assert not records
            import queue
            host.git_requests = queue.Queue()
            responses = []
            host.send = responses.append
            plugin_worker = manager.state["workers"]["plugin:13"]
            manager.development_hosts[manager.route_key(plugin_worker["route"])] = host
            host.git_requests.put({"id":10, "params":{"threadId":"plugin", "turnId":"mismatch", "tool":"factory_git_fetch",
                                   "arguments":{}, "callId":"fixture-callback"}})
            manager.service_git()
            assert responses[0]["id"] == 10 and responses[0]["result"]["success"] is False and not records
            deny["receipt"] = {"run":1024}
            rejected(native.Unavailable, lambda: action("app","fetch"))
            assert records == [("org/app", "fetch_advertise")]
            deny.clear()
            for short in ("plugin","app"):
                receipt = action(short,"fetch")
                work = root/short/"run"
                assert set(receipt) == {"repository","ref","run","fence","outcome","commit"}
                assert receipt["outcome"] == "fetched" and git(work,"rev-parse","refs/remotes/origin/main").decode().strip() == receipt["commit"]
                git(work, "merge", "--ff-only", "-q", "origin/main")
                commit(work, "feature", short+" feature")
                assert action(short, "push")["outcome"] == "pushed"
                assert git(root/(short+".git"),"rev-parse","refs/heads/"+branch) == git(work, "rev-parse", "HEAD")
            work = root/"app"/"run"
            git(work,"reset","--hard","-q","origin/main")
            rejected(native.Unavailable, lambda: action("app","push"))
            work = root/"plugin"/"run"
            commit(work, "later", "next")
            deny["replay"] = True
            rejected(native.Unavailable, lambda: action("plugin","push"))
            previous = len(records)
            deny.clear()
            rejected(native.Unavailable, lambda: action("plugin","push"))
            assert len(records) == previous and manager.state["run_holds"]
            (keys/native.account(scope,control["development_routes"]["org/app"])).unlink()
            rejected(native.Unavailable, lambda: action("app","fetch"))
            assert action("plugin","fetch")["outcome"] == "fetched"
            assert "PRIVATE KEY" not in (root/"status.json").read_text()
