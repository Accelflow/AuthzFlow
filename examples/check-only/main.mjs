import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const installed = process.env.AUTHZFLOW_INSTALLED_PACKAGES === '1';
const { createCheckedReader } = await import(installed ? '@authzflow/core' : '../../packages/core/dist/index.js');
const { createCheckProvider } = await import(installed ? '@authzflow/server' : '../../packages/server/dist/index.js');

// In-memory storage and a synthetic authenticated session are demonstration adapters.
// Applications must supply their own verified session, canonical content hash and durable atomic CAS.
let allowed = true, disconnected = false, checkpoint = null, now = 100, wall = 1000;
const article = { id: 'article', title: 'A checked article' };
const hash = value => createHash('sha256').update(JSON.stringify([value.id, value.title])).digest('hex');
const provider = createCheckProvider({
  readPolicy: { mode: 'offline_ttl', ttlMinutes: 1 },
  authenticate: async () => ({ binding: 'demo/user', principal: { id: 'user' } }),
  authorize: async () => allowed ? { allowed: true, metadata: { scopeId: 'workspace', resourceId: 'article', contentHash: hash(article) } } : { allowed: false, reason: 'forbidden' },
});
const reader = await createCheckedReader({
  binding: 'demo/user', scopeId: 'workspace', resourceId: 'article',
  wasmBytes: new Uint8Array(await readFile(installed ? new URL('../wasm/authzflow_wasm_bg.wasm', import.meta.resolve('@authzflow/core')) : new URL('../../packages/core/wasm/authzflow_wasm_bg.wasm', import.meta.url))),
  session: async () => ({ binding: 'demo/user', context: 'signed-in-session', expiresAtMs: 1000000 }),
  clock: () => ({ boot: 'demo-boot', now_ms: now, wall_ms: wall }),
  storage: {
    load: async () => structuredClone(checkpoint),
    commit: async plan => {
      if (plan.expected_revision !== (checkpoint?.revision ?? '0')) throw Error('cas_conflict');
      checkpoint = structuredClone(plan.next); return checkpoint.revision;
    },
  },
  check: async ({ requestId }) => {
    if (disconnected) throw new TypeError('network disconnected');
    const result = await provider.check({ query: { requestId }, context: {}, target: { id: 'article' } });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
  },
  read: async () => structuredClone(article), contentHash: async value => hash(value),
});
try {
  const delivery = await reader.readWithPermit();
  assert.deepEqual(delivery.value, article); assert.equal(delivery.validForMs, 60000); assert.equal(delivery.expiresAtMs, 61000);
  disconnected = true; now += 59999; wall += 59999;
  const offlineDelivery = await reader.readWithPermit();
  assert.deepEqual(offlineDelivery.value, article); assert.equal(offlineDelivery.validForMs, 1); assert.equal(offlineDelivery.expiresAtMs, delivery.expiresAtMs);
  now++; wall++; await assert.rejects(reader.read(), /authz_offline_expired/);
  disconnected = false; assert.deepEqual(await reader.read(), article);
  allowed = false; await assert.rejects(reader.read(), /authz_check_denied/);
  assert.equal(checkpoint.resources.article.access, 'deny');
  console.log('PASS: complete check, bounded offline read, exact expiry and durable denial');
} finally { reader.close(); }
