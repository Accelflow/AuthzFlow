import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCachedRuntime} from '../dist/cache.js';
const cp=JSON.parse(readFileSync(new URL('../../../fixtures/ready.json',import.meta.url),'utf8'));
const wasmBytes=new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
// Cache regression insertion anchor.
test('cache_reads_compare_durable_revision', async () => {
  let saved = null;
  const storage = {
    async load() { return structuredClone(saved); },
    async commit(plan) { saved = structuredClone(plan.next); return saved.revision; },
    async read() { return new Uint8Array([1]); },
    async put() { },
    async purge() { },
    close() { }
  };
  const cache = await createCachedRuntime({ checkpoint: cp, storage, clock: () => ({ boot: "boot", now_ms: 50 }), wasmBytes });
  await cache.applySnapshot(cp);
  saved.revision = String(BigInt(saved.revision) + 1n);
  saved.scopes.scope.access = "deny";
  await assert.rejects(cache.get("article"), /cache_revision_conflict/);
  cache.close();
});
test('cache_put_requires_durable_grant',async()=>{
 let saved=null;const bodies=new Map();
 const storage={
  async load(){return structuredClone(saved);},
  async commit(plan){assert.equal(saved?.revision??cp.revision,plan.expected_revision);saved=structuredClone(plan.next);return saved.revision;},
  async read(binding,resource){return bodies.get(resource)??null;},
  async put(binding,resource,value,revision){assert.equal(saved.revision,revision);bodies.set(resource,new Uint8Array(value));},
  async purge(binding,resources,revision){assert.equal(saved.revision,revision);for(const resource of resources)bodies.delete(resource);},close(){},
 };
 const cache=await createCachedRuntime({checkpoint:cp,storage,clock:()=>({boot:'boot',now_ms:50}),wasmBytes});
 await assert.rejects(cache.put('article',new Uint8Array([1]),cp.revision));
 await cache.applySnapshot(cp);const revision=cache.snapshot().revision;
 await cache.put('article',new Uint8Array([1,2]),revision);
 const value=await cache.get('article');assert.deepEqual(value,new Uint8Array([1,2]));value[0]=99;
 assert.deepEqual(await cache.get('article'),new Uint8Array([1,2]));
 const deny=cache.snapshot();deny.scopes.scope.access='deny';await cache.applySnapshot(deny);
 await assert.rejects(cache.get('article'));await assert.rejects(cache.put('article',new Uint8Array([3]),revision));
 await cache.purge(['article'],cache.snapshot().revision);assert.equal(bodies.size,0);cache.close();
});
