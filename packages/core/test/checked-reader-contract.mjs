import test from 'node:test';
import assert from 'node:assert/strict';
export function registerCheckedReaderContract(name,createCheckedReader,wasmBytes){
const suite=(title,run)=>test(name+': '+title,run);
async function fixture(overrides = {}) {
  let now = 100, wall = 1000, saved = null, denied = false, offline = false, context = 'session-1', value = 'article', commits = 0, checks = 0;
  const config = {
    binding: 'account/user', scopeId: 'workspace', resourceId: 'article', wasmBytes,
    session: async () => ({ binding: 'account/user', context, expiresAtMs: 1000000 }),
    clock: () => ({ boot: 'boot', now_ms: now, wall_ms: wall }),
    storage: {
      load: async () => structuredClone(saved),
      commit: async plan => {
        assert.equal(plan.expected_revision, saved?.revision ?? '0'); commits++;
        saved = structuredClone(plan.next); return saved.revision;
      },
    },
    check: async ({ requestId }) => {
      checks++;if (offline) throw new TypeError('network unavailable');
      return { status: denied ? 403 : 200, json: async () => ({ schemaVersion: 1, mode: 'check_only', requestId, binding: 'account/user', scopeId: 'workspace', resourceId: 'article', contentHash: 'a'.repeat(64), epoch: 'epoch', leaseMs: 5000, readPolicy: { mode: 'offline_ttl', maxOfflineMs: 60000 } }) };
    },
    read: async () => value,
    contentHash: async v => (v === 'article' ? 'a' : 'b').repeat(64),
    ...overrides,
  };
  return { reader: await createCheckedReader(config), config, advance(ms) { now += ms; wall += ms; }, sleep(ms) { wall += ms; }, offline() { offline = true; }, deny() { denied = true; }, switch() { context = 'session-2'; }, change() { value = 'changed'; },restore(){value='article';},checks:()=>checks,corrupt(){saved.revision=String(BigInt(saved.revision)+1n);}, saved: () => saved, commits: () => commits };
}
suite('cached permit read uses Rust without check, renewal or cold-start permission',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.reader.readCachedWithPermit(),/authz_cached_permit_missing/);
  const first=await f.reader.readWithPermit(),checks=f.checks();f.advance(1000);const cached=await f.reader.readCachedWithPermit();assert.equal(cached.value,'article');assert.equal(cached.offline,true);assert.equal(cached.expiresAtMs,first.expiresAtMs);assert.equal(cached.validForMs,59000);assert.equal(f.checks(),checks);
  f.advance(59000);await assert.rejects(f.reader.readCachedWithPermit(),/authz_offline_expired/);
 }finally{f.reader.close();}
});
suite('a different cached content does not destroy an otherwise valid permit',async()=>{
 const f=await fixture();try{await f.reader.read();f.change();await assert.rejects(f.reader.readCachedWithPermit(),/authz_content_changed/);f.restore();assert.equal((await f.reader.readCachedWithPermit()).value,'article');}finally{f.reader.close();}
});
suite('cached permission rejects session, durable revision, clock and closed changes',async()=>{
 for(const action of ['switch','corrupt','sleep']){const f=await fixture();try{await f.reader.read();f[action](60000);await assert.rejects(f.reader.readCachedWithPermit());}finally{f.reader.close();}}
 const f=await fixture();await f.reader.read();f.reader.close();await assert.rejects(f.reader.readCachedWithPermit(),/runtime_unavailable/);
});
suite('complete check, durable CAS, exact content and immediate revocation', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.reader.read(), 'article'); assert.equal(f.commits(), 1);
    f.deny(); await assert.rejects(f.reader.read(), /authz_check_denied/);
    assert.equal(f.saved().resources.article.access, 'deny');
  } finally { f.reader.close(); }
});
suite('bounded offline permit expires exactly and cannot be extended by failed checks', async () => {
  const f = await fixture();
  try {
    await f.reader.read(); f.offline(); f.advance(59999); assert.equal(await f.reader.read(), 'article');
    f.advance(1); await assert.rejects(f.reader.read(), /authz_offline_expired/);
  } finally { f.reader.close(); }
});
suite('online-only default and cold start never reuse saved offline permission', async () => {
  const f = await fixture(); await f.reader.read(); f.reader.close(); f.offline();
  const cold = await createCheckedReader(f.config);
  try { await assert.rejects(cold.read(), /authz_offline_expired/); } finally { cold.close(); }
  const online = await fixture({ check: async ({ requestId }) => ({ status: 200, json: async () => ({ schemaVersion: 1, mode: 'check_only', requestId, binding: 'account/user', scopeId: 'workspace', resourceId: 'article', contentHash: 'a'.repeat(64), epoch: 'online', leaseMs: 5000, readPolicy: { mode: 'online_only', maxOfflineMs: 0 } }) }) });
  try { assert.equal(await online.reader.read(), 'article'); } finally { online.reader.close(); }
});
suite('malformed authority response cannot grant cached access', async () => {
  for (const patch of [{ requestId: 'other' }, { binding: 'other' }, { resourceId: 'other' }, { scopeId: 'other' }, { contentHash: 'bad' }, { leaseMs: 5001 }, { readPolicy: { mode: 'offline_ttl', maxOfflineMs: 86400001 } }]) {
    const f = await fixture({ check: async ({ requestId }) => ({ status: 200, json: async () => ({ schemaVersion: 1, mode: 'check_only', requestId, binding: 'account/user', scopeId: 'workspace', resourceId: 'article', contentHash: 'a'.repeat(64), epoch: 'e', leaseMs: 5000, readPolicy: { mode: 'online_only', maxOfflineMs: 0 }, ...patch }) }) });
    try { await assert.rejects(f.reader.read(), /authz_check_invalid/, JSON.stringify(patch)); assert.equal(f.commits(), 0); } finally { f.reader.close(); }
  }
});
suite('session change, sleep, content change, close and persistence failure deny reads', async () => {
  for (const action of ['switch', 'sleep', 'change']) {
    const f = await fixture();
    try { await f.reader.read(); f.offline(); f[action](60000); await assert.rejects(f.reader.read()); } finally { f.reader.close(); }
  }
  const f = await fixture(); f.reader.close(); await assert.rejects(f.reader.read(), /runtime_unavailable/);
  const broken = await fixture({ storage: { load: async () => null, commit: async () => { throw Error('storage failure'); } } });
  try { await assert.rejects(broken.reader.read(), /storage failure/); } finally { broken.reader.close(); }
});
suite('HTTP backend failure does not become offline permission', async () => {
  const f = await fixture({ check: async () => ({ status: 503, json: async () => ({}) }) });
  try { await assert.rejects(f.reader.read(), /authz_check_unavailable/); } finally { f.reader.close(); }
});
suite('overlap is rejected and close or session change fences an in-flight check', async () => {
  for (const action of ['close', 'switch']) {
    let respond;
    const f = await fixture({ check: ({ requestId }) => new Promise(resolve => { respond = () => resolve({ status: 200, json: async () => ({ schemaVersion: 1, mode: 'check_only', requestId, binding: 'account/user', scopeId: 'workspace', resourceId: 'article', contentHash: 'a'.repeat(64), epoch: 'e', leaseMs: 5000, readPolicy: { mode: 'online_only', maxOfflineMs: 0 } }) }); }) });
    const pending = f.reader.read();
    await new Promise(setImmediate);
    await assert.rejects(f.reader.read(), /check_in_progress/);
    if (action === 'close') f.reader.close(); else f.switch();
    respond(); await assert.rejects(pending, /context_changed/); assert.equal(f.commits(), 0); f.reader.close();
  }
});
suite('hash validation returns an isolated snapshot even if the host cache mutates', async () => {
  const original = { title: 'original' };
  const f = await fixture({ read: async () => original, contentHash: async () => { original.title = 'changed'; return 'a'.repeat(64); } });
  try { assert.deepEqual(await f.reader.read(), { title: 'original' }); } finally { f.reader.close(); }
});
suite('UI permit reports only remaining time and offline reads cannot renew it', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.reader.readWithPermit(), { value: 'article', validForMs: 60000, expiresAtMs: 61000, offline: false });
    f.offline(); f.advance(59999);
    assert.deepEqual(await f.reader.readWithPermit(), { value: 'article', validForMs: 1, expiresAtMs: 61000, offline: true });
    f.advance(1); await assert.rejects(f.reader.readWithPermit(), /authz_offline_expired/);
  } finally { f.reader.close(); }
});

  suite('initial denial is durable even before any successful grant',async()=>{
    const f=await fixture();f.deny();
    await assert.rejects(f.reader.read(),/authz_check_denied/);
    assert.equal(f.saved().resources.article.access,'deny');assert.equal(f.saved().revision,'1');f.reader.close();
  });

}
