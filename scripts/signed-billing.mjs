// Native synthetic-fixture profile. No application code, HTML, command or credential is read
// from a request. Each repository supplies only its committed, bounded fixture balance.
// The tracked .codebook/fixtures/synthetic-billing-v1.json contains {profile, product,
// balance}, e.g. {"profile":"synthetic_billing_v1","product":"first","balance":"6/10"}.
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE = 'synthetic_billing_v1';
const invalid = (code) => {
    throw Object.assign(new Error(code), { reason: code });
};
const secret = () => randomBytes(24).toString('hex');

function fixtureValue(product, dir) {
    if (
        !dir ||
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(product.repository) ||
        !/^refs\/heads\/[a-z0-9._/-]+$/i.test(product.ref) ||
        !/^[0-9a-f]{40}$/.test(product.commit)
    )
        invalid('source_changed');
    const git = (...args) =>
        execFileSync('git', ['-C', dir, ...args], {
            encoding: 'utf8',
            timeout: 3000,
            maxBuffer: 4096,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    try {
        const origin = git('remote', 'get-url', 'origin');
        const allowed = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'];
        if (
            !allowed.some(
                (prefix) => origin.toLowerCase().replace(/\.git$/, '') === prefix + product.repository.toLowerCase()
            )
        )
            invalid('source_changed');
        if (git('rev-parse', '--verify', product.commit + '^{commit}') !== product.commit) invalid('source_changed');
        const file = product.commit + ':.codebook/fixtures/synthetic-billing-v1.json';
        if (git('cat-file', '-t', file) !== 'blob') invalid('fixture_unavailable');
        const entry = JSON.parse(git('show', file));
        if (
            entry.profile !== PROFILE ||
            entry.product !== product.product ||
            typeof entry.balance !== 'string' ||
            !/^\d{1,9}\/\d{1,9}$/.test(entry.balance)
        )
            invalid('fixture_unavailable');
        return entry.balance;
    } catch (error) {
        invalid(error.reason || 'source_changed');
    }
}

// Each listener is acquired exclusively before opening the browser. An occupied port
// is an unavailable fixture. We never navigate to an existing service or alter it.
async function serve(product, value, actor) {
    let origin;
    try {
        origin = new URL(product.origin);
    } catch {
        invalid('fixture_unavailable');
    }
    if (
        origin.origin !== product.origin ||
        origin.hostname !== '127.0.0.1' ||
        origin.protocol !== 'http:' ||
        Number(origin.port) < 1024
    )
        invalid('fixture_unavailable');
    const session = secret();
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.headers.host !== origin.host) {
            res.writeHead(403).end();
            return;
        }
        if (req.method === 'GET' && req.url === '/login') {
            res.end(
                '<form method="post" action="/login"><label>Username<input name="username"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>'
            );
        } else if (req.method === 'POST' && req.url === '/login' && req.headers.origin === product.origin) {
            try {
                let body = '';
                for await (const data of req) {
                    body += data;
                    if (body.length > 512) {
                        res.writeHead(413).end();
                        return;
                    }
                }
                const fields = new URLSearchParams(body);
                if (fields.get('username') !== actor.name || fields.get('password') !== actor.password) {
                    res.writeHead(403).end();
                    return;
                }
                res.writeHead(303, {
                    'Set-Cookie': 'billing_session=' + session + '; HttpOnly; SameSite=Strict; Path=/',
                    Location: '/billing'
                }).end();
            } catch {
                res.destroy();
            }
        } else if (req.method === 'GET' && req.url === '/billing') {
            if (req.headers.cookie !== 'billing_session=' + session) {
                res.writeHead(401).end();
                return;
            }
            res.end(
                '<main><span data-proof-account>' +
                    actor.name +
                    '</span><output data-proof-billing>' +
                    value +
                    '</output></main>'
            );
        } else res.writeHead(404).end();
    });
    server.requestTimeout = 5000;
    server.listen({ host: '127.0.0.1', port: Number(origin.port), exclusive: true });
    try {
        await once(server, 'listening');
    } catch {
        invalid('fixture_unavailable');
    }
    return async () => {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
    };
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
                proc.stdio[3].write(
                    JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'
                );
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

async function observe(chrome, origin, actor) {
    const temp = mkdtempSync(path.join(tmpdir(), 'codebook-billing-'));
    let proc, timeout;
    try {
        proc = spawn(
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
                '--proxy-bypass-list=<-loopback>;' + new URL(origin).host,
                '--user-data-dir=' + temp,
                'about:blank'
            ],
            { env: { HOME: temp, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
        );
        await once(proc, 'spawn');
        timeout = setTimeout(() => proc.kill('SIGKILL'), 15000);
        const cdp = devtools(proc);
        const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
        const call = (method, params) => cdp.call(method, params, sessionId);
        await call('Page.enable');
        await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        cdp.on('Fetch.requestPaused', (event) => {
            const { requestId, request } = event.params;
            const allowed =
                (request.url === origin + '/login' && ['GET', 'POST'].includes(request.method)) ||
                (request.url === origin + '/billing' && request.method === 'GET');
            void call(
                allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
                allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }
            ).catch(() => {});
        });
        const loaded = () =>
            new Promise((resolve) =>
                cdp.on('Page.loadEventFired', (event) => {
                    if (event.sessionId === sessionId) resolve();
                })
            );
        let page = loaded();
        const nav = await call('Page.navigate', { url: origin + '/login' });
        if (nav.errorText) invalid('fixture_unavailable');
        const wait = (promise) => Promise.race([promise, once(proc, 'exit').then(() => invalid('capture_failed'))]);
        await wait(page);
        const evaluate = async (expression) =>
            (await call('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
        page = loaded();
        if (
            !(await evaluate(
                '(() => {const f=document.forms[0]; if(!f)return false; f.elements.username.value=' +
                    JSON.stringify(actor.name) +
                    ';f.elements.password.value=' +
                    JSON.stringify(actor.password) +
                    ';f.requestSubmit();return true})()'
            ))
        )
            invalid('session_missing');
        await wait(page);
        if ((await evaluate('location.href')) !== origin + '/billing') invalid('session_missing');
        const view = await evaluate(`(() => {const visible = selector => {
            const node=document.querySelector(selector);
            return node?.getClientRects().length ? node.innerText.trim() : null;
        }; return [visible('[data-proof-account]'),visible('[data-proof-billing]')];})()`);
        if (!Array.isArray(view) || view[0] !== actor.name) invalid('session_missing');
        if (!/^\d{1,9}\/\d{1,9}$/.test(view[1])) invalid('view_missing');
        return view;
    } finally {
        clearTimeout(timeout);
        if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
            const closed = once(proc, 'exit');
            proc.kill('SIGKILL');
            await closed;
        }
        rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
}

export async function captureSignedBilling({ plan, directories }) {
    const base = { definition: plan?.definition, fixture_profile: PROFILE };
    const cleanup = [];
    try {
        if (
            plan?.fixture_profile !== PROFILE ||
            plan.path !== '/billing' ||
            !Array.isArray(plan.products) ||
            plan.products.length !== 2 ||
            !Array.isArray(directories) ||
            directories.length !== 2 ||
            new Set(plan.products.map((p) => p.origin)).size !== 2 ||
            new Set(plan.products.map((p) => p.repository.toLowerCase())).size !== 2
        )
            invalid('fixture_unavailable');
        const values = plan.products.map((product, index) => fixtureValue(product, directories[index]));
        const chrome = installedChromium();
        if (!chrome) invalid('browser_missing');
        const actor = { name: 'tester-' + secret(), password: secret() };
        for (const [i, product] of plan.products.entries()) cleanup.push(await serve(product, values[i], actor));
        const key = randomBytes(32);
        const digest = (domain, value) =>
            createHmac('sha256', key)
                .update(domain + '\0' + value)
                .digest('hex');
        const observations = [];
        for (const { product, repository, commit, origin } of plan.products) {
            const [account, value] = await observe(chrome, origin, actor);
            observations.push({
                product,
                repository,
                commit,
                origin,
                path: '/billing',
                signed_in: true,
                account_digest: digest('account', account),
                value_digest: digest('value', value)
            });
        }
        return { ...base, observations };
    } catch (error) {
        return { ...base, unavailable: error.reason || 'capture_failed' };
    } finally {
        await Promise.allSettled(cleanup.map((close) => close()));
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
    process.stdout.write(JSON.stringify(await captureSignedBilling(JSON.parse(process.argv[2]))));
