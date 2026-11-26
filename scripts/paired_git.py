"""Fenced native Git smart HTTP for a person's paired Development clone."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time
from urllib.parse import urlsplit

SERVICE = "work.codebook.local-git.device.v1"
ORIGIN = "https://app.codebook.work/kanban/api/run-here-git/"
LIMIT = 16 * 1024 * 1024
REPLY_LIMIT = 64 * 1024 * 1024
SHA = re.compile(rb"[0-9a-f]{40}")
REF = re.compile(r"refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,228}")
TOOLS = {"factory_git_claim": "Claim this thread's assigned Development station and return its frozen brief.",
         "factory_git_fetch": "Fetch the paired repository default and declared feature branch.",
         "factory_git_push": "Publish the declared feature branch with a fast-forward check."}


class Unavailable(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Unavailable(message)


def account(scope, route):
    identity = [scope["factory"], scope["workflow"], route["repository"], route["checkout"]]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()


def public_fields(route, public):
    try:
        raw = base64.b64decode(public, validate=True)
    except (ValueError, TypeError):
        raw = b""
    require(len(raw) == 32, "The protected device signer returned an invalid public key.")
    return {"repository": route["repository"], "clone": route["checkout"],
            "public_key": public, "fingerprint": hashlib.sha256(raw).hexdigest()}


def device(action, scope, route, data=b"", expected=None):
    require(sys.platform == "darwin", "Paired Git requires a protected Mac device signer on this host.")
    argv = ["/usr/bin/swift", str(Path(__file__).with_name("git-device-key.swift").resolve()),
            action, account(scope, route)]
    if expected:
        argv.append(expected)
    env = {k: os.environ[k] for k in ("HOME", "USER", "TMPDIR") if k in os.environ}
    try:
        child = subprocess.run(argv, cwd="/", env={**env, "PATH": "/usr/bin:/bin"},
                               input=data, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise Unavailable("The native Swift device signer is unavailable.") from None
    require(child.returncode == 0, "The protected clone signing key is unavailable; inspect its operator pairing.")
    return child.stdout.decode("ascii").strip()


# A metadata-only lookup. It never requests password data or allows Keychain UI.
KEY_STATUS = """
import ctypes, errno, os, sys, tempfile
sec = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
if sec.SecKeychainSetUserInteractionAllowed(False) != 0:
    sys.exit(1)
service, account = (v.encode("ascii") for v in sys.argv[1:3])
for path in sys.argv[3:]:
    try:
        if os.path.isdir(path):
            with tempfile.NamedTemporaryFile(dir=path, prefix=".codebook-isolation-"):
                pass
        else:
            os.close(os.open(path, os.O_WRONLY | os.O_NOFOLLOW))
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.EROFS):
            continue
        sys.exit(1)
    sys.exit(2)
print(sec.SecKeychainFindGenericPassword(None, len(service), service, len(account), account, None, None, None))
"""


def isolated_key(host, scope, route):
    args = [sys.executable, "-I", "-c", KEY_STATUS, SERVICE, account(scope, route)]
    try:
        control = subprocess.run(args, cwd="/", capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        raise Unavailable("The operator's device key isolation could not be checked.") from None
    require(control.returncode == 0 and control.stdout.strip() == b"0", "The operator cannot verify the protected device item.")
    base = Path(__file__).resolve().parent
    state = Path(scope["state_directory"]).resolve()
    protected = [base, base/"codex-manager.py", base/"paired_git.py", base/"git-device-key.swift",
                 state, state/"control.json", state/"status.json"]
    response = host.call("command/exec", {"command": [*args, *map(str, protected)], "cwd": route["checkout"], "permissionProfile": route["permissions"],
                                        "timeoutMs": 5000, "outputBytesCap": 128})
    # Check the same named item with the same process, under the actual worker profile.
    # A denied executable, parse error or arbitrary failure cannot establish isolation.
    require(response.get("exitCode") == 0 and response.get("stdout", "").strip() in
            {"-25300", "-25308", "-25291", "-34018"}, "The worker profile could not establish isolation from the device key.")


def match_binding(route, saved, brief):
    local = brief.get("local_code") or (brief.get("you") or {}).get("local_code") or {}
    rows = [r for r in local.get("repositories", []) if (r.get("git_transport") or {}).get("clone") == route["checkout"]]
    require(len(rows) == 1 and (rows[0].get("repository") or rows[0].get("name") or "").lower() == route["repository"],
            "Pair this exact clone and repository in Your computer.")
    live = rows[0]["git_transport"]
    require(saved and all(saved.get(k) == v for k, v in public_fields(route, live.get("public_key")).items())
            and live.get("fingerprint") == saved["fingerprint"], "The recorded device pairing differs from Your computer.")


def check_ref(ref):
    require(isinstance(ref, str) and REF.fullmatch(ref) and ".." not in ref and "@{" not in ref
            and not ref.endswith((".", "/")) and all(x and not x.startswith(".") and not x.endswith(".lock")
            for x in ref.split("/")), "The declared branch is invalid.")
    return ref


def declaration(status, assignment, fence, route):
    current, here = status.get("run") or {}, status.get("run_location") or {}
    claim = current.get("claim") or {}
    require(status.get("factory", {}).get("factory") == assignment["factory"]
            and status.get("workflow", {}).get("workflow") == assignment["workflow"]
            and status.get("story", {}).get("story") == assignment["story"]
            and status.get("station", {}).get("name") == "Development"
            and isinstance(here, dict) and here.get("where") == "here" and (here.get("person") or {}).get("is_you") is True
            and current.get("run") == assignment["run"] and current.get("where") == "here"
            and claim.get("fence") == fence and claim.get("expired") is False and (claim.get("by") or {}).get("is_you") is True,
            "The assigned local Development lease is no longer current.")
    rows = [r for r in (status.get("working_on") or {}).get("work", []) if r.get("source") == "declared"
            and r.get("run") == current["run"] and r.get("repository") == route["repository"]]
    require(len(rows) == 1, "Declare the one assigned repository, worktree and branch before using paired Git.")
    row = rows[0]
    name = row.get("worktree")
    require(isinstance(name, str) and Path(name).is_absolute(), "The declared per-run worktree is missing.")
    path, clone = Path(name), Path(route["checkout"])
    require(str(path.resolve(strict=True)) == name and str(clone.resolve(strict=True)) == route["checkout"]
            and clone in path.parents and (path/".git").is_file(), "The worktree must be inside the exact paired clone.")
    return {"run": current["run"], "fence": fence, "repository": route["repository"], "clone": str(clone),
            "worktree": name, "ref": check_ref("refs/heads/" + (row.get("branch") or ""))}


def post(url, data, headers, expected_type, timeout):
    # A dedicated TLS connection has no environment proxy, cookies, redirects or credential helper.
    target = urlsplit(url)
    require(target.netloc == "app.codebook.work" and target.scheme == "https" and not target.query and not target.fragment
            and re.fullmatch("/kanban/api/run-here-git/[0-9a-f]{32}", target.path), "Invalid private Git transfer URL.")
    deadline = time.monotonic()+timeout
    conn = http.client.HTTPSConnection(target.hostname, timeout=timeout)
    try:
        conn.request("POST", target.path, body=data, headers=headers)
        sock = conn.sock
        reply = conn.getresponse()
        require(reply.status == 200 and reply.headers.get_content_type() == expected_type,
                "CodeBook refused or could not confirm the assigned Git transfer.")
        body = bytearray()
        while True:
            remaining = deadline-time.monotonic()
            require(remaining > 0, "The Git transfer expired.")
            sock.settimeout(remaining)
            chunk = reply.read1(min(65536, REPLY_LIMIT+1-len(body)))
            if not chunk:
                return bytes(body)
            body.extend(chunk)
            require(len(body) <= REPLY_LIMIT, "The private Git response exceeds the native size limit.")
    except (OSError, http.client.HTTPException, ValueError):
        raise Unavailable("The private Git transfer was interrupted; inspect its recorded outcome.") from None
    finally:
        conn.close()


def exchange(scope, route, binding, boundary, op, body, prepare, public, send=post, signer=device):
    require(op in {"fetch_advertise", "fetch_pack", "push_advertise", "push_pack"}
            and len(body) <= LIMIT and (not op.endswith("advertise") or not body), "Invalid or oversized Git operation.")
    args = {k: boundary[k] for k in ("run", "fence", "repository", "clone", "worktree")}
    args.update(operation=op, protocol="")
    auth = prepare(**args)
    oid, nonce = auth.get("operation_id"), auth.get("nonce")
    require(all(isinstance(v, str) and re.fullmatch("[0-9a-f]{32}", v) for v in (oid, nonce)),
            "CodeBook did not return a valid one-use Git challenge.")
    now = time.time()*1000
    expiry = auth.get("expires_at")
    require(all(auth.get(k) == v for k, v in {**args, "ref": boundary["ref"]}.items())
            and auth.get("url") == ORIGIN+oid and type(expiry) in (int, float) and now < expiry <= now+121000,
            "The Git challenge does not match the assigned operation or has expired.")
    require(binding["public_key"] == public, "The device identity changed.")
    digest = hashlib.sha256(body).hexdigest()
    fields = ["codebook-run-here-git-v1", oid, nonce, args["run"], args["fence"], args["repository"],
              args["clone"], args["worktree"], op, "", digest]
    signed = signer("sign", scope, route, json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode(), public)
    require(len(base64.b64decode(signed, validate=True)) == 64, "The device signature is invalid.")
    remaining = (expiry - time.time()*1000)/1000
    require(remaining > 0, "The one-use Git challenge expired before transfer.")
    service = "upload-pack" if op.startswith("fetch_") else "receive-pack"
    content = "application/x-git-"+service+("-advertisement" if op.endswith("advertise") else "-result")
    return send(ORIGIN+oid, body, {"Content-Type":"application/octet-stream", "X-CodeBook-Git-Digest":digest,
                "X-CodeBook-Git-Signature":signed}, content, min(120, remaining))


def pkt(data):
    require(len(data) <= 65516, "Invalid Git packet size.")
    return ("%04x" % (len(data)+4)).encode() + data


def packets(data):
    at = 0
    while at < len(data):
        header = data[at:at+4]
        require(bool(re.fullmatch(rb"[0-9a-fA-F]{4}", header)), "Invalid smart HTTP packet.")
        size = int(header, 16)
        require(size == 0 or 4 < size <= 65520, "Invalid smart HTTP packet size.")
        at += 4
        if not size:
            yield None
        else:
            end = at+size-4
            require(end <= len(data), "Truncated smart HTTP response.")
            yield data[at:end]
            at = end


def refs(advert, service, assigned):
    lines = iter(packets(advert))
    require(next(lines, b"") == b"# service=git-"+service+b"\n" and next(lines, b"bad") is None,
            "The upstream did not advertise the expected Git service.")
    entries = {}
    caps = []
    for line in lines:
        if line is None:
            break
        ref, sep, offered = line.rstrip(b"\n").partition(b"\0")
        if sep:
            caps = offered.split()
        oid, _, name = ref.partition(b" ")
        if SHA.fullmatch(oid):
            entries[name.decode("ascii")] = oid
    default = next((v[12:].decode("ascii") for v in caps if v.startswith(b"symref=HEAD:")), None)
    if not default:
        # receive-pack v0 often omits the HEAD symref. Use only server-filtered refs, and demand uniqueness.
        other = [n for n in entries if n.startswith("refs/heads/") and n != assigned]
        default = other[0] if len(other) == 1 else None
    check_ref(default)
    require(default != assigned and default in entries, "The assigned feature/default branch is missing or protected.")
    return default, {r: entries[r] for r in (default, assigned) if r in entries}, caps


def bounded(argv, data, limit, cwd, env):
    """Accept bounded stdin/stdout over private pipes, including packs, outside the model process."""
    with subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, start_new_session=True) as proc, selectors.DefaultSelector() as sel:
        import signal
        end, at, out = time.monotonic()+110, 0, bytearray()
        try:
            sel.register(proc.stdout, selectors.EVENT_READ)
            if data:
                sel.register(proc.stdin, selectors.EVENT_WRITE)
            else:
                proc.stdin.close()
            while sel.get_map():
                remaining = end-time.monotonic()
                require(remaining > 0, "The local Git operation timed out.")
                for key, _ in sel.select(remaining):
                    if key.fileobj == proc.stdin:
                        at += os.write(proc.stdin.fileno(), data[at:at+4096])
                        if at == len(data):
                            sel.unregister(proc.stdin)
                            proc.stdin.close()
                    else:
                        chunk = os.read(proc.stdout.fileno(), 65536)
                        if chunk:
                            out.extend(chunk)
                            require(len(out) <= limit, "The local Git operation exceeds its size limit.")
                        else:
                            sel.unregister(proc.stdout)
            require(proc.wait(timeout=max(.1, end-time.monotonic())) == 0, "Git refused the local checkout or branch operation.")
            return bytes(out)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)


IMPORT_BUNDLE = """
import os, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(dir=sys.argv[1]) as folder:
    name = os.path.join(folder, "transfer.bundle")
    with open(name, "xb") as bundle:
        while chunk := sys.stdin.buffer.read(65536):
            bundle.write(chunk)
    subprocess.run([*sys.argv[2:-1], name, *sys.argv[-1].split()], check=True)
"""


def git_runner(route, boundary, options):
    worktree = boundary["worktree"]
    prefix = ["codex", *options, "sandbox", "-P", route["permissions"], "-C", worktree, "--"]
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "USER", "CODEX_HOME") if k in os.environ}
    git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
           "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "fetch.fsckObjects=true"]
    export = ["env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
              "GIT_NO_REPLACE_OBJECTS=1", "GIT_OPTIONAL_LOCKS=0"]
    def run(args, data=b"", limit=8192):
        if args[0] == "import-bundle":
            command = [sys.executable, "-I", "-c", IMPORT_BUNDLE, route["checkout"], *git, "fetch",
                       "--no-tags", "--no-recurse-submodules", "--no-write-commit-graph", " ".join(args[1:])]
        else:
            command = [*git, *args]
        return bounded([*prefix, *export, *command], data, limit, worktree, env)
    return run


def perform(operation, boundary, run, transfer):
    ref = check_ref(boundary["ref"])
    require(run(["rev-parse", "--show-toplevel"]).decode().strip() == boundary["worktree"]
            and run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).decode().strip() == boundary["clone"]+"/.git"
            and run(["symbolic-ref", "HEAD"]).decode().strip() == ref, "The checkout, branch or Git database differs from its declaration.")
    origin = run(["remote", "get-url", "origin"]).decode().strip().lower()
    require(origin in {"https://github.com/"+boundary["repository"], "https://github.com/"+boundary["repository"]+".git"},
            "The local origin differs from the paired repository.")
    if operation == "fetch":
        default, selected, caps = refs(transfer("fetch_advertise", b""), b"upload-pack", ref)
        require(b"side-band-64k" in caps, "The upstream cannot provide bounded sideband Git data.")
        haves = run(["rev-list", "--max-count=32", "--all"]).splitlines()
        require(all(SHA.fullmatch(h) for h in haves), "Invalid local negotiation history.")
        wants = list(dict.fromkeys(selected.values()))
        body = b"".join(pkt(b"want "+sha+(b" side-band-64k" if i == 0 else b"")+b"\n") for i, sha in enumerate(wants))
        body += b"0000"+b"".join(pkt(b"have "+oid+b"\n") for oid in haves)+pkt(b"done\n")
        pack = bytearray()
        for part in packets(transfer("fetch_pack", body)):
            if part is None or part.startswith((b"NAK", b"ACK ", b"\x02")):
                continue
            require(part.startswith(b"\x01"), "Upstream Git declined the fetch.")
            pack.extend(part[1:])
        require(pack.startswith(b"PACK"), "Upstream Git did not return a pack.")
        prerequisites = b"".join(b"-"+sha+b" local\n" for sha in haves)
        names = b"".join(sha+b" "+name.encode()+b"\n" for name, sha in selected.items())
        specs = [n+":refs/remotes/origin/"+n[len("refs/heads/"):] for n in selected]
        run(["import-bundle", *specs], b"# v2 git bundle\n"+prerequisites+names+b"\n"+pack)
        commit = selected.get(ref, selected[default])
    else:
        require(operation == "push", "Unsupported private Git action.")
        default, selected, caps = refs(transfer("push_advertise", b""), b"receive-pack", ref)
        require(b"report-status" in caps, "The upstream cannot confirm the pushed ref.")
        commit = run(["rev-parse", "--verify", ref+"^{commit}"]).strip()
        require(SHA.fullmatch(commit), "Invalid local branch head.")
        old = selected.get(ref, b"0"*40)
        baseline = selected.get(ref, selected[default])
        run(["merge-base", "--is-ancestor", baseline.decode(), commit.decode()])
        if old != commit:
            pack = run(["pack-objects", "--stdout", "--revs", "--no-reuse-delta"], commit+b"\n^"+baseline+b"\n", LIMIT)
            require(pack.startswith(b"PACK"), "Local Git did not produce a pack.")
            body = pkt(old+b" "+commit+b" "+ref.encode()+b"\0report-status\n")+b"0000"+pack
            result = list(packets(transfer("push_pack", body)))
            require(result == [b"unpack ok\n", b"ok "+ref.encode()+b"\n", None], "Upstream Git did not confirm the assigned branch update.")
    return {**{k: boundary[k] for k in ("repository", "ref", "run", "fence")},
            "outcome": "pushed" if operation == "push" else "fetched", "commit": commit.decode()}
