import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureFirstPartyBilling, scopedSources, withSourceExports, privateLinuxReady } from './vibeforce-billing.mjs';

const cases = [
    ['Builder', 'Vibeforce/vibeforce-app', 3001, '/dashboard'],
    ['openbook', 'Vibeforce/openbook', 3000, '/organizations/qa267/settings'],
    ['portal', 'Vibeforce/SSO', 3100, '/user/organizations/qa267/billing']
];

// Minimal repositories exercise source inventory and cleanup only. They cannot
// satisfy the real browser acceptance at the bottom of this file.
function sources(t) {
    const root = mkdtempSync(join(tmpdir(), 'codebook-profile-sources-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directories = [],
        products = [];
    for (const [label, repository, port, path] of cases) {
        const dir = join(root, label);
        mkdirSync(join(dir, 'nextjs-app'), { recursive: true });
        const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
        git('init', '--quiet', '-b', 'main');
        git('remote', 'add', 'origin', 'https://github.com/' + repository + '.git');
        for (const name of ['server.js', 'package-lock.json', 'nextjs-app/package-lock.json'])
            writeFileSync(join(dir, name), '{}\n');
        git('add', '.');
        git(
            '-c',
            'user.email=qa@example.invalid',
            '-c',
            'user.name=QA',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'Inventory fixture'
        );
        const commit = git('rev-parse', 'HEAD');
        directories.push(dir);
        products.push({
            product: label,
            repository,
            ref: 'refs/heads/main',
            commit,
            origin: 'http://localhost:' + port,
            path
        });
    }
    return {
        directories,
        plan: {
            fixture_profile: 'vibeforce_billing_v1',
            definition: 'f'.repeat(64),
            executor_id: 1,
            products: products.slice(0, 2),
            state_source: products[2]
        }
    };
}
test('A billing source export contains only the three approved Git snapshots and is removed after failure', async (t) => {
    const { plan, directories } = sources(t);
    writeFileSync(join(directories[0], 'untracked'), 'must stay out');
    let allocated;
    await assert.rejects(
        withSourceExports(plan, directories, async (root, items) => {
            allocated = root;
            assert.deepEqual(
                items.map((x) => x.role),
                ['vibeforce', 'openbook', 'portal']
            );
            assert.equal(existsSync(join(root, 'vibeforce', 'untracked')), false);
            assert.equal(existsSync(join(root, 'portal', 'server.js')), true);
            throw Error('injected shutdown');
        }),
        /injected shutdown/
    );
    assert.equal(existsSync(allocated), false);
    for (const dir of directories) assert.ok(existsSync(dir));
});
test('The real billing profile refuses unrelated origins, paths, source commits and a shared host', async (t) => {
    const { plan, directories } = sources(t);
    for (const change of [
        { path: '/admin' },
        { origin: 'http://127.0.0.1:3001' },
        { origin: 'http://localhost:8080' },
        { commit: '0'.repeat(40) }
    ]) {
        const altered = structuredClone(plan);
        Object.assign(altered.products[0], change);
        assert.throws(() => scopedSources(altered, directories));
    }
    if (!privateLinuxReady()) {
        const result = await captureFirstPartyBilling({ plan, directories, dependency_cache: tmpdir() });
        assert.equal(result.unavailable, 'fixture_unavailable');
        assert.equal(result.observations, undefined);
    }
});
const jobPath = process.env.CODEBOOK_FIRST_PARTY_BILLING_TEST_JOB;
test(
    'First-party signed-in billing compares both real product sidebar meters',
    { skip: !jobPath ? 'requires three approved first-party checkouts and the private Linux proof job' : false },
    async () => {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const result = await captureFirstPartyBilling(job);
        assert.equal(result.unavailable, undefined);
        assert.equal(result.observations.length, 3);
        for (const key of ['account_digest', 'organization_digest', 'entitlement_digest', 'value_digest']) {
            const observed = result.observations.map((row) => row[key]);
            assert.match(observed[0], /^[a-f0-9]{64}$/);
            assert.equal(new Set(observed).size, 1);
        }
    }
);
