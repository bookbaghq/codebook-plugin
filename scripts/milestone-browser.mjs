// Native proof adapter. Only the calling hook holds the report token. This process receives a pinned
// repository and the server-issued static-site specification. Its output is never parsed from app logs.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const cleanEnv = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
function git(dir, args, maxBuffer = 1024 * 1024) {
    return execFileSync('git', ['-C', dir, ...args], { env: cleanEnv, stdio: ['ignore','pipe','pipe'], maxBuffer });
}
function identity(address) {
    try {
        const https = String(address).replace(/^git@([^:]+):/, 'ssh://git@$1/');
        const url = new URL(https);
        if (!['https:', 'ssh:'].includes(url.protocol)) return '';
        return url.hostname.toLowerCase() + (url.port ? ':' + url.port : '') + url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
    } catch { return ''; }
}
function cleanHead(dir, repo, commit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !identity(repo)
        || identity(git(dir,['remote','get-url','origin']).toString().trim()) !== identity(repo)
        || git(dir,['rev-parse','HEAD']).toString().trim() !== commit
        || git(dir,['status','--porcelain','--untracked-files=all']).length) throw Error('A clean checkout of the exact repository and commit is required.');
}
function exportSite(dir, commit, destination) {
    mkdirSync(destination);
    const entries = git(dir,['ls-tree','-rlz',commit]).toString().split('\0').filter(Boolean);
    if (entries.length > 1000) throw Error('The static site exceeds the native adapter limit.');
    let bytes = 0;
    for (const entry of entries) {
        const matched = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
        if (!matched) throw Error('Only tracked regular files are supported.');
        const [, , oid, size, name] = matched;
        if (name.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || name.includes('\\')) throw Error('Unsupported static file path.');
        bytes += Number(size);
        if (bytes > 12 * 1024 * 1024) throw Error('The static site exceeds the native adapter limit.');
        const target = path.join(destination, name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, git(dir,['cat-file','blob',oid], 12 * 1024 * 1024));
    }
}
const appProgram = `from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
class Handler(SimpleHTTPRequestHandler):
 def end_headers(self):
  self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'self'; base-uri 'none'; sandbox allow-scripts allow-same-origin allow-forms")
  super().end_headers()
 def log_message(self,*args): pass
srv=ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(srv.server_port,flush=True)
srv.serve_forever()`;

function devtools(proc) {
    let id = 0, pending = new Map(), buffer = '';
    const listeners = new Map();
    proc.stdio[4].setEncoding('utf8').on('data', chunk => {
        buffer += chunk;
        const entries = buffer.split('\0'); buffer = entries.pop();
        for (const data of entries) {
            const event = JSON.parse(data);
            if (event.id) {
                const waiter = pending.get(event.id);
                if (waiter) { pending.delete(event.id); event.error ? waiter.reject(Error('Chrome refused the operation.')) : waiter.resolve(event.result); }
            } else listeners.get(event.method)?.(event);
        }
    });
    proc.once('exit', () => { for (const { reject } of pending.values()) reject(Error('Chrome exited.')); pending.clear(); });
    return {
        on: (name, fn) => listeners.set(name,fn),
        call(method, params = {}, sessionId) {
            return new Promise((resolve,reject) => {
                const key = ++id; pending.set(key,{resolve,reject});
                proc.stdio[3].write(JSON.stringify({ id:key, method, params, ...(sessionId ? {sessionId} : {}) }) + '\0');
            });
        }
    };
}

// Prefer the user-installed Playwright distribution. Its headless shell also works on macOS
// hosts where launching desktop Chrome would require a Local Network permission prompt.
function installedChromium() {
    const cache = path.join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
    const cached = existsSync(cache) ? readdirSync(cache).filter(entry => /^chromium_headless_shell-\d+$/.test(entry))
        .sort((a,b) => Number(b.split('-').pop())-Number(a.split('-').pop()))
        .flatMap(entry => ['chrome-headless-shell-mac-arm64/chrome-headless-shell','chrome-headless-shell-mac-x64/chrome-headless-shell','chrome-headless-shell-linux64/chrome-headless-shell','chrome-linux/headless_shell'].map(name => path.join(cache,entry,name))) : [];
    return [...cached,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(existsSync);
}

export async function capture({ dir, commit, repository, script }) {
    cleanHead(dir,repository,commit);
    if (script.adapter !== 'python-static-v1' || !script.path.startsWith('/') || script.path.startsWith('//')) throw Error('Unsupported static-site specification.');
    const chrome = installedChromium();
    if (!chrome) throw Error('A system Chrome or Chromium installation is required.');
    const temp = mkdtempSync(path.join(tmpdir(),'codebook-browser-'));
    const profile = path.join(temp,'profile'), site = path.join(temp,'site');
    let app, browser;
    const timeout = setTimeout(() => { browser?.kill('SIGKILL'); app?.kill('SIGKILL'); }, 45000);
    try {
        exportSite(dir,commit,site);
        app = spawn('python3',['-I','-u','-c',appProgram],{ cwd:site, env:cleanEnv,stdio:['ignore','pipe','ignore'] });
        const lines = createInterface({ input:app.stdout });
        const port = Number((await Promise.race([once(lines,'line'),once(app,'exit').then(() => { throw Error('Static app did not start.'); })]))[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Static app did not bind its loopback port.');
        const origin = 'http://127.0.0.1:' + port;
        const targetUrl = new URL(script.path, origin);
        if (targetUrl.origin !== origin) throw Error('Page outside the disposable app.');
        browser = spawn(chrome, ['--headless=new','--remote-debugging-pipe','--disable-extensions','--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--disable-default-apps','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--proxy-server=http://127.0.0.1:0','--proxy-bypass-list=<-loopback>;127.0.0.1:' + port,'--user-data-dir=' + profile, 'about:blank'],
            { env:{ ...cleanEnv, HOME:temp }, stdio:['ignore','ignore','ignore','pipe','pipe'] });
        const cdp = devtools(browser);
        const { targetId } = await cdp.call('Target.createTarget',{url:'about:blank'});
        const { sessionId } = await cdp.call('Target.attachToTarget',{targetId,flatten:true});
        const call = (method,params) => cdp.call(method,params,sessionId);
        let navigationStatus = 0;
        cdp.on('Network.responseReceived', ev => { if (ev.sessionId === sessionId && ev.params.type === 'Document') navigationStatus = ev.params.response.status; });
        cdp.on('Fetch.requestPaused', ev => {
            const permitted = new URL(ev.params.request.url).origin === origin;
            void call(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId:ev.params.requestId, ...(permitted ? {} : {errorReason:'BlockedByClient'}) }).catch(() => {});
        });
        await call('Page.enable'); await call('Network.enable'); await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
        const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
        const navigation = await call('Page.navigate',{url:targetUrl.href});
        if (!navigation.errorText) await Promise.race([loaded, once(browser,'exit').then(() => { throw Error('Chrome exited before the page loaded.'); })]);
        const isolated = await call('Page.createIsolatedWorld',{frameId:navigation.frameId,worldName:'codebook-browser-proof'});
        const evaluate = async expression => {
            const response = await call('Runtime.evaluate',{expression,contextId:isolated.executionContextId,returnByValue:true});
            return response.exceptionDetails ? null : response.result.value;
        };
        if (navigation.errorText || !navigationStatus) throw Error('The disposable app did not respond.');
        const actual = new URL(await evaluate('location.href'));
        if (actual.origin !== origin) throw Error('Navigation left the disposable static app.');
        const trace = [{index:0,op:'navigate',ok:navigationStatus >= 200 && navigationStatus < 400 && actual.pathname === targetUrl.pathname,
            http_status:navigationStatus,path_sha256:sha256(actual.pathname)}];
        for (const action of script.actions) {
            if (!trace.at(-1).ok) break;
            const [op,value] = Object.entries(action)[0], literal = JSON.stringify(value);
            const expressions = {
                click: '(()=>{const el=document.querySelector(' + literal + ');if(!el || el.disabled)return null;el.scrollIntoView({block:"center"});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return r.width && r.height && el.contains(document.elementFromPoint(x,y)) ? {x,y} : null})()',
                expect_visible: '!!document.querySelector(' + literal + ')?.getClientRects().length',
                expect_text: 'document.body.innerText.includes(' + literal + ')',
            };
            if (!Object.hasOwn(expressions,op)) throw Error('Unsupported browser action.');
            let observed;
            const until = Date.now() + 2500;
            do {
                observed = await evaluate(expressions[op]);
                if (!observed) await new Promise(r => setTimeout(r,50));
            } while (!observed && Date.now()<until);
            if (op === 'click' && observed) {
                for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',{type,...observed,button:'left',clickCount:1});
            }
            trace.push({index:trace.length,op,ok:Boolean(observed)});
        }
        const shot = await call('Page.captureScreenshot',{format:'jpeg',quality:55});
        if (shot.data.length > 400000) throw Error('Screenshot exceeds the receipt size limit.');
        cleanHead(dir,repository,commit);
        return { executor:'codebook-plugin-static-v1', spec_sha256:script.spec_sha256, trace, trace_sha256:sha256(JSON.stringify(trace)), screenshot:shot.data, screenshot_sha256:sha256(Buffer.from(shot.data,'base64')) };
    } finally {
        clearTimeout(timeout);
        for (const child of [browser,app]) if (child && child.exitCode === null && child.signalCode === null) {
            const ended = once(child,'exit'); child.kill('SIGKILL'); await ended;
        }
        rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:50});
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.stdout.write(JSON.stringify(await capture(JSON.parse(process.argv[2])))); }
    catch { process.stderr.write('The local browser could not capture the approved clean static app.'); process.exitCode=1; }
}
