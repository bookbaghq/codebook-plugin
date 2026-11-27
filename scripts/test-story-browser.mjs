// Run the official proof hook and its Chrome process against an owned loopback server.
// The private claim is synthetic and valid only for this disposable server.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
registerHooks({
    resolve(name, context, next) {
        if (
            name.startsWith('.') &&
            context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) &&
            !path.extname(name)
        ) {
            const ts = new URL(name + '.ts', context.parentURL);
            if (existsSync(ts)) return { url: ts.href, shortCircuit: true };
        }
        return next(name, context);
    }
});
const { runProof } = await import('../hooks/proof.ts');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const tmp = mkdtempSync(path.join(tmpdir(), 'story-browser-witness-')),
    dir = path.join(tmp, 'checkout');
mkdirSync(dir);
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const repo = 'https://git.example.test/sample/static-docs',
    name = 'sample/static-docs';
const token = randomBytes(32).toString('hex');
const receipt = [];
let claimed = false,
    outsideRequests = 0;
const outside = createServer((_req, res) => {
    outsideRequests++;
    res.end('external content');
});
const receiver = createServer(async (req, res) => {
    if (req.url !== '/report' || req.headers.authorization !== 'Bearer ' + token || !claimed) {
        res.writeHead(401);
        res.end();
        return;
    }
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.run, 11);
    claimed = false;
    receipt.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
        JSON.stringify({
            data: true,
            status: body.unavailable ? 'error' : body.observations.every(Boolean) ? 'passed' : 'failed'
        })
    );
});
try {
    outside.listen(0, '127.0.0.1');
    receiver.listen(0, '127.0.0.1');
    await Promise.all([once(outside, 'listening'), once(receiver, 'listening')]);
    git('init', '-q');
    git('remote', 'add', 'origin', repo + '.git');
    writeFileSync(path.join(dir, 'guide.html'), '<main>Choose a setting. Hold until verified.</main>');
    writeFileSync(
        path.join(dir, 'redirect.html'),
        '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:' + outside.address().port + '/external">'
    );
    git('add', 'guide.html', 'redirect.html');
    git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'static fixture'
    );
    const commit = git('rev-parse', 'HEAD').trim(),
        report_url = 'http://127.0.0.1:' + receiver.address().port + '/report';
    let plan = {
        criterion: 4,
        path: '/guide',
        definition: digest('plan 4'),
        visible_text: ['Choose a setting', 'Hold until verified.']
    };
    const engine = {
        plugin: { root },
        env: { get: async (key) => (key === 'HOME' ? tmp : undefined) },
        mcp: {
            connect: async () => ({ isConnected: true, server: 'fixture' }),
            call: async (_server, tool, args) => {
                assert.equal(tool, 'claim_proof');
                assert.equal(args.story_browser_version, 1);
                let data;
                if (args.peek)
                    data = {
                        waiting: [
                            {
                                proof: 11,
                                commands: ['story_browser'],
                                story_browser_version: 1,
                                repository: name,
                                commit,
                                worktree: dir
                            }
                        ]
                    };
                else {
                    assert.equal(args.proof, 11);
                    assert.equal(claimed, false);
                    claimed = true;
                    data = {
                        proof: 11,
                        proof_scope: 'story_browser_v1',
                        expected_commit: commit,
                        repository: { full_name: name, url: repo },
                        steps: [{ run: 11, name: 'story_browser', story_browser: plan }],
                        token,
                        report_url
                    };
                }
                return { structuredContent: data, content: [] };
            }
        },
        process: {
            run: async (argv, opts = {}) => {
                const result = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd || dir, encoding: 'utf8' });
                return { exitCode: result.status ?? 1, stdout: result.stdout || '' };
            },
            async *spawn({ argv }) {
                assert.ok(
                    argv.includes(path.join(root, 'scripts/story-browser.mjs')) ||
                        argv.some((arg) => arg.endsWith('/scripts/story-browser.mjs'))
                );
                assert.ok(
                    !JSON.stringify(argv).includes(token),
                    'the native report credential never enters the browser process'
                );
                const child = spawn(argv[0], argv.slice(1), { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
                const ended = once(child, 'exit');
                for await (const bytes of child.stdout) yield { stream: 'stdout', text: bytes.toString() };
                assert.equal((await ended)[0], 0);
            }
        },
        http: {
            fetch: async (url, init) => {
                assert.equal(url, report_url);
                const res = await fetch(url, init);
                return { ok: res.ok, status: res.status, text: await res.text() };
            }
        }
    };
    const run = async () => {
        const result = await runProof(engine, { proof: 11, known: [{ repository: name, checkoutPath: dir }] });
        assert.ok(result.isRun, result.text);
        return receipt.at(-1);
    };
    const pass = await run();
    assert.equal(pass.commit, commit);
    assert.equal(pass.http_status, 200);
    assert.deepEqual(pass.observations, [true, true]);
    assert.equal(digest(Buffer.from(pass.screenshot, 'base64')), pass.screenshot_sha256);
    assert.equal(digest(JSON.stringify(['/guide', 200, [true, true]])), pass.trace_sha256);
    plan = { ...plan, criterion: 5, definition: digest('plan 5'), visible_text: ['Never present'] };
    assert.deepEqual((await run()).observations, [false]);
    plan = { ...plan, path: '/redirect' };
    assert.equal((await run()).unavailable, 'outside_preview');
    assert.equal(outsideRequests, 0);
    writeFileSync(path.join(dir, 'guide.html'), '<main>changed</main>');
    assert.equal((await run()).unavailable, 'source_changed');
} finally {
    for (const server of [receiver, outside])
        if (server.listening)
            await new Promise((done) => {
                server.close(done);
                server.closeAllConnections();
            });
    rmSync(tmp, { recursive: true, force: true });
}

console.log('(pass) the installed story browser executor confines its preview and reports authenticated evidence');
