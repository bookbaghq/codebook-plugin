// Standalone, digest-pinned registered runner entry for the three real first-party products.
import { spawn, spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    chmodSync,
    mkdirSync,
    rmSync,
    openSync,
    closeSync,
    existsSync,
    realpathSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    writeFileSync,
    cpSync,
    lstatSync
} from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import os, { homedir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
function devtools(proc) {
    let id = 0,
        pending = new Map(),
        buffer = '';
    const listeners = new Map();
    proc.stdio[4].setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) {
            proc.kill('SIGKILL');
            return;
        }
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
                      'chrome-headless-shell-linux-arm64/chrome-headless-shell',
                      'chrome-linux/headless_shell'
                  ].map((name) => path.join(cache, entry, name))
              )
        : [];
    return [
        ...cached,
        '/opt/codebook-browser/browsers/chromium_headless_shell-1254/chrome-headless-shell-linux-arm64/chrome-headless-shell',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome'
    ].find(existsSync);
}

// Run only inside an exporter-owned, disposable source directory. Application
// processes receive a minimal environment and a loopback-only OS sandbox.

const pathTag = (cwd, root) => (cwd.startsWith(root + '/') ? cwd.slice(root.length + 1) : 'fixture');
const clean = () => randomBytes(32).toString('hex');
const apiByRole = { portal: 8090, vibeforce: 8082, openbook: 8080 };
const frontendByRole = { portal: 3100, vibeforce: 3001, openbook: 3000 };
export function privateLinuxReady() {
    if (
        process.platform !== 'linux' ||
        process.getuid?.() === 0 ||
        !existsSync('/usr/bin/bwrap') ||
        !existsSync('/usr/bin/git') ||
        !existsSync('/usr/bin/tar') ||
        Number(process.versions.node.split('.')[0]) !== 24
    )
        return false;
    try {
        return (
            readdirSync('/sys/class/net').sort().join(',') === 'lo' &&
            !existsSync('/run/docker.sock') &&
            !existsSync('/run/podman/podman.sock')
        );
    } catch {
        return false;
    }
}
async function reserveCheck(ports) {
    const sockets = [];
    try {
        for (const port of ports) {
            const server = createServer();
            sockets.push(server);
            server.listen({ host: '127.0.0.1', port, exclusive: true });
            await once(server, 'listening');
        }
    } finally {
        await Promise.all(sockets.filter((s) => s.listening).map((s) => new Promise((done) => s.close(done))));
    }
}
export function sandboxArgs(productRoot, offline = false) {
    const args = [
        '--die-with-parent',
        '--new-session',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--ro-bind',
        '/usr',
        '/usr',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--tmpfs',
        '/tmp',
        '--dir',
        '/etc'
    ];
    if (offline) args.push('--unshare-net');
    for (const p of ['/bin', '/sbin', '/lib', '/lib64']) if (existsSync(p)) args.push('--ro-bind', p, p);
    for (const file of ['hosts', 'resolv.conf', 'nsswitch.conf', 'passwd', 'group', 'ld.so.cache', 'localtime']) {
        const p = '/etc/' + file;
        if (existsSync(p)) args.push('--ro-bind', p, p);
    }
    // Each product sees its own source export and scratch directory only.
    const scratch = productRoot + '-scratch';
    args.push('--bind', productRoot, productRoot, '--bind', scratch, scratch);
    return args;
}
function native(productRoot, ports, argv, { cwd, env, timeout = 120000, background = false } = {}) {
    // The confined supervisor stays alive after a server exits. Closing its stdin
    // ends bubblewrap’s private PID namespace, including server subprocesses.
    const supervise = `
        const {spawn}=require('node:child_process');
        const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','ignore',2]});
        child.on('exit',code=>process.stdout.write(String(code??1)+'\\n'));
        child.on('error',()=>process.stdout.write('1\\n'));
        process.stdin.resume();process.stdin.on('end',()=>process.exit());
    `;
    const child = spawn(
        '/usr/bin/bwrap',
        [...sandboxArgs(productRoot, ports.length === 0), '--chdir', cwd, process.execPath, '-e', supervise, ...argv],
        {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        }
    );
    child.stdin.on('error', () => {}); // The confined process may have already exited.
    let diagnostic = '';
    child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    const exit = once(child, 'exit').then(([code]) => code);
    const completed = Promise.race([
        once(child.stdout, 'data').then(([chunk]) => {
            const code = chunk.toString().trim();
            return /^\d{1,3}$/.test(code) ? Number(code) : 1;
        }),
        exit
    ]);
    let commandEnded = false;
    completed.then(
        () => {
            commandEnded = true;
        },
        () => {
            commandEnded = true;
        }
    );
    const stop = async () => {
        if (!child.pid || child.pid <= 1) return;
        // This is the bubblewrap process we spawned. If it already exited,
        // never address a recycled group id.
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdin.end();
        if ((await Promise.race([exit.then(() => true), delay(800, false)])) === false) {
            child.kill('SIGKILL');
            await exit;
        }
    };
    if (background) return { child, stop, ended: () => commandEnded };
    return (async () => {
        const controller = new AbortController();
        try {
            const code = await Promise.race([completed, delay(timeout, -1, { signal: controller.signal })]);
            if (code !== 0)
                throw Error(
                    'fixture_unavailable: ' +
                        pathTag(cwd, productRoot) +
                        ' ' +
                        (argv.includes('ci')
                            ? 'install'
                            : argv.includes('scripts/bootstrap-all.mjs')
                              ? 'bootstrap'
                              : 'setup') +
                        ' ' +
                        code +
                        ' ' +
                        (diagnostic.match(/(?:code |Error: )(E[A-Z_0-9]+)/)?.[1] ||
                            (diagnostic.includes('gyp') ? 'native-build' : 'unspecified')) +
                        ' ' +
                        (diagnostic.match(/https:\/\/registry\.npmjs\.org\/([@A-Za-z0-9_.%/-]+).*cache mode/)?.[1] ||
                            '')
                );
        } finally {
            controller.abort();
            await stop();
        }
    })();
}

// The registered supervisor stages only the lockfile-authorized tarballs, metadata,
// and owner-approved native artifacts. The sandbox receives a private writable copy
// because npm writes cache indexes even when running offline.
function stageCache(root, dependencyCache) {
    const target = join(root, 'cache');
    mkdirSync(target, { mode: 0o700 });
    for (const name of ['_cacache', '_prebuilds']) {
        const src = join(dependencyCache, name);
        if (!existsSync(src)) {
            if (name === '_cacache') throw Error('fixture_unavailable');
            continue;
        }
        cpSync(src, join(target, name), {
            recursive: true,
            verbatimSymlinks: true,
            filter: (file) => {
                if (lstatSync(file).isSymbolicLink()) throw Error('fixture_unavailable');
                return true;
            }
        });
    }
}
const productBootstrap = `
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
for(const c of fs.readdirSync('components')) {
    const d=path.resolve('components',c,'app/models'); if(!fs.existsSync(d))continue;
    for(const f of fs.readdirSync(d).filter(n=>/^[a-zA-Z0-9]+Context\\.js$/.test(n))){
        const {default: C}=await import(pathToFileURL(path.join(d,f)).href);
        const db=new C();try{await db.database.ensureCreated();}finally{await db.close();}
    }
}`;
const seed = `
import {writeFileSync} from 'node:fs';
import Auth from './components/auth/app/models/authContext.js';
import User from './components/user/app/models/userContext.js';
import Orgs from './components/organizations/app/models/organizationsContext.js';
import Oidc from './components/oidc/app/models/oidcContext.js';
import Apps from './components/apps/app/models/appsContext.js';
import {registerApp} from './components/oidc/app/service/registrationService.js';
import {hashPassword} from './app/service/accountService.js';
const a=new Auth(),u=new User(),o=new Orgs(),oidc=new Oidc(),apps=new Apps();
try {
 const {salt,hash}=await hashPassword(process.env.QA_PASSWORD);
 const now=Date.now(), member={email:process.env.QA_EMAIL,email_verified:1,status:'active',password_salt:salt,password_hash:hash,created_at:now,updated_at:now};
 a.Auth.add(member);await a.saveChanges();
 u.User.add({auth_id:member.id,first_name:'Billing',last_name:'Fixture',created_at:now,updated_at:now});await u.saveChanges();
 const org={...(/^\\d+$/.test(process.env.QA_ORG)?{id:Number(process.env.QA_ORG)}:{}),name:'Billing fixture',public_id:process.env.QA_ORG,owner_auth_id:member.id,status:'active',created_at:now,updated_at:now};
 o.Organization.add(org);await o.saveChanges();
 o.OrganizationMember.add({organization_id:org.id,auth_id:member.id,role:'owner',created_at:now,updated_at:now});await o.saveChanges();
 const result={};
 for(const [slug,origin] of Object.entries(JSON.parse(process.env.QA_PRODUCTS))){
  const client=await registerApp(oidc,apps,{slug,name:slug,origins:[origin]});
  if(client.error||!client.token)throw Error('Local client unavailable');
  result[slug]=client.token;
 }
 writeFileSync(process.env.QA_OUTPUT,JSON.stringify(result),{mode:0o600,flag:'wx'});
}finally{for(const db of [a,u,o,oidc,apps])await db.close();}
`;
function ownsSocket(leader, port) {
    const suffix = ':' + port.toString(16).toUpperCase().padStart(4, '0');
    try {
        const sockets = [];
        for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
            if (!existsSync(table)) continue;
            for (const line of readFileSync(table, 'utf8').trim().split('\n').slice(1)) {
                const fields = line.trim().split(/\s+/);
                if (fields[3] === '0A' && fields[1].endsWith(suffix)) sockets.push('socket:[' + fields[9] + ']');
            }
        }
        if (!sockets.length) return false;
        const owned = new Set(),
            visit = [leader];
        while (visit.length) {
            const pid = visit.pop();
            if (owned.has(pid)) continue;
            owned.add(pid);
            const children = readFileSync('/proc/' + pid + '/task/' + pid + '/children', 'utf8').trim();
            if (children) visit.push(...children.split(/\s+/).map(Number));
        }
        const found = new Set();
        for (const pid of owned)
            for (const fd of readdirSync('/proc/' + pid + '/fd')) {
                try {
                    found.add(readlinkSync('/proc/' + pid + '/fd/' + fd));
                } catch {}
            }
        return sockets.every((inode) => found.has(inode));
    } catch {
        return false;
    }
}
export async function withFirstPartyServices(root, sources, dependencyCache, use) {
    if (!privateLinuxReady() || typeof dependencyCache !== 'string' || !existsSync(join(dependencyCache, '_cacache')))
        throw Error('fixture_unavailable');
    const node = realpathSync(process.execPath),
        nodeHome = resolve(dirname(node), '..'),
        npmRoot = join(nodeHome, 'lib/node_modules/npm');
    const npm = join(npmRoot, 'bin/npm-cli.js');
    if (!existsSync(npm)) throw Error('fixture_unavailable');
    const cleanEnv = {
        PATH: dirname(node) + ':/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        master: 'testing',
        NEXT_TELEMETRY_DISABLED: '1',
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_nodedir: nodeHome,
        NODE_OPTIONS: '--dns-result-order=ipv4first'
    };

    const products = Object.fromEntries(sources.map((s) => [s.role, s]));
    const frontPorts = sources.map((s) => Number(new URL(s.origin).port)),
        apiPorts = sources.map((s) => apiByRole[s.role]);
    const ports = [...frontPorts, ...apiPorts];
    if (new Set(ports).size !== ports.length) throw Error('fixture_unavailable');
    await reserveCheck(ports);
    const member = { email: 'member-' + clean().slice(0, 12) + '@example.invalid', password: clean() };
    const serviceEnvs = {};
    const stops = [];
    const owners = [];
    try {
        for (const [i, s] of sources.entries()) {
            const cwd = join(root, s.role),
                dbs = {};
            const scratch = cwd + '-scratch';
            mkdirSync(scratch, { mode: 0o700 });
            stageCache(scratch, dependencyCache);
            const secret = clean();
            for (const c of readdirSync(join(cwd, 'components'))) {
                const d = join(cwd, 'components', c, 'app/models');
                if (!existsSync(d)) continue;
                for (const name of readdirSync(d).filter((n) => /^[a-zA-Z0-9]+Context\.js$/.test(n))) {
                    const id = name.slice(0, -3);
                    dbs[id] = { env: 'testing', type: 'sqlite', connection: join(cwd, id + '.sqlite') };
                }
            }
            const issuer = products.portal.origin;
            const config = {
                ...dbs,
                appUrl: s.origin,
                uiUrl: s.origin,
                issuer,
                publicApiUrl: issuer,
                encryptionKey: secret,
                admins: [],
                error: {},
                server: { hostname: '127.0.0.1', httpPort: apiPorts[i] }
            };
            writeFileSync(join(cwd, 'config/environments/env.testing.json'), JSON.stringify(config), { mode: 0o600 });
            const env = (serviceEnvs[s.role] = {
                ...cleanEnv,
                HOME: scratch,
                TMPDIR: '/tmp',
                npm_config_cache: join(scratch, 'cache'),
                MASTERRECORD_CONNECTION_OVERRIDE: JSON.stringify(dbs),
                API_ORIGIN: 'http://127.0.0.1:' + apiPorts[i],
                OPENBOOK_API_ORIGIN: 'http://127.0.0.1:' + apiPorts[i],
                SSO_ENCRYPTION_KEY: secret,
                ENCRYPTION_KEY: secret,
                APP_URL: s.origin,
                SSO_ISSUER: issuer,
                SSO_ORIGIN: issuer,
                SSO_UI_URL: issuer,
                NEXT_PUBLIC_SSO_ORIGIN: issuer
            });
            for (const workdir of [cwd, join(cwd, 'nextjs-app')])
                await native(cwd, [], [node, npm, 'ci', '--offline', '--no-audit', '--no-fund'], {
                    cwd: workdir,
                    env,
                    timeout: 180000
                });
            rmSync(join(scratch, 'cache'), { recursive: true });
            await native(
                cwd,
                [],
                s.role === 'portal'
                    ? [node, 'scripts/bootstrap-all.mjs', 'testing']
                    : [node, '--input-type=module', '-e', productBootstrap],
                { cwd, env }
            );
        }
        const output = join(root, 'portal-scratch', 'local-clients.json');
        await native(join(root, 'portal'), [], [node, '--input-type=module', '-e', seed], {
            cwd: join(root, 'portal'),
            env: {
                ...serviceEnvs.portal,
                QA_PRODUCTS: JSON.stringify({
                    vibeforce: products.vibeforce.origin,
                    openbook: products.openbook.origin
                }),
                QA_EMAIL: member.email,
                QA_PASSWORD: member.password,
                QA_ORG: products.portal.path.split('/')[3],
                QA_OUTPUT: output
            }
        });
        const clients = JSON.parse(readFileSync(output, 'utf8'));
        rmSync(output);
        for (const [i, s] of sources.entries()) {
            const cwd = join(root, s.role),
                env = { ...serviceEnvs[s.role], ...(s.role !== 'portal' ? { SSO_APP_TOKEN: clients[s.role] } : {}) };
            const api = native(cwd, ports, [node, 'server.js'], { cwd, env, background: true });
            stops.push(api.stop);
            const web = native(
                cwd,
                ports,
                [
                    node,
                    'node_modules/next/dist/bin/next',
                    'dev',
                    '--webpack',
                    '--hostname',
                    '127.0.0.1',
                    '--port',
                    String(frontPorts[i])
                ],
                { cwd: join(cwd, 'nextjs-app'), env, background: true }
            );
            stops.push(web.stop);
            // A successful HTTP read is never evidence of ownership: the supervised
            // listeners must also be the ones created by this profile.
            for (const [task, port] of [
                [api, apiPorts[i]],
                [web, frontPorts[i]]
            ])
                owners.push({ child: task.child, ended: task.ended, port });
        }
        function ownsListeners() {
            return owners.every(({ child, port, ended }) => {
                if (ended() || !child.pid || child.exitCode !== null || child.signalCode !== null) return false;
                return ownsSocket(child.pid, port);
            });
        }
        const deadline = Date.now() + 90000;
        while (!ownsListeners()) {
            if (owners.some(({ ended }) => ended()) || Date.now() > deadline) throw Error('fixture_unavailable');
            await delay(250);
        }
        return await use({
            member,
            ports,
            products,
            ownsListeners,
            apiOrigins: apiPorts.map((p) => 'http://localhost:' + p)
        });
    } finally {
        await Promise.all(stops.reverse().map((stop) => stop()));
    }
}
// First-party launch contract. The registered runner supplies the approved three
// source paths in plan order. Git objects are exported; a working tree never runs.

const repositories = new Map([
    ['vibeforce', 'Vibeforce/vibeforce-app'],
    ['openbook', 'Vibeforce/openbook'],
    ['portal', 'Vibeforce/SSO']
]);
export function scopedSources(plan, directories) {
    if (
        plan?.fixture_profile !== 'vibeforce_billing_v1' ||
        !Array.isArray(plan.products) ||
        plan.products.length !== 2 ||
        !Array.isArray(directories) ||
        directories.length !== 3
    )
        throw Error('fixture_unavailable');
    const inputs = [...plan.products, plan.state_source].map((source) => {
        const label = String(source?.product || '').toLowerCase();
        return { ...source, role: label === 'builder' ? 'vibeforce' : label };
    });
    const org = inputs[2]?.path?.match(/^\/user\/organizations\/([A-Za-z0-9_-]{1,64})\/billing$/)?.[1];
    if (!org) throw Error('fixture_unavailable');
    const approvedPaths = {
        vibeforce: new Set(['/dashboard', '/workspaces']),
        openbook: new Set(['/organizations/' + org, '/organizations/' + org + '/settings']),
        portal: new Set(['/user/organizations/' + org + '/billing'])
    };
    const ports = new Set();
    return inputs.map((source, index) => {
        if (
            !source ||
            !repositories.has(source.role) ||
            source.repository !== repositories.get(source.role) ||
            (index === 2) !== (source.role === 'portal') ||
            inputs.filter((p) => p?.role === source.role).length !== 1 ||
            !/^[0-9a-f]{40}$/.test(source.commit) ||
            source.ref !== 'refs/heads/main' ||
            typeof source.path !== 'string' ||
            !/^\/[A-Za-z0-9/_-]{0,150}$/.test(source.path) ||
            source.path.includes('//') ||
            (index === 2 && !/^\/user\/organizations\/[A-Za-z0-9_-]{1,64}\/billing$/.test(source.path))
        )
            throw Error('source_changed');
        if (!approvedPaths[source.role].has(source.path)) throw Error('fixture_unavailable');
        const origin = new URL(source.origin);
        if (
            origin.origin !== source.origin ||
            origin.protocol !== 'http:' ||
            origin.hostname !== 'localhost' ||
            Number(origin.port) !== frontendByRole[source.role] ||
            ports.has(origin.port)
        )
            throw Error('fixture_unavailable');
        ports.add(origin.port);
        const dir = directories[index];
        if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Error('source_changed');
        const git = (args, opts = {}) =>
            spawnSync('/usr/bin/git', ['--no-replace-objects', '-C', dir, ...args], {
                encoding: 'utf8',
                timeout: 30000,
                env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
                ...opts
            });
        const address = git(['remote', 'get-url', 'origin']);
        if (
            address.status !== 0 ||
            !['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].some(
                (prefix) =>
                    address.stdout
                        .trim()
                        .replace(/\.git$/i, '')
                        .toLowerCase() === (prefix + source.repository).toLowerCase()
            )
        )
            throw Error('source_changed');
        const commit = git(['rev-parse', '--verify', source.commit + '^{commit}']);
        if (commit.status !== 0 || commit.stdout.trim() !== source.commit) throw Error('source_changed');
        const files = git(['ls-tree', '-rz', source.commit], { maxBuffer: 24 * 1024 * 1024 });
        if (
            files.status !== 0 ||
            files.stdout
                .split('\0')
                .filter(Boolean)
                .some((row) => !/^100(?:644|755) blob [0-9a-f]{40}\t/.test(row))
        )
            throw Error('source_changed');
        return { ...source, git };
    });
}

// The profile owns this directory and every file beneath it. No reusable host
// worktree, dependency store, pre-existing listener, or customer DB is removed.
export async function withSourceExports(plan, directories, use) {
    const sources = scopedSources(plan, directories);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codebook-first-party-billing-')));
    chmodSync(root, 0o700);
    try {
        for (const { role, commit, git } of sources) {
            const dest = path.join(root, role);
            mkdirSync(dest, { mode: 0o700 });
            const archive = path.join(root, role + '.tar');
            const fd = openSync(archive, 'wx', 0o600);
            try {
                if (
                    git(['archive', '--format=tar', commit], { stdio: ['ignore', fd, 'ignore'], timeout: 60000 })
                        .status !== 0
                )
                    throw Error('source_changed');
            } finally {
                closeSync(fd);
            }
            const extracted = spawnSync('/usr/bin/tar', ['-xf', archive, '-C', dest], {
                stdio: 'ignore',
                timeout: 60000
            });
            if (extracted.status !== 0) throw Error('source_changed');
            rmSync(archive);
            for (const file of ['server.js', 'package-lock.json', 'nextjs-app/package-lock.json'])
                if (!existsSync(path.join(dest, file))) throw Error('source_changed');
        }
        return await use(
            root,
            sources.map(({ git, ...descriptor }) => descriptor)
        );
    } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
}

const boundedCode = (error) =>
    ['source_changed', 'session_missing', 'view_missing', 'browser_missing', 'capture_failed'].includes(error?.message)
        ? error.message
        : 'fixture_unavailable';

// Evaluate only the fixed product markup for the authorized synthetic member.
// No raw page, screenshots, cookies, or network payloads enter the report.
function readView(product, member, org, portalOrigin) {
    const switcher = document.querySelector('[data-bookbag-switcher][data-organization]');
    const visible = (e) => e && e.getClientRects().length > 0;
    const content = (e) => e?.innerText?.replace(/\s+/g, ' ').trim() || '';
    const sameAccount =
        product === 'portal'
            ? [...document.querySelectorAll('header span,header p,aside span,aside p,nav span,nav p')].some(
                  (e) => visible(e) && content(e) === member
              )
            : (() => {
                  try {
                      return JSON.parse(switcher?.getAttribute('data-user') || 'null')?.email === member;
                  } catch {
                      return false;
                  }
              })();
    if (!sameAccount || switcher?.getAttribute('data-organization') !== org) return null;
    if (product !== 'portal') {
        const scopedLink = [...document.querySelectorAll('a[href]')].some((a) => {
            try {
                const u = new URL(a.href);
                return u.origin === portalOrigin && u.pathname === '/user/organizations/' + org + '/billing';
            } catch {
                return false;
            }
        });
        if (!scopedLink) return null;
    }
    // Builder keeps the detailed meter in a disclosure in the live sidebar.
    for (const details of document.querySelectorAll('aside details,nav details')) {
        if (!details.open && /AI allowances|Work credits/.test(content(details.querySelector('summary'))))
            details.open = true;
    }
    let entitlement, value;
    if (product === 'portal') {
        const plan = [...document.querySelectorAll('p')].find(
            (e) => visible(e) && content(e) === 'Your shared workspace plan'
        );
        entitlement = content(plan?.parentElement?.querySelector('h2'));
        const meter = [...document.querySelectorAll('section')].find(
            (e) => visible(e) && content(e.querySelector('h3')) === 'DeepSeek plan tokens'
        );
        value = content(meter).match(/([\d,.]+) of ([\d,.]+) plan tokens remaining/i);
    } else {
        const roots = [...document.querySelectorAll('aside,nav,[data-sidebar="sidebar"],[data-slot="sidebar"]')].filter(
            visible
        );
        for (const root of roots) {
            if (product === 'vibeforce') {
                const meter = root.querySelector('section[aria-label="Shared Vibeforce plan tokens"]');
                if (!visible(meter)) continue;
                value = content(meter).match(/([\d,.]+) left of ([\d,.]+) plan tokens/i);
                entitlement = content(meter.closest('details')?.querySelector('summary .capitalize'));
            } else {
                const meter = [...root.querySelectorAll('p')].find(
                    (e) => visible(e) && /of [\d,.]+ plan tokens remaining/i.test(content(e))
                );
                if (!meter) continue;
                value = content(meter).match(/([\d,.]+) of ([\d,.]+) plan tokens remaining/i);
                const card = meter.parentElement?.parentElement;
                entitlement = content(card?.querySelector('.capitalize'));
            }
            if (value && entitlement) break;
        }
    }
    if (!/^(free|starter|pro|team|business|enterprise)$/i.test(entitlement || '') || !value) return null;
    const amounts = value.slice(1, 3).map((n) => n.replaceAll(',', ''));
    if (!amounts.every((n) => /^\d{1,12}(\.\d{1,6})?$/.test(n))) return null;
    return { entitlement: entitlement.toLowerCase(), value: amounts.map(Number).join('/') };
}

export async function observeProducts(root, sources, services) {
    const chrome = installedChromium();
    if (!chrome) throw Error('browser_missing');
    const { member, products, ownsListeners } = services;
    const origins = new Set([...sources.map((s) => s.origin), ...services.apiOrigins]),
        org = products.portal.path.split('/')[3];
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--remote-debugging-pipe',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-extensions',
            '--no-first-run',
            '--disable-component-update',
            '--disable-quic',
            '--proxy-server=http://127.0.0.1:0',
            '--proxy-bypass-list=<-loopback>;' + [...origins].map((origin) => new URL(origin).host).join(';'),
            '--user-data-dir=' + path.join(root, 'browser'),
            'about:blank'
        ],
        { env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    await once(browser, 'spawn');
    const timer = setTimeout(() => browser.kill('SIGKILL'), 180000);
    try {
        const cdp = devtools(browser),
            { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
        const call = (method, params) => cdp.call(method, params, sessionId);
        const evaluate = async (expression) =>
            (await call('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
        await call('Page.enable');
        await call('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 1080,
            deviceScaleFactor: 1,
            mobile: false
        });
        await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        let refusedDocument = false;
        cdp.on('Fetch.requestPaused', (e) => {
            const { requestId, request, resourceType } = e.params;
            let ok = false;
            try {
                ok = origins.has(new URL(request.url).origin);
            } catch {}
            if (!ok && resourceType === 'Document') refusedDocument = true;
            void call(
                ok ? 'Fetch.continueRequest' : 'Fetch.failRequest',
                ok ? { requestId } : { requestId, errorReason: 'BlockedByClient' }
            ).catch(() => {});
        });
        const key = randomBytes(32),
            digest = (domain, val) =>
                createHmac('sha256', key)
                    .update(domain + '\0' + val)
                    .digest('hex');
        const observations = [];
        for (const s of sources) {
            if (!ownsListeners()) throw Error('source_changed');
            const entry = s.role === 'vibeforce' && s.path === '/dashboard' ? '/organizations/' + org : s.path;
            const start =
                s.role === 'portal' ? s.origin + s.path : s.origin + '/auth/login?next=' + encodeURIComponent(entry);
            await call('Page.navigate', { url: start });
            const deadline = Date.now() + 55000;
            let view = null,
                submitted = false,
                atProtected = false;
            while (Date.now() < deadline && !view) {
                if (refusedDocument) throw Error('session_missing');
                let current;
                try {
                    current = new URL(await evaluate('location.href'));
                } catch {
                    await delay(100);
                    continue;
                }
                if (current.origin === products.portal.origin && current.pathname === '/auth/login' && !submitted) {
                    const ready = await evaluate(`(() => {
                        const email=document.querySelector('input[type=email]'), password=document.querySelector('input[type=password]');
                        if(!email||!password||!email.form||email.form!==password.form||document.readyState!=='complete')return false;
                        if(!Object.keys(email.form).some(name=>name.startsWith('__reactProps$')))return false;
                        email.focus();email.select();return true;})()`);
                    if (ready) {
                        await call('Input.insertText', { text: member.email });
                        await evaluate("document.querySelector('input[type=password]').focus()");
                        await call('Input.insertText', { text: member.password });
                        await call('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            key: 'Enter',
                            code: 'Enter',
                            windowsVirtualKeyCode: 13
                        });
                        await call('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: 'Enter',
                            code: 'Enter',
                            windowsVirtualKeyCode: 13
                        });
                        submitted = true;
                    }
                } else if (current.origin === s.origin && current.pathname === s.path) {
                    atProtected = true;
                    view = await evaluate(
                        '(' +
                            readView.toString() +
                            ')(' +
                            [s.role, member.email, org, products.portal.origin]
                                .map((x) => JSON.stringify(x))
                                .join(',') +
                            ')'
                    );
                }
                if (!view) await delay(150);
            }
            if (!view) throw Error(atProtected ? 'view_missing' : 'session_missing');
            if (!ownsListeners()) throw Error('source_changed');
            observations.push({
                product: s.product,
                repository: s.repository,
                commit: s.commit,
                origin: s.origin,
                path: s.path,
                signed_in: true,
                account_digest: digest('account', member.email),
                organization_digest: digest('organization', org),
                entitlement_digest: digest('entitlement', view.entitlement),
                value_digest: digest('value', view.value)
            });
        }
        return observations;
    } finally {
        clearTimeout(timer);
        if (browser.exitCode === null && browser.signalCode === null) {
            const closed = once(browser, 'exit');
            browser.kill('SIGKILL');
            await closed;
        }
    }
}
export async function captureFirstPartyBilling({ plan, directories, dependency_cache }) {
    const base = {
        definition: plan?.definition,
        fixture_profile: 'vibeforce_billing_v1',
        executor_id: plan?.executor_id
    };
    try {
        if (!privateLinuxReady() || typeof dependency_cache !== 'string' || !path.isAbsolute(dependency_cache))
            throw Error('fixture_unavailable');
        await reserveCheck([...Object.values(frontendByRole), ...Object.values(apiByRole)]);
        const observations = await withSourceExports(plan, directories, (root, sources) =>
            withFirstPartyServices(root, sources, dependency_cache, (services) =>
                observeProducts(root, sources, services)
            )
        );
        return { ...base, observations };
    } catch (error) {
        return { ...base, unavailable: boundedCode(error) };
    }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.write(JSON.stringify(await captureFirstPartyBilling(JSON.parse(process.argv[2]))));
}
