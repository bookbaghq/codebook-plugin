// Installed fixture code. No repository file supplies an operation, path, expected value, or host command.
export const lockedWitnessFixture = String.raw`
import base64, hashlib, io, json, os, re, resource, secrets, selectors, stat, subprocess, sys, tarfile, tempfile, time
from pathlib import Path

checkout = Path(sys.argv[1]).resolve(strict=True)
selected = sys.argv[2]
platform = sys.argv[3]
deadline = time.monotonic() + min(110, int(sys.argv[4]) - 1)
if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', selected): raise ValueError('invalid commit')
system_paths = ['/bin','/sbin','/usr/bin','/usr/sbin','/usr/lib','/usr/lib64','/usr/share','/lib','/lib64',
                '/usr/local/bin','/usr/local/lib','/opt/homebrew/bin','/opt/homebrew/opt','/opt/homebrew/Cellar']
if platform == 'darwin':
    system_paths += ['/System','/usr/libexec','/Library/Developer/CommandLineTools','/Applications/Xcode.app/Contents/Developer/usr',
                     '/Applications/Xcode.app/Contents/Developer/Library/Frameworks']
xcode=Path('/Applications/Xcode.app/Contents/Developer/usr/bin')
git_bin=str(xcode/'git') if platform=='darwin' and (xcode/'git').is_file() else '/usr/bin/git'
python_bin=str(xcode/'python3') if platform=='darwin' and (xcode/'python3').is_file() else '/usr/bin/python3'
runtime_path=('/Applications/Xcode.app/Contents/Developer/usr/bin:' if platform=='darwin' else '')+'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
env={'PATH':runtime_path,'LANG':'C','GIT_CONFIG_GLOBAL':'/dev/null',
     'GIT_CONFIG_NOSYSTEM':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_TERMINAL_PROMPT':'0','HOME':'/nonexistent'}
def limits():
    resource.setrlimit(resource.RLIMIT_FSIZE,(16<<20,16<<20))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))

def run(argv, cwd, limit=500000):
    remaining=deadline-time.monotonic()
    if remaining <= 0: raise RuntimeError('witness deadline')
    with tempfile.TemporaryFile() as out:
        child=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.DEVNULL,
                               close_fds=True,start_new_session=True,preexec_fn=limits)
        try: code=child.wait(timeout=min(remaining,35))
        finally:
            try: os.killpg(child.pid,9)
            except ProcessLookupError: pass
        out.seek(0)
        data=out.read(limit+1)
        if code or len(data)>limit: raise RuntimeError('fixed child did not complete')
        return data

def box(read, write, argv):
    read=[str(p) for p in read]; write=str(write)
    if platform == 'darwin':
        def paths(names): return ' '.join('(subpath '+json.dumps(p)+')' for p in names)
        profile='\n'.join(['(version 1)','(allow default)','(deny file-read* file-write* (subpath "/"))',
            '(allow file-read-metadata)','(allow file-read* '+paths(system_paths+read+[write])+' (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (regex #"^/dev/fd/"))',
            '(allow file-write* '+paths([write])+' (literal "/dev/null") (regex #"^/dev/fd/"))',
            '(deny network*)','(deny mach-lookup)','(deny signal (target others))','(deny process-info* (target others))','(deny ipc-posix*)','(deny ipc-sysv*)'])
        return ['/usr/bin/sandbox-exec','-p',profile,*argv]
    if platform != 'linux': raise ValueError('unsupported host')
    bwrap=next((p for p in ['/usr/bin/bwrap','/bin/bwrap'] if Path(p).is_file()),None)
    if not bwrap: raise ValueError('no bubblewrap')
    bindings=[item for p in system_paths for item in ('--ro-bind-try',p,p)]
    return [bwrap,'--unshare-all','--die-with-parent','--new-session',*bindings,'--dev','/dev','--proc','/proc','--tmpfs','/tmp',
            *[i for p in read for i in ('--ro-bind',p,p)],'--bind',write,write,*argv]

def safe_file(root, relative, maximum):
    # Never follow links supplied by a candidate, including intermediate directories.
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        parts=relative.split('/')
        for name in parts[:-1]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=child
        child=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        with os.fdopen(child,'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size>maximum: raise ValueError('incomplete fixture file')
            return stream.read(maximum+1)
    finally: os.close(fd)

def make_fixture(base):
    repo=base/'repo'; repo.mkdir()
    package=b'{"name":"unit-fixture","version":"1.0.0","main":"index.cjs"}'
    module=b'module.exports=42;\n'
    archive=io.BytesIO()
    with tarfile.open(fileobj=archive,mode='w:gz') as tar:
        for name,data in [('package/package.json',package),('package/index.cjs',module)]:
            entry=tarfile.TarInfo(name); entry.size=len(data); tar.addfile(entry,io.BytesIO(data))
    content=archive.getvalue(); h=hashlib.sha512(content)
    lock=json.dumps({'lockfileVersion':3,'packages':{'':{},'node_modules/unit-fixture':{
       'version':'1.0.0','resolved':'https://registry.npmjs.org/unit-fixture/-/unit-fixture-1.0.0.tgz',
       'integrity':'sha512-'+base64.b64encode(h.digest()).decode()}}},separators=(',',':')).encode()
    (repo/'package-lock.json').write_bytes(lock)
    (repo/'test').mkdir(); (repo/'test'/'unit.mjs').write_text('import x from "unit-fixture"; if(x!==42)process.exit(1); console.log("fixed witness 42")')
    git=[git_bin,'-c','core.hooksPath=/dev/null','-c','user.name=Local Fixture','-c','user.email=fixture@example.invalid']
    for args in [['init','-b','main'],['remote','add','origin','https://github.com/fixture/offline.git'],['add','.'],['commit','-m','fixed fixture']]:
        run(git+args,repo)
    commit=run(git+['rev-parse','HEAD'],repo).decode().strip()
    for kind in ['good','missing','mismatch']:
        cache=base/kind; cache.mkdir()
        if kind!='missing':
            digest=h.hexdigest(); dest=cache/digest[:2]/digest[2:4]/digest[4:]; dest.parent.mkdir(parents=True)
            dest.write_bytes(content if kind=='good' else b'wrong fixed fixture bytes')
    return repo,commit,lock,module,package

# Load the selected package's code only inside a confined child.
extract="""
import json,sys
from pathlib import Path
p=Path(sys.argv[1]).read_text()
start=p.index('export const lockedDependencySource = String.raw'+chr(96))+len('export const lockedDependencySource = String.raw'+chr(96))
end=p.rfind(chr(96))
if start>=end: raise ValueError('missing selected preparer')
sys.argv=['preparer']+sys.argv[2:]
exec(compile(p[start:end],'<selected-preparer>','exec'))
"""
def verify(base, driver):
    empty=base/'empty'; empty.mkdir()
    dot=checkout/'.git'
    if dot.is_symlink(): raise ValueError('linked git directory')
    if dot.is_dir(): metadata=[dot]
    else:
        entry=safe_file(checkout,'.git',8192).decode().rstrip('\n')
        if not entry.startswith('gitdir: /'): raise ValueError('unknown worktree metadata')
        target=Path(entry[8:]).resolve(strict=True)
        if not re.search(r'/\.git/worktrees/[^/]+$',str(target)) or safe_file(target,'gitdir',8192).decode().strip()!=str(dot):
            raise ValueError('mismatched worktree metadata')
        metadata=[target,target.parent.parent]
    def git(*args):
        return run(box([checkout,*metadata],empty,[git_bin,'--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',str(checkout),*args]),empty)
    def clean():
        if git('rev-parse','HEAD').decode().strip()!=selected or git('status','--porcelain') or git('ls-files','--others','--directory','-z'): raise ValueError('source is not clean')
        flags=git('ls-files','-v','-z').split(b'\0')
        if len(flags)<2 or any(not v.startswith(b'H ') for v in flags[:-1]): raise ValueError('source index')
    clean()
    candidate=base/'candidate'; candidate.mkdir()
    names=['proof','connector','egress','lockedDependencies']
    available=git('ls-tree','--name-only',selected+':hooks').decode().splitlines()
    names += [name for name in ['native-locked-witness','locked-witness-fixture'] if name+'.ts' in available]
    for name in names:
        blob=git('cat-file','blob',selected+':hooks/'+name+'.ts')
        (candidate/(name+'.ts')).write_bytes(blob)
    repo,commit,lock,module,package=make_fixture(base)
    observations={}
    for kind in ['good','missing','mismatch','other']:
        scratch=base/('work-'+kind); scratch.mkdir()
        cache=base/('good' if kind=='other' else kind)
        read=[candidate,repo,cache]
        def prepare(mode):
            cmd=[python_bin,'-I','-S','-c',extract,str(candidate/'lockedDependencies.ts'),mode,str(repo),commit,str(scratch),str(cache)]
            return json.loads(run(box(read,scratch,cmd),scratch,8192))
        stage=prepare('stage')
        if kind in ['missing','mismatch']:
            expected='missing' if kind=='missing' else 'lock_mismatch'
            if stage.get('ready') or stage.get('code')!=expected or os.path.lexists(scratch/'provenance.json'): raise ValueError('dependency refusal')
            observations[kind]={'stage':stage}
            continue
        build=prepare('build')
        identity=hashlib.sha256(safe_file(scratch,'provenance.json',32768)).hexdigest()
        locks=[['package-lock.json',hashlib.sha256(lock).hexdigest()]]
        if not all(x.get('ready') and x.get('identity')==identity and x.get('locks')==locks for x in [stage,build]): raise ValueError('incomplete preparation')
        for path,wanted in [('source/package-lock.json',lock),('source/node_modules/unit-fixture/index.cjs',module),('source/node_modules/unit-fixture/package.json',package)]:
            if safe_file(scratch,path,len(wanted))!=wanted: raise ValueError('staged dependency mismatch')
        testwork=base/('test-'+kind); testwork.mkdir()
        cmd=['/usr/bin/env','node','-e','if(require(process.argv[1])!==42)process.exit(1); console.log("fixed witness 42")',str(scratch/'source/node_modules/unit-fixture/index.cjs')]
        output=run(box([scratch],testwork,cmd),testwork,128).decode().strip()
        if output!='fixed witness 42': raise ValueError('independent runtime observation')
        observations[kind]={'stage':stage,'build':build,'output':output}
    control=base/'driver'; control.mkdir(); (control/'driver.mjs').write_text(driver)
    (control/'observations.json').write_text(json.dumps(observations))
    work=base/'control-work'; work.mkdir()
    observe_control(box([candidate,control,repo],work,['/usr/bin/env','node',str(control/'driver.mjs'),str(candidate),str(repo),commit,str(work)]),
                    work,repo,commit,observations)
    clean()
    return {'verified_offline_dependency':'passed','parked_dependency_proof':'passed'}

def observe_control(argv,work,repo,commit,observations):
    # This disposable channel only serves fixture queue values. No request can open a file or start a process.
    child=subprocess.Popen(argv,cwd=work,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True,preexec_fn=limits)
    remaining=b''
    budget=32768
    def read_message(watch):
        nonlocal remaining,budget
        while b'\n' not in remaining:
            if not watch.select(max(0,min(4,deadline-time.monotonic()))): raise ValueError('fixture control timeout')
            data=os.read(child.stdout.fileno(),4096)
            if not data: raise ValueError('incomplete fixture control')
            budget-=len(data)
            if budget<0 or len(remaining)>8192: raise ValueError('fixture control limit')
            remaining+=data
        line,remaining=remaining.split(b'\n',1)
        message=json.loads(line)
        if not isinstance(message,dict): raise ValueError('invalid fixture control message')
        return message
    def reply(value):
        child.stdin.write(json.dumps(value,separators=(',',':')).encode()+b'\n'); child.stdin.flush()
    wait=None
    try:
        with selectors.DefaultSelector() as watch:
            watch.register(child.stdout,selectors.EVENT_READ)
            phases=[('good',['peek','claim','report']),('missing',['peek','park']),('missing',['peek']),
                    ('mismatch',['peek','park']),('other',['peek','claim','report'])]
            for phase,operations in phases:
                proof=125 if phase=='other' else 123
                nonce=None
                for operation in operations+['end']:
                    msg=read_message(watch)
                    if msg.get('op')!=operation: raise ValueError('unexpected fixture control transition')
                    if operation=='peek':
                        if set(msg)!={'op'}: raise ValueError('invalid peek')
                        target={'proof':123,'repository':'fixture/offline','worktree':str(repo),'branch':'main','commands':['fixture'],
                                'delegated_focused_version':1,'dependency_wait_version':1,'commit':commit}
                        pending=[dict(target,**({'dependency_wait':wait} if wait else {}))]
                        if phase=='other': pending.append(dict(target,proof=125))
                        reply({'waiting':pending})
                    elif operation=='park':
                        expected=observations[phase]['stage']
                        condition=msg.get('wait',{})
                        digest=hashlib.sha256(json.dumps(['fixture/offline',commit,expected['code'],expected['detail']],separators=(',',':')).encode()).hexdigest()
                        if set(msg)!={'op','proof','wait'} or msg['proof']!=123 or condition.get('code')!=expected['code'] or condition.get('condition_hash')!=digest:
                            raise ValueError('incorrect fixed dependency wait')
                        wait={'code':expected['code'],'condition_hash':digest}
                        reply({'proof':123,'waiting_for_dependencies':True})
                    elif operation=='claim':
                        if msg!={'op':'claim','proof':proof,'prepared':1}: raise ValueError('unprepared fixture claim')
                        nonce=secrets.token_hex(12)
                        reply({'proof':proof,'token':nonce,'report_url':'http://fixture.invalid/proof','expected_commit':commit,
                               'repository':{'id':1,'full_name':'fixture/offline'},'proof_scope':'focused',
                               'recipe':{'revision':1,'install':'','network':'loopback'},'steps':[{'run':proof,'name':'fixture','line':'node test/unit.mjs',
                               'timeout_seconds':30,'baseline':False,'delegated_focused':True}]})
                    elif operation=='report':
                        if msg!={'op':'report','nonce':nonce,'run':proof,'commit':commit,'dirty':False,'exit':0,'observed':'fixed witness 42'}:
                            raise ValueError('invalid fixture result')
                        reply({'data':True,'status':'passed','tests':1})
                    else:
                        if msg!={'op':'end'}: raise ValueError('invalid end')
                        reply({'ok':True})
            child.stdin.close()
            if child.wait(timeout=max(.1,min(4,deadline-time.monotonic()))) or remaining or not watch.select(max(0,min(2,deadline-time.monotonic()))) or os.read(child.stdout.fileno(),1): raise ValueError('fixture did not finish')
    finally:
        try: os.killpg(child.pid,9)
        except ProcessLookupError: pass
        child.wait()

try:
    with tempfile.TemporaryDirectory(prefix='codebook-native-witness-') as temp:
        root=Path(temp).resolve()
        if sys.argv[5]=='probe':
            if run(box([],root,[python_bin,'-I','-S','-c','print(42)']),root,8).strip()!=b'42': raise ValueError('system Python')
            if run(box([],root,['/usr/bin/env','node','-p','typeof require("node:module").stripTypeScriptTypes']),root,32).strip()!=b'function': raise ValueError('system Node')
            if not run(box([],root,[git_bin,'--version']),root,128).startswith(b'git version '): raise ValueError('system Git')
            print('ready')
        else: print(json.dumps(verify(root,sys.argv[5])))
except Exception as exc:
    print(json.dumps({'error':'Fixed sibling fixture incomplete: '+type(exc).__name__}))
    sys.exit(1)
`

// This adapter only runs inside the coordinator's sandbox. It cannot request a sibling operation.
// Its process observations are the results of the fixed sibling executions, recorded before it starts.
export const lockedWitnessDriver = String.raw`
import { readFile,writeFile,readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { stripTypeScriptTypes } from 'node:module'
import { resolve,join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [source,repo,commit,work]=process.argv.slice(2)
const observations=JSON.parse(await readFile(new URL('observations.json',import.meta.url)))
for (const name of await readdir(source)) {
  if (!/^[A-Za-z][A-Za-z0-9-]*\.ts$/.test(name)) throw Error('unknown candidate module')
  const code=stripTypeScriptTypes(await readFile(join(source,name),'utf8'),{mode:'transform'})
    .replace(/from '(\.\/[^']+)'/g,"from '$1.mjs'")
  await writeFile(join(work,name.replace(/\.ts$/,'.mjs')),code)
}
const {runProof}=await import(pathToFileURL(join(work,'proof.mjs')))
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]()
async function exchange(request) {
  process.stdout.write(JSON.stringify(request)+'\n')
  const response=await lines.next()
  if(response.done)throw Error('fixed fixture control closed')
  return JSON.parse(response.value)
}
let phase='good'
const ok=(stdout='')=>({exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false})
const scratch='/tmp/codebook-delegated-witness'
const $={
 clock:{now:async()=>Date.now()},env:{get:async name=>name==='HOME'?work:undefined},cwd:async()=>repo,
 process:{run:async argv=>{
   if(argv[0]==='uname')return ok(process.platform==='darwin'?'Darwin':'Linux')
   if(argv.at(-1)==='/usr/bin/true'||argv.at(-1)==='/bin/true')return ok()
   if(argv[0]==='/usr/bin/mktemp')return ok(scratch)
   if(argv[0]==='/bin/rm')return ok()
   if(argv[0]==='realpath')return ok(argv[1])
   if(argv[0]==='git'){
     if(argv.includes('--show-toplevel'))return ok(repo)
     if(argv.includes('--absolute-git-dir')||argv.includes('--git-common-dir'))return ok(repo+'/.git')
     if(argv.includes('get-url'))return ok('https://github.com/fixture/offline.git')
     if(argv.includes('--get')&&argv.includes('remote.origin.url'))return ok('https://github.com/fixture/offline.git')
     if(argv.includes('--show-current')||argv.includes('--abbrev-ref'))return ok('main')
     if(argv.includes('HEAD'))return ok(commit)
   }
   for(const operation of ['stage','build'])if(argv.includes(operation)&&argv.includes('-I')&&argv.includes('-S')){
     const observed=observations[phase][operation]; if(!observed)throw Error('unobserved preparation')
     return ok(JSON.stringify(observed))
   }
   if(argv.includes('node')&&argv.includes('test/unit.mjs')&&observations[phase].output)return ok(observations[phase].output)
   throw Error('fixture received unexpected process request')
 }},
 mcp:{connect:async()=>({isConnected:true,server:'fixture'}),call:async(_server,tool,args)=>{
   if(tool!=='claim_proof') throw Error('unexpected fixture operation')
   let value
   if(args.peek) value=await exchange({op:'peek'})
   else if(args.dependency_wait) value=await exchange({op:'park',proof:args.proof,wait:args.dependency_wait})
   else value=await exchange({op:'claim',proof:args.proof,prepared:args.dependency_wait_version})
   return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]}
 }},
 http:{fetch:async(url,req)=>{
   const body=JSON.parse(req.body)
   if(url!=='http://fixture.invalid/proof')throw Error('unknown fixture destination')
   const value=await exchange({op:'report',nonce:req.headers.authorization.slice(7),run:body.run,commit:body.commit,dirty:body.dirty,
     exit:body.exit_code,observed:String(body.output).split('\n')[0]})
   return {ok:true,text:JSON.stringify(value)}
 }}
}
for (phase of ['good','missing','missing','mismatch','other']) {
  await runProof($,{proof:phase==='other'?null:123,known:[{repository:'fixture/offline',checkoutPath:repo}],hint:{worktree:repo,branch:'main'}})
  await exchange({op:'end'})
}
`
