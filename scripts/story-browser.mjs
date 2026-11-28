// Native, read-only static documentation preview. No proof credential or signed-in browser context enters this process.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    readFileSync,
    realpathSync,
    readdirSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    copyFileSync,
    statSync,
    lstatSync
} from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const cleanEnv = {
    PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1'
};
function git(dir, args, maxBuffer = 1024 * 1024) {
    return execFileSync('git', ['-C', dir, ...args], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
}
function identity(address) {
    try {
        const https = String(address).replace(/^git@([^:]+):/, 'ssh://git@$1/');
        const url = new URL(https);
        if (!['https:', 'ssh:'].includes(url.protocol)) return '';
        return (
            url.hostname.toLowerCase() +
            (url.port ? ':' + url.port : '') +
            url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
        );
    } catch {
        return '';
    }
}
function cleanHead(dir, repo, commit) {
    if (
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
        !identity(repo) ||
        identity(git(dir, ['remote', 'get-url', 'origin']).toString().trim()) !== identity(repo) ||
        git(dir, ['rev-parse', 'HEAD']).toString().trim() !== commit ||
        git(dir, ['status', '--porcelain', '--untracked-files=all']).length
    )
        throw Error('A clean checkout of the exact repository and commit is required.');
}
function exportSite(dir, commit, destination) {
    mkdirSync(destination);
    const entries = git(dir, ['ls-tree', '-rlz', commit]).toString().split('\0').filter(Boolean);
    if (entries.length > 1000) throw Error('The static site exceeds the native adapter limit.');
    let bytes = 0;
    for (const entry of entries) {
        const matched = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
        if (!matched) throw Error('Only tracked regular files are supported.');
        const [, , oid, size, name] = matched;
        if (
            name.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
            name.includes('\\')
        )
            throw Error('Unsupported static file path.');
        bytes += Number(size);
        if (bytes > 32 * 1024 * 1024) throw Error('The static site exceeds the native adapter limit.');
        const target = path.join(destination, name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, git(dir, ['cat-file', 'blob', oid], 32 * 1024 * 1024));
    }
}
function devtools(proc) {
    let id = 0,
        pending = new Map(),
        buffer = '';
    const listeners = new Map();
    proc.stdio[4].setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        const entries = buffer.split('\0');
        buffer = entries.pop();
        for (const data of entries) {
            const event = JSON.parse(data);
            if (event.id) {
                const waiter = pending.get(event.id);
                if (waiter) {
                    pending.delete(event.id);
                    event.error ? waiter.reject(Error('Chrome refused the operation.')) : waiter.resolve(event.result);
                }
            } else listeners.get(event.method)?.(event);
        }
    });
    proc.once('exit', () => {
        for (const { reject } of pending.values()) reject(Error('Chrome exited.'));
        pending.clear();
    });
    return {
        on: (name, fn) => listeners.set(name, fn),
        call(method, params = {}, sessionId) {
            return new Promise((resolve, reject) => {
                const key = ++id;
                pending.set(key, { resolve, reject });
                proc.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
            });
        }
    };
}

// Prefer the user-installed Playwright distribution. Its headless shell also works on macOS
// hosts where launching desktop Chrome would require a Local Network permission prompt.
function installedChromium() {
    const cache = path.join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
    const cached = existsSync(cache)
        ? readdirSync(cache)
              .filter((entry) => /^chromium_headless_shell-\d+$/.test(entry))
              .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
              .flatMap((entry) =>
                  [
                      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
                      'chrome-headless-shell-mac-x64/chrome-headless-shell',
                      'chrome-headless-shell-linux64/chrome-headless-shell',
                      'chrome-linux/headless_shell'
                  ].map((name) => path.join(cache, entry, name))
              )
        : [];
    return [
        ...cached,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome'
    ].find(existsSync);
}

const unavailable = (code) => {
    throw Object.assign(new Error(code), { code });
};
const absolute = (file) => JSON.stringify(realpathSync(file));
function publicDependencies(site, tmp) {
    let lock;
    try {
        lock = JSON.parse(readFileSync(path.join(site, 'package-lock.json'), 'utf8'));
    } catch {
        unavailable('build_unavailable');
    }
    if (lock.lockfileVersion < 2 || !lock.packages || Object.keys(lock.packages).length > 1500)
        unavailable('build_unavailable');
    const from = path.join(homedir(), '.npm', '_cacache', 'content-v2', 'sha512');
    const to = path.join(tmp, 'npm-cache', '_cacache', 'content-v2', 'sha512');
    for (const [name, entry] of Object.entries(lock.packages)) {
        if (!name || (entry.inBundle === true && !entry.resolved && !entry.integrity)) continue;
        if (
            !name.startsWith('node_modules/') ||
            !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '') ||
            !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity || '')
        )
            unavailable('build_unavailable');
        const hex = Buffer.from(entry.integrity.slice(7), 'base64').toString('hex');
        const file = path.join(hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
        if (!existsSync(path.join(from, file))) continue; // npm decides whether an optional dependency is needed on this platform.
        mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
        copyFileSync(path.join(from, file), path.join(to, file));
    }
}
function localNextBuild(site, tmp, build) {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') || !build || build.build !== 'npm run build')
        unavailable('build_unavailable');
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(path.join(site, 'package.json'), 'utf8'));
    } catch {
        unavailable('unsupported_preview');
    }
    if (pkg.scripts?.build !== 'next build' || pkg.scripts?.prebuild || pkg.scripts?.postbuild)
        unavailable('unsupported_preview');
    publicDependencies(site, tmp);
    // Only the owned scratch tree is writable and visible to project code. No user homes,
    // npm credentials, other checkouts, network or arbitrary recipe commands are available.
    const scratch = absolute(tmp);
    const allowedReads = [
        '/System/Library',
        '/Library/Apple',
        '/usr/bin',
        '/usr/lib',
        '/usr/share',
        '/usr/local/bin',
        '/usr/local/lib',
        '/bin',
        '/sbin',
        '/opt/homebrew/bin',
        '/opt/homebrew/lib',
        '/opt/homebrew/Cellar',
        '/dev'
    ]
        .map((p) => '(subpath ' + JSON.stringify(p) + ')')
        .join(' ');
    const profile = [
        '(version 1)',
        '(allow default)',
        '(deny network*)',
        '(deny signal (target others))',
        '(deny process-info* (target others))',
        '(deny file-read-data (require-not (require-any (literal "/") ' + allowedReads + ' (subpath ' + scratch + '))))',
        '(deny file-write* (require-not (require-any (subpath ' + scratch + ') (literal "/dev/null"))))'
    ].join('\n');
    const env = {
        PATH: cleanEnv.PATH,
        HOME: tmp,
        TMPDIR: tmp,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'production',
        CI: '1',
        npm_config_userconfig: '/dev/null'
    };
    try {
        execFileSync(
            '/usr/bin/sandbox-exec',
            [
                '-p',
                profile,
                '/usr/bin/env',
                'npm',
                'ci',
                '--offline',
                '--ignore-scripts',
                '--include=dev',
                '--no-audit',
                '--no-fund',
                '--cache',
                path.join(tmp, 'npm-cache')
            ],
            { cwd: site, env, stdio: 'ignore', timeout: 90000 }
        );
        // The fixed compiler entry avoids package lifecycle hooks. Webpack builds the same static route
        // without needing Turbopack's local IPC server.
        execFileSync(
            '/usr/bin/sandbox-exec',
            ['-p', profile, process.execPath, 'node_modules/next/dist/bin/next', 'build', '--webpack'],
            { cwd: site, env, stdio: 'ignore', timeout: 150000 }
        );
    } catch {
        unavailable('build_unavailable');
    }
}
function regularUnder(root, relative) {
    const file = path.join(root, relative);
    if (
        !existsSync(file) ||
        lstatSync(file).isSymbolicLink() ||
        !statSync(file).isFile() ||
        !realpathSync(file).startsWith(realpathSync(root) + path.sep) ||
        statSync(file).size > 8 * 1024 * 1024
    )
        return null;
    return file;
}
const mime = new Map([
    ['.css', 'text/css'],
    ['.woff2', 'font/woff2'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.svg', 'image/svg+xml'],
    ['.ico', 'image/x-icon']
]);
export async function capture({ dir, repository, commit, plan }) {
    if (
        !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/.test(plan.path) ||
        !Array.isArray(plan.visible_text) ||
        !plan.visible_text.length ||
        plan.visible_text.length > 20
    )
        unavailable('unsupported_preview');
    const check = () => {
        try {
            cleanHead(dir, repository, commit);
        } catch {
            unavailable('source_changed');
        }
    };
    check();
    const chrome = installedChromium();
    if (!chrome) unavailable('browser_missing');
    const temp = mkdtempSync(path.join(tmpdir(), 'codebook-story-browser-'));
    const site = path.join(temp, 'site'),
        slug = plan.path.slice(1).replace(/\/$/, '');
    let browser,
        server,
        timer,
        outside = false;
    try {
        exportSite(dir, commit, site);
        let html = regularUnder(site, (slug ? slug + '/' : '') + 'index.html') || regularUnder(site, slug + '.html');
        let built = false;
        if (!html) {
            localNextBuild(site, temp, plan.build);
            html = regularUnder(site, '.next/server/app/' + (slug || 'index') + '.html');
            built = true;
        }
        if (!html) unavailable('unsupported_preview');
        const pageBytes = readFileSync(html);
        server = http.createServer((req, res) => {
            const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
            res.setHeader(
                'Content-Security-Policy',
                "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            );
            if (pathname === plan.path) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(pageBytes);
                return;
            }
            const type = mime.get(path.extname(pathname));
            if (!type || !/^\/[A-Za-z0-9._/-]+$/.test(pathname) || pathname.split('/').includes('..')) {
                res.writeHead(404);
                res.end();
                return;
            }
            const relative = built
                ? pathname.startsWith('/_next/static/')
                    ? '.next/static/' + pathname.slice(14)
                    : 'public/' + pathname.slice(1)
                : pathname.slice(1);
            const file = regularUnder(site, relative);
            if (!file) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.setHeader('Content-Type', type);
            res.end(readFileSync(file));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = server.address().port,
            origin = 'http://127.0.0.1:' + port;
        browser = spawn(
            chrome,
            [
                '--headless=new',
                '--remote-debugging-pipe',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-component-update',
                '--no-first-run',
                '--disable-sync',
                '--disable-default-apps',
                '--disable-quic',
                '--proxy-server=http://127.0.0.1:0',
                '--proxy-bypass-list=<-loopback>;127.0.0.1:' + port,
                '--user-data-dir=' + path.join(temp, 'profile'),
                'about:blank'
            ],
            { env: { ...cleanEnv, HOME: temp }, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
        );
        timer = setTimeout(() => browser.kill('SIGKILL'), 30000);
        const cdp = devtools(browser),
            { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
        const call = (method, params) => cdp.call(method, params, sessionId);
        let status = 0;
        cdp.on('Network.responseReceived', (e) => {
            if (e.sessionId === sessionId && e.params.type === 'Document') status = e.params.response.status;
        });
        cdp.on('Fetch.requestPaused', (e) => {
            const allowed = new URL(e.params.request.url).origin === origin;
            if (!allowed) outside = true;
            void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
                requestId: e.params.requestId,
                ...(allowed ? {} : { errorReason: 'BlockedByClient' })
            }).catch(() => {});
        });
        await call('Page.enable');
        await call('Network.enable');
        await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
        const navigation = await call('Page.navigate', { url: origin + plan.path });
        if (navigation.errorText) unavailable('outside_preview');
        await Promise.race([loaded, once(browser, 'exit').then(() => unavailable('capture_failed'))]);
        const isolated = await call('Page.createIsolatedWorld', {
            frameId: navigation.frameId,
            worldName: 'codebook-static'
        });
        const evaluate = async (expression) =>
            (await call('Runtime.evaluate', { expression, contextId: isolated.executionContextId, returnByValue: true }))
                .result.value;
        if (outside || (await evaluate('location.href')) !== origin + plan.path) unavailable('outside_preview');
        const text = await evaluate("(document.querySelector('main') || document.body).innerText");
        const observations = plan.visible_text.map((expected) => text.includes(expected));
        const shot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 42 });
        if (shot.data.length > 350000 || outside) unavailable('capture_failed');
        check();
        return {
            commit,
            dirty: false,
            path: plan.path,
            definition: plan.definition,
            http_status: status,
            observations,
            screenshot: shot.data,
            screenshot_sha256: sha256(Buffer.from(shot.data, 'base64')),
            trace_sha256: sha256(JSON.stringify([plan.path, status, observations]))
        };
    } catch (error) {
        if (outside) unavailable('outside_preview');
        throw error;
    } finally {
        clearTimeout(timer);
        if (browser && browser.exitCode === null && browser.signalCode === null) {
            const ended = once(browser, 'exit');
            browser.kill('SIGKILL');
            await ended;
        }
        if (server?.listening)
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
        rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(JSON.stringify(await capture(JSON.parse(process.argv[2]))));
    } catch (e) {
        const code = [
            'browser_missing',
            'unsupported_preview',
            'source_changed',
            'build_unavailable',
            'outside_preview'
        ].includes(e.code)
            ? e.code
            : 'capture_failed';
        process.stdout.write(JSON.stringify({ unavailable: code }));
    }
}
