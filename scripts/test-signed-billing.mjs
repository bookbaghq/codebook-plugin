import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureSignedBilling } from './signed-billing.mjs';

async function port() {
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
}
async function fixture(t, secondValue) {
    const root = mkdtempSync(join(tmpdir(), 'signed-billing-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directories = [],
        products = [];
    for (const [i, product] of ['first', 'second'].entries()) {
        const dir = join(root, product);
        mkdirSync(join(dir, '.codebook', 'fixtures'), { recursive: true });
        const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
        git('init', '--quiet', '-b', 'main');
        git('remote', 'add', 'origin', 'https://github.com/fixture/' + product + '.git');
        writeFileSync(
            join(dir, '.codebook/fixtures/synthetic-billing-v1.json'),
            JSON.stringify({ product, profile: 'synthetic_billing_v1', balance: i ? secondValue : '6/10' })
        );
        git('add', '.');
        git(
            '-c',
            'user.name=QA',
            '-c',
            'user.email=qa@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'Fixture'
        );
        directories.push(dir);
        products.push({
            product,
            repository: 'fixture/' + product,
            ref: 'refs/heads/main',
            commit: git('rev-parse', 'HEAD'),
            origin: 'http://127.0.0.1:' + (await port())
        });
    }
    return {
        directories,
        plan: { fixture_profile: 'synthetic_billing_v1', definition: 'f'.repeat(64), path: '/billing', products }
    };
}
test('Native signed-in billing comparison observes both rendered fixture products', async (t) => {
    for (const value of ['6/10', '5/10']) {
        const input = await fixture(t, value);
        const result = await captureSignedBilling(input);
        assert.equal(result.unavailable, undefined);
        const [a, b] = result.observations;
        assert.equal(a.signed_in && b.signed_in, true);
        assert.equal(a.account_digest, b.account_digest);
        assert.match(a.account_digest, /^[a-f0-9]{64}$/);
        assert.equal(a.value_digest === b.value_digest, value === '6/10');
        assert.doesNotMatch(JSON.stringify(result), /tester-|6\/10|5\/10|password|session=/);
        for (const product of input.plan.products) await assert.rejects(fetch(product.origin + '/billing'));
    }
});
test('Native signed-in billing comparison refuses an unsupported fixture or incomplete observation', async (t) => {
    const input = await fixture(t, '6/10');
    const [a, b] = input.plan.products;
    const occupied = net.createServer();
    occupied.listen(Number(new URL(b.origin).port), '127.0.0.1');
    await once(occupied, 'listening');
    try {
        assert.equal((await captureSignedBilling(input)).unavailable, 'fixture_unavailable');
        await assert.rejects(fetch(a.origin + '/billing'));
        assert.ok(occupied.listening);
    } finally {
        await new Promise((resolve) => occupied.close(resolve));
    }
    b.commit = '0'.repeat(40);
    assert.equal((await captureSignedBilling(input)).unavailable, 'source_changed');
    input.plan.fixture_profile = 'vibeforce_billing_v1';
    assert.equal((await captureSignedBilling(input)).unavailable, 'fixture_unavailable');
});
