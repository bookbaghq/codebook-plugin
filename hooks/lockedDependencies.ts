// Fixed operator code. It runs in a separate, network-disabled native sandbox before the repository is allowed to execute.
export const lockedDependencySource = String.raw`"""Run only the plugin's fixed preparation steps. No project or package code is imported."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
LIMIT_SOURCE = 384 << 20
LIMIT_TARBALL = 160 << 20
LIMIT_EXPANDED = 3 << 30
REGISTRY = re.compile('https://registry\\.npmjs\\.org/(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+/-/[A-Za-z0-9._+-]+\\.tgz')
MOD = '(?:@[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*/)?[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*'
PACKAGE = re.compile('node_modules/' + MOD + '(?:/node_modules/' + MOD + ')*')
LOCKS = {'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'}
SQLITE = 'sha512-8VYKM3MjCa9WcaSAI3hzwhmyHVlH8tiGFwf0RlTsZPWJ1I5MkzjiudCo4KC4DxOaL/53A5B1sI/IbldNFDbsKA=='

class Wait(Exception):

    def __init__(self, code, detail):
        self.code, self.detail = (code, detail)

def stop(code, detail):
    raise Wait(code, detail)

def safe_parts(name, archive=False):
    parts = name.rstrip('/').split('/')
    if archive:
        parts = [part for part in parts if part != '.']
    if not parts or len(name) > 1024 or any((not p or p in {'.', '..'} or p.lower() == '.git' or ('\\' in p) or any((ord(c) < 32 or ord(c) == 127 for c in p)) for p in parts)):
        stop('unsupported', 'An archive or Git tree contains a non-portable path.')
    return parts

def run(args, **options):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **options).stdout

def runtime():
    js = 'JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,exec:process.execPath})'
    return json.loads(run(['node', '-p', js]))

def source_tree(repo, sha, source):
    env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0'}
    git = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(repo)]
    if run(git + ['rev-parse', 'HEAD'], env=env).decode().strip() != sha:
        stop('lock_mismatch', 'The selected checkout changed commit. Restore the requested commit.')
    entries = run(git + ['ls-tree', '-rz', '--full-tree', sha], env=env)
    if len(entries) > 32 << 20:
        stop('unsupported', 'The tracked source inventory exceeds 32 MiB.')
    files = []
    for entry in entries.split(b'\x00'):
        if not entry:
            continue
        meta, raw = entry.split(b'\t', 1)
        mode, kind, oid = meta.split()
        if not re.fullmatch(b'[0-9a-f]{40}|[0-9a-f]{64}', oid) or kind != b'blob' or mode not in [b'100644', b'100755']:
            stop('unsupported', 'The pinned Git tree contains a symlink, submodule or unsupported entry.')
        name = raw.decode('utf8')
        parts = safe_parts(name)
        if 'node_modules' in parts:
            stop('unsupported', 'The pinned source contains a dependency directory.')
        files.append((name, oid.decode(), mode == b'100755'))
    if len(files) > 80000:
        stop('unsupported', 'The tracked source inventory exceeds 80,000 files.')
    cat = subprocess.Popen(git + ['cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    total = 0
    try:
        for name, oid, executable in files:
            cat.stdin.write((oid + '\n').encode())
            cat.stdin.flush()
            fields = cat.stdout.readline(150).split()
            if len(fields) != 3 or fields[:2] != [oid.encode(), b'blob']:
                stop('lock_mismatch', 'Git could not supply the pinned source object.')
            size = int(fields[2])
            total += size
            if size > 96 << 20 or total > LIMIT_SOURCE:
                stop('unsupported', 'The pinned Git source exceeds the preparation size limit.')
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            blob = cat.stdout.read(size)
            if len(blob) != size or cat.stdout.read(1) != b'\n':
                stop('lock_mismatch', 'The pinned source object was incomplete.')
            obj = hashlib.new('sha1' if len(oid) == 40 else 'sha256')
            obj.update(('blob ' + str(size) + '\x00').encode())
            obj.update(blob)
            if obj.hexdigest() != oid:
                stop('lock_mismatch', 'The pinned source object did not match its Git ID.')
            with target.open('xb') as out:
                out.write(blob)
            target.chmod(493 if executable else 420)
    finally:
        cat.stdin.close()
        cat.stdout.close()
        cat.wait()
    return [name for name, _, _ in files if PurePosixPath(name).name in LOCKS]

def platform_applies(values, current):
    if not values:
        return True
    if not isinstance(values, list) or not all((isinstance(v, str) for v in values)):
        stop('unsupported', 'Unsupported npm platform selector.')
    return '!' + current not in values and (current in values or all((v.startswith('!') for v in values)))

def extract(cache, where, entry, budget):
    integrity = entry.get('integrity', '')
    if not re.fullmatch('sha512-[A-Za-z0-9+/]{86}==', integrity) or not REGISTRY.fullmatch(entry.get('resolved', '')):
        stop('unsupported', 'Only HTTPS npm registry packages pinned by SHA512 can be prepared offline.')
    digest = base64.b64decode(integrity[7:], validate=True)
    hexid = digest.hex()
    obj = cache / hexid[:2] / hexid[2:4] / hexid[4:]
    if not obj.is_file():
        stop('missing', 'Missing offline package ' + entry['label'] + ' (' + hexid[:16] + '). Populate the trusted npm cache for this lockfile.')
    if obj.resolve() != obj or obj.stat().st_size > LIMIT_TARBALL:
        stop('unsupported', 'The package cache entry is not a bounded ordinary file.')
    where.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(obj, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            stop('unsupported', 'The cache object must be an ordinary file.')
        import io
        # Hash the exact in-memory bytes that will be extracted, even if the external cache entry changes.
        data = source.read(LIMIT_TARBALL + 1)
        if hashlib.sha512(data).digest() != digest:
            stop('lock_mismatch', 'The cached archive for ' + entry['label'] + ' differs from locked SHA512 ' + hexid[:16] + '.')
        prefix = None
        with tarfile.open(fileobj=io.BytesIO(data), mode='r|gz') as tar:
            for member in tar:
                parts = safe_parts(member.name, archive=True)
                if prefix is None:
                    prefix = parts[0]
                if parts[0] != prefix:
                    stop('unsupported', 'The registry package has multiple archive roots.')
                if len(parts) == 1 and member.isdir():
                    continue
                if len(parts) < 2 or parts[1].lower() == 'node_modules' or (not (member.isdir() or member.isreg())):
                    stop('unsupported', 'Unsupported link, special entry or bundled modules in ' + entry['label'] + '.')
                target = where.joinpath(*parts[1:])
                budget[0] += member.size
                budget[1] += 1
                if member.size > 160 << 20 or budget[0] > LIMIT_EXPANDED or budget[1] > 220000:
                    stop('unsupported', 'The registry package extraction exceeds the local proof limit.')
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    if target.is_symlink() or not target.is_file() or target.stat().st_size != member.size:
                        stop('unsupported', 'Conflicting duplicate file in the locked archive.')
                    if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(tar.extractfile(member).read()).digest():
                        stop('unsupported', 'Duplicate archive entries have different content.')
                    continue
                with target.open('xb') as out:
                    shutil.copyfileobj(tar.extractfile(member), out)
                target.chmod(493 if member.mode & 73 else 420)
    # Resolve executable links from the verified package manifest, inside its own immutable node_modules.
    manifest = json.loads((where / 'package.json').read_bytes())
    if manifest.get('version') != entry.get('version'):
        stop('lock_mismatch', 'The package manifest version differs for ' + entry['label'] + '.')
    bins = manifest.get('bin') or {}
    if isinstance(bins, str):
        bins = {str(manifest['name']).split('/')[-1]: bins}
    modules = where.parent.parent if where.parent.name.startswith('@') else where.parent
    for name, rel in bins.items():
        if not re.fullmatch('[\\w.-]+', name) or name in {'.', '..'}:
            stop('unsupported', 'Unsupported npm binary name.')
        rel = rel[2:] if rel.startswith('./') else rel
        target = where.joinpath(*safe_parts(rel))
        if not target.is_file():
            continue
        bin_dir = modules / '.bin'
        bin_dir.mkdir(exist_ok=True)
        dest = bin_dir / name
        if not dest.is_symlink():
            dest.symlink_to(os.path.relpath(target, bin_dir))

def stage(repo, sha, root, cache):
    source = root / 'source'
    source.mkdir()
    (root / 'work').mkdir()
    locks = sorted(source_tree(repo, sha, source))
    native = []
    identity = []
    rt = runtime()
    budget = [0, 0]
    for rel in locks:
        if PurePosixPath(rel).name != 'package-lock.json':
            stop('unsupported', 'Provide a supported npm v3 lockfile in place of ' + rel + '.')
        lock_path = source / rel
        data = lock_path.read_bytes()
        lock = json.loads(data)
        if lock.get('lockfileVersion') != 3 or not isinstance(lock.get('packages'), dict):
            stop('unsupported', rel + ' must use npm lockfile version 3.')
        if len(lock['packages']) > 3000:
            stop('unsupported', 'The npm lock exceeds 3,000 packages.')
        identity.append([rel, hashlib.sha256(data).hexdigest()])
        skipped = []
        for name, entry in sorted(lock['packages'].items(), key=lambda item: (item[0].count('/'), item[0])):
            if not name:
                continue
            if not PACKAGE.fullmatch(name) or entry.get('link'):
                stop('unsupported', 'File and linked dependencies are unavailable in ' + rel + '.')
            if any((name.startswith(s + '/') for s in skipped)):
                continue
            if not platform_applies(entry.get('os'), rt['platform']) or not platform_applies(entry.get('cpu'), rt['arch']):
                if not entry.get('optional'):
                    stop('runtime_mismatch', 'Required package ' + name + ' does not support ' + rt['platform'] + '/' + rt['arch'] + '.')
                skipped.append(name)
                continue
            entry = {**entry, 'label': name + '@' + str(entry.get('version', ''))}
            pkg = lock_path.parent / name
            try:
                extract(cache, pkg, entry, budget)
            except Wait as err:
                stop(err.code, err.detail + ' [' + rel + ', ' + name + ']')
            except OSError as err:
                stop('unsupported', 'Could not materialize ' + name + ' in ' + rel + ' (' + type(err).__name__ + ': ' + Path(err.filename or '').name[:80] + ').')
            if name.endswith('/better-sqlite3'):
                if entry.get('integrity') != SQLITE:
                    stop('unsupported', 'No verified offline native build recipe exists for ' + entry['label'] + '.')
                native.append(str(pkg.relative_to(source)))
    return {'runtime': rt, 'locks': identity, 'native': native}

def build(root, provenance):
    if runtime() != provenance['runtime']:
        stop('runtime_mismatch', 'The Node runtime or ABI changed after validation. Restore the recorded runtime.')
    for rel, expected in provenance['locks']:
        if hashlib.sha256((root / 'source' / rel).read_bytes()).hexdigest() != expected:
            stop('lock_mismatch', rel + ' differs from the staged lockfile digest.')
    for relative in provenance['native']:
        pkg = root / 'source' / relative
        rt = provenance['runtime']
        headers = Path(rt['exec']).resolve().parent.parent / 'include' / 'node'
        if not (headers / 'node_version.h').is_file():
            stop('missing', 'Install matching system Node headers for the offline better-sqlite3 build.')
        version = (headers / 'node_version.h').read_text()
        v = [re.search('#define NODE_' + s + '_VERSION\\s+(\\d+)', version) for s in ['MAJOR', 'MINOR', 'PATCH']]
        if not all(v) or '.'.join((m.group(1) for m in v)) != rt['node']:
            stop('runtime_mismatch', 'System Node headers differ from Node ' + rt['node'] + '.')
        # An exact registry digest selects this fixed build. No lifecycle script, gyp action or package program is run.
        cc = shutil.which('clang') or shutil.which('cc')
        cxx = shutil.which('clang++') or shutil.which('c++')
        if not cc or not cxx:
            stop('missing', 'Install the system C and C++ toolchain for the offline native addon.')
        sqlite = pkg / 'deps/sqlite3'
        out = pkg / 'build/Release'
        out.mkdir(parents=True)
        flags = re.findall("'([A-Z][A-Z0-9_]*(?:=-?[0-9]+)?)'", (pkg / 'deps/defines.gypi').read_text())
        obj = out / 'sqlite.o'
        includes = ['-I' + str(sqlite), '-I' + str(headers)]
        sdk = ['-isysroot', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'] if rt['platform'] == 'darwin' else []
        shared = ['-bundle', '-undefined', 'dynamic_lookup'] if rt['platform'] == 'darwin' else ['-shared', '-ldl', '-pthread']
        try:
            run([cc, '-fPIC', '-O0', *sdk, *['-D' + x for x in flags], '-c', str(sqlite / 'sqlite3.c'), '-o', str(obj)], timeout=90)
            run([cxx, '-fPIC', '-O0', '-std=c++20', *sdk, '-DNODE_GYP_MODULE_NAME=better_sqlite3', *includes, str(pkg / 'src/better_sqlite3.cpp'), str(obj), *shared, '-o', str(out / 'better_sqlite3.node')], timeout=90)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            stop('unsupported', 'The fixed offline better-sqlite3 build could not complete with this Node SDK and system toolchain.')
        obj.unlink()
try:
    mode, repo, sha, temp, cache = sys.argv[1:]
    root = Path(temp)
    receipt = root / 'provenance.json'
    if mode == 'stage':
        result = stage(Path(repo), sha, root, Path(cache))
        receipt.write_text(json.dumps(result, sort_keys=True))
    elif mode == 'build':
        result = json.loads(receipt.read_bytes())
        build(root, result)
    else:
        stop('unsupported', 'Unknown dependency preparation stage.')
    rt = result['runtime']
    runtime_label = 'Node ' + rt['node'] + ' ABI ' + rt['abi'] + ' ' + rt['platform'] + '/' + rt['arch']
    print(json.dumps({'ready': True, 'identity': hashlib.sha256(receipt.read_bytes()).hexdigest(), 'runtime':runtime_label, 'locks':result['locks']}))
except Wait as err:
    print(json.dumps({'code': err.code, 'detail': err.detail}))
except Exception as err:
    print(json.dumps({'code': 'unsupported', 'detail': 'Offline dependency preparation was unavailable (' + type(err).__name__ + ').'}))
`
