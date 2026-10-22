import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckProvider } from '../dist/index.js';
import { readFile } from 'node:fs/promises';

test('Rust and Node providers share the exact wire fixtures', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../../../fixtures/server/checks.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const provider = createCheckProvider({
      readPolicy: fixture.policy,
      authenticate: async () => {
        if (fixture.hostError) throw Error('private failure');
        return fixture.authenticated === false ? null : { binding: fixture.binding, principal: {} };
      },
      authorize: async () => fixture.decision ? { allowed: false, reason: fixture.decision } : { allowed: true, metadata: fixture.metadata },
    });
    const result = await provider.check({ query: fixture.query, context: {}, target: {} });
    assert.deepEqual(result.headers, { 'Cache-Control': 'no-store' });
    const body = { ...result.body }; delete body.epoch;
    assert.deepEqual({ status: result.status, body }, fixture.expected, fixture.name);
  }
});

const metadata = { scopeId: 'workspace-1', resourceId: 'article-1', contentHash: 'a'.repeat(64) };
const input = { query: { requestId: 'request-1' }, context: { cookie: 'private-session' }, target: { id: 'article-1' } };
const options = (extra = {}) => ({
  authenticate: async () => ({ binding: 'account/user', principal: { id: 'user' } }),
  authorize: async () => ({ allowed: true, metadata }), ...extra,
});

for (const product of ['Space', 'Logca', 'AccelBoard']) {
  test(`${product} host adapter: metadata-only complete check and fresh epochs`, async () => {
    const provider = createCheckProvider(options({
      authenticate: async context => {
        assert.equal(context, input.context);
        return { binding: `${product}/user`, principal: { id: 'user' }, token: 'must-not-leak' };
      },
      authorize: async ({ principal, target, context }) => {
        assert.deepEqual(principal, { id: 'user' }); assert.equal(target, input.target); assert.equal(context, input.context);
        return { allowed: true, metadata: { ...metadata, body: 'private-body', token: 'private-token' } };
      },
    }));
    const result = await provider.check(input);
    assert.equal(result.status, 200); assert.deepEqual(result.headers, { 'Cache-Control': 'no-store' });
    const { epoch, ...rest } = result.body;
    assert.match(epoch, /^[a-f0-9-]{36}$/);
    assert.deepEqual(rest, { ...metadata, schemaVersion: 1, mode: 'check_only', requestId: 'request-1', binding: `${product}/user`, leaseMs: 5000, readPolicy: { mode: 'online_only', maxOfflineMs: 0 } });
    assert.notEqual((await provider.check(input)).body.epoch, epoch);
  });
}

test('invalid JSON query is rejected before authentication; exact nonce grammar/length', async () => {
  let calls = 0;
  const provider = createCheckProvider(options({ authenticate: async () => { calls++; throw Error('private'); } }));
  for (const query of [{}, { requestId: '' }, { requestId: null }, { requestId: ['a'] }, { requestId: 1 }, { requestId: 'a b' }, { requestId: 'a\n' }, { requestId: 'a'.repeat(129) }, { requestId: 'ok', binding: 'spoof' }]) {
    const result = await provider.check({ ...input, query });
    assert.deepEqual(result, { status: 400, headers: { 'Cache-Control': 'no-store' }, body: { error: { code: 'invalid_authz_check' } } }, JSON.stringify(query));
  }
  assert.equal(calls, 0);
  const good = createCheckProvider(options());
  for (const requestId of ['a', 'a'.repeat(128), 'a_B-1']) assert.equal((await good.check({ ...input, query: { requestId } })).status, 200);
});

test('missing user and explicit denials fail closed without granting metadata', async () => {
  let calls = 0;
  const unauth = createCheckProvider(options({ authenticate: async () => null, authorize: async () => { calls++; throw Error(); } }));
  assert.deepEqual(await unauth.check(input), { status: 401, headers: { 'Cache-Control': 'no-store' }, body: { error: { code: 'user_session_required' } } });
  assert.equal(calls, 0);
  for (const [reason, status, code] of [['forbidden', 403, 'access_required'], ['not_found', 404, 'resource_not_found']]) {
    assert.deepEqual(await createCheckProvider(options({ authorize: async () => ({ allowed: false, reason }) })).check(input), { status, headers: { 'Cache-Control': 'no-store' }, body: { error: { code } } });
  }
});

test('host errors and malformed trusted adapter outputs return sanitized 503', async () => {
  const secretError = () => { throw Error('secret-token and private-host'); };
  const variants = [
    { authenticate: secretError }, { authorize: secretError },
    { authenticate: async () => ({ binding: '', principal: {} }) },
    { authenticate: async () => ({ binding: 'x'.repeat(4097), principal: {} }) },
    { authorize: async () => ({ allowed: false, reason: 'unknown' }) },
    { authorize: async () => ({ allowed: 'yes', metadata }) },
    ...[{ scopeId: '' }, { resourceId: '' }, { scopeId: 'x'.repeat(4097) }, { contentHash: 'invalid' }, { contentHash: 'A'.repeat(64) }].map(patch => ({ authorize: async () => ({ allowed: true, metadata: { ...metadata, ...patch } }) })),
  ];
  for (const extra of variants) {
    assert.deepEqual(await createCheckProvider(options(extra)).check(input), { status: 503, headers: { 'Cache-Control': 'no-store' }, body: { error: { code: 'authz_check_unavailable' } } });
  }
});

test('server minute policy and lease limits validated at construction and copied', async () => {
  for (const readPolicy of [{ mode: 'offline_ttl', ttlMinutes: '30' }, { mode: 'offline_ttl', ttlMinutes: 0 }, { mode: 'offline_ttl', ttlMinutes: -1 }, { mode: 'offline_ttl', ttlMinutes: 1441 }, { mode: 'offline_ttl', ttlMinutes: NaN }, { mode: 'offline_ttl', ttlMinutes: Infinity }, { mode: 'other' }]) {
    assert.throws(() => createCheckProvider(options({ readPolicy })), /authz_server_config_invalid/);
  }
  for (const leaseMs of [0, -1, 5001, 1.5, NaN]) assert.throws(() => createCheckProvider(options({ leaseMs })), /authz_server_config_invalid/);
  const config = options({ readPolicy: { mode: 'offline_ttl', ttlMinutes: 30 }, leaseMs: 1000 });
  const provider = createCheckProvider(config);
  config.readPolicy.ttlMinutes = 1440; config.leaseMs = 5000;
  const result = await provider.check(input);
  assert.equal(result.body.leaseMs, 1000); assert.deepEqual(result.body.readPolicy, { mode: 'offline_ttl', maxOfflineMs: 1800000 });
  for (const ttlMinutes of [1, 1440]) assert.equal((await createCheckProvider(options({ readPolicy: { mode: 'offline_ttl', ttlMinutes } })).check(input)).body.readPolicy.maxOfflineMs, ttlMinutes * 60000);
});

test('every request reauthorizes; concurrent products and users remain isolated', async () => {
  let allowed = true, calls = 0;
  const provider = createCheckProvider(options({
    authenticate: async context => ({ binding: context.user, principal: { id: context.user } }),
    authorize: async ({ principal }) => { calls++; return allowed ? { allowed: true, metadata: { ...metadata, resourceId: principal.id } } : { allowed: false, reason: 'forbidden' }; },
  }));
  const responses = await Promise.all(['one', 'two'].map(user => provider.check({ ...input, context: { user } })));
  assert.deepEqual(responses.map(r => [r.body.binding, r.body.resourceId]), [['one', 'one'], ['two', 'two']]);
  allowed = false;
  assert.equal((await provider.check({ ...input, context: { user: 'one' } })).status, 403);
  assert.equal(calls, 3);
});
