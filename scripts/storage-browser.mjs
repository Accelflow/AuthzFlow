import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
const browser=await chromium.launch({...(process.env.AUTHZFLOW_BUNDLED_BROWSER==='1'?{}:{channel:'chrome'}),headless:true});
try{
 const page=await browser.newPage();
 await page.route('https://authzflow.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>AuthzFlow storage acceptance</title>'});
  const files=['dist/resource-authority-driver.js','dist/resource-change-tracker-driver.js','dist/resource-authority.js','dist/resource-change-tracker.js','dist/runtime-driver.js','dist/index.js','dist/checked-reader-protocol.js','dist/checked-reader.js','dist/change-consumer.js','dist/cache.js','dist/indexeddb.js','wasm/authzflow_wasm.js','wasm/authzflow_wasm_bg.wasm'];
  if(!files.includes(p.slice(1)))return route.fulfill({status:404,body:'missing'});
  return route.fulfill({contentType:p.endsWith('.wasm')?'application/wasm':'text/javascript',body:readFileSync('packages/core'+p)});
 });
 await page.goto('https://authzflow.test/');
 const checkpoint=JSON.parse(readFileSync('fixtures/ready.json','utf8'));
 // IndexedDB browser acceptance anchor.
    const result = await page.evaluate(async cp => {
      const { openIndexedDBStorage } = await import("/dist/indexeddb.js");
      const codec = { seal: v => v, open: v => v };
      const name = "authzflow-" + crypto.randomUUID();
      const a = await openIndexedDBStorage(name, codec), b = await openIndexedDBStorage(name, codec);
      const initial = structuredClone(cp);
      initial.revision = "0";
      await a.commit({ expected_revision: "0", pending: initial, next: initial });
      await a.put(cp.binding, "article", new Uint8Array([1, 2]), "0");
      const bytes = await b.read(cp.binding, "article");
      if (bytes[0] !== 1 || bytes[1] !== 2) throw Error("idb_body_mismatch");
      const deny = structuredClone(initial);
      deny.revision = "1";
      deny.scopes.scope.access = "deny";
      await a.commit({ expected_revision: "0", pending: deny, next: deny });
      let stale = false;
      try {
        await b.put(cp.binding, "article", new Uint8Array([3]), "0");
      } catch (e) {
        stale = String(e).includes("cache_revision_conflict");
      }
      if (!stale) throw Error("idb_stale_put_allowed");
      await b.purge(cp.binding, ["article"], "1");
      a.close();
      b.close();
      const c = await openIndexedDBStorage(name, codec);
      const state = await c.load(cp.binding), body = await c.read(cp.binding, "article");
      c.close();
      indexedDB.deleteDatabase(name);
      const {createCachedRuntime}=await import('/dist/cache.js');
      const runtimeName='authzflow-runtime-'+crypto.randomUUID();
      let store=await openIndexedDBStorage(runtimeName,codec);
      let cache=await createCachedRuntime({checkpoint:initial,storage:store,clock:()=>({boot:'boot',now_ms:50})});
      await cache.applySnapshot(initial);const allowed=cache.snapshot().revision;
      await cache.put('article',new Uint8Array([7,8]),allowed);
      const shown=await cache.get('article',true);if(shown[0]!==7)throw Error('idb_runtime_body_invalid');
      await cache.applyChanges({binding:cp.binding,epoch:cp.epoch,from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]});
      let denied=false;try{await cache.get('article');}catch{denied=true;}if(!denied)throw Error('idb_runtime_revoke_allowed');
      const revokedRevision=cache.snapshot().revision;cache.close();store.close();
      store=await openIndexedDBStorage(runtimeName,codec);
      cache=await createCachedRuntime({checkpoint:initial,storage:store,clock:()=>({boot:'restart',now_ms:50})});
      let cold=false;try{await cache.get('article');}catch{cold=true;}if(!cold)throw Error('idb_runtime_cold_grant');
      await cache.purge(['article'],revokedRevision);
      const fresh={...structuredClone(cp),revision:revokedRevision,sequence:'3',cursor:'cursor-3'};
      for(const e of [...Object.values(fresh.resources),...Object.values(fresh.scopes)]){e.version='3';e.boot='restart';}
      await cache.applySnapshot(fresh);if(await cache.get('article')!==null)throw Error('idb_old_body_resurrected');
      await cache.put('article',new Uint8Array([9]),cache.snapshot().revision);
      let late=false;try{await cache.purge(['article'],revokedRevision);}catch{late=true;}if(!late)throw Error('idb_late_purge_removed_new_grant');
      if((await cache.get('article'))[0]!==9)throw Error('idb_new_grant_body_missing');
      cache.close();store.close();indexedDB.deleteDatabase(runtimeName);
      return { revision: state.revision, body, wasm:true };
    }, checkpoint);
    assert.deepEqual(result, { revision: "1", body: null, wasm:true });
    console.log("PASS: IndexedDB CAS, actual Wasm get/put, scope denial, purge, reopen and fresh regrant");
}finally{await browser.close();}
