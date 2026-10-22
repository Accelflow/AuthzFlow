import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createSQLiteStorage} from '../dist/sqlite.js';
import {createCachedRuntime} from '../dist/cache.js';
const cp=JSON.parse(readFileSync(new URL('../../../fixtures/ready.json',import.meta.url),'utf8'));
const wasmBytes=new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
const codec={seal:v=>v,open:v=>v};
test('real Wasm and SQLite retain durable denial through failed purge and owner restart',async()=>{
 const db=new DatabaseSync(':memory:');let storage=createSQLiteStorage(db,codec),cache;
 const initial={...structuredClone(cp),revision:'0'};
 try{
  cache=await createCachedRuntime({checkpoint:initial,storage,wasmBytes,clock:()=>({boot:'boot',now_ms:50})});
  await cache.applySnapshot(initial);const grantedRevision=cache.snapshot().revision;
  await cache.put('article',new Uint8Array([7,8]),grantedRevision);
  assert.deepEqual(await cache.get('article',true),new Uint8Array([7,8]));
  await cache.applyChanges({binding:cp.binding,epoch:cp.epoch,from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]});
  await assert.rejects(cache.get('article'));await assert.rejects(cache.put('article',new Uint8Array([9]),grantedRevision));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authz_bodies').get().n,1);
  db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON authz_bodies BEGIN SELECT RAISE(ABORT,'purge_disk_full'); END");
  const denied=cache.snapshot();await assert.rejects(cache.purge(['article'],denied.revision),/purge_disk_full/);
  assert.equal((await storage.load(cp.binding)).scopes.scope.access,'deny');
  cache.close();storage.close();storage=createSQLiteStorage(db,codec);
  cache=await createCachedRuntime({checkpoint:initial,storage,wasmBytes,clock:()=>({boot:'restart',now_ms:50})});
  await assert.rejects(cache.get('article'));
  db.exec('DROP TRIGGER fail_purge');await cache.purge(['article'],denied.revision);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authz_bodies').get().n,0);
  const fresh={...structuredClone(cp),revision:denied.revision,sequence:'3',cursor:'cursor-3'};
  for(const e of [...Object.values(fresh.resources),...Object.values(fresh.scopes)]){e.version='3';e.boot='restart';e.expires_at_ms=100;}
  await cache.applySnapshot(fresh);assert.equal(await cache.get('article'),null);
  await cache.put('article',new Uint8Array([9]),cache.snapshot().revision);
  await assert.rejects(cache.purge(['article'],denied.revision),/cache_revision_conflict/);
  assert.deepEqual(await cache.get('article'),new Uint8Array([9]));
 }finally{cache?.close();storage.close();db.close();}
});
