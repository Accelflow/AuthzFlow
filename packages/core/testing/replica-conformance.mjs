import test from 'node:test';
import assert from 'node:assert/strict';
/** Node test entrypoint. Fixtures use real host transactions; inventory is privileged test-only raw inspection. */
export function registerReplicaConformance({name,createFixture}) {
 const scenario=(title,run)=>test(`${name}: ${title}`,async()=>{const f=await createFixture();try{await run(f);}finally{await f.close();}});
 scenario('all generations removed, other principal/resource preserved',async f=>{
  const revision=await f.deny();assert.equal((await f.purge(revision)).status,'purged');assert.deepEqual(await f.inventory(),['other-principal','other-resource']);
  await assert.rejects(f.read());await assert.rejects(f.delayedWrite());assert.equal((await f.purge(revision)).status,'purged');
 });
 for(const kind of ['pendingWrites','inFlight','conflicts','holds','unresolvedSources','contentChanged'])scenario(`preserves ${kind} and keeps access denied`,async f=>{
  await f.markDirty(kind);const revision=await f.deny(),before=await f.inventory();assert.equal((await f.purge(revision)).status,'blocked');assert.deepEqual(await f.inventory(),before);await assert.rejects(f.read());await assert.rejects(f.delayedWrite());assert.equal(await f.isDenied(),true);
 });
 scenario('stale purge cannot erase a fresh grant',async f=>{const stale=await f.deny();await f.grant();const before=await f.inventory();await assert.rejects(f.purge(stale));assert.deepEqual(await f.inventory(),before);});
 scenario('deletion failure rolls back all replicas and retry completes',async f=>{
  const revision=await f.deny(),before=await f.inventory();await f.failDeletion(true);await assert.rejects(f.purge(revision));assert.deepEqual(await f.inventory(),before);assert.equal(await f.isDenied(),true);await f.failDeletion(false);assert.equal((await f.purge(revision)).status,'purged');assert.deepEqual(await f.inventory(),['other-principal','other-resource']);
 });
 scenario('restart keeps denial and permits physical purge retry',async f=>{
  const revision=await f.deny();await f.reopen();assert.equal(await f.isDenied(),true);await assert.rejects(f.read());await assert.rejects(f.delayedWrite());assert.equal((await f.purge(revision)).status,'purged');assert.deepEqual(await f.inventory(),['other-principal','other-resource']);
 });
}
