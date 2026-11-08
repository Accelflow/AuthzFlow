import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createResourceAuthority} from '../dist/resource-authority.js';
const wasmBytes=new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
function setup(){
 const rows=new Map();let now=1,calls=0,context='c',hashHold;
 const authority=createResourceAuthority({wasmBytes,pollIntervalMs:0,session:async()=>({binding:'b',context,expiresAtMs:100000}),clock:()=>({boot:'b',now_ms:now,wall_ms:now}),
  hash:async()=>{if(hashHold)await hashHold;return 'a'.repeat(64);},storage:{load:async(kind,id)=>rows.get(kind+id)??null,commit:async(kind,id,plan)=>{rows.set(kind+id,plan.next);return plan.next.revision;}},
  check:async(i,requestId)=>{calls++;return {status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'b',resourceId:i.resourceId,scopeId:'s',epoch:'e',contentHash:'a'.repeat(64),leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000}})};},
 });
 return {authority,input:resourceId=>({binding:'b',scopeId:'s',resourceId,content:'body'}),get calls(){return calls;},set now(v){now=v;},set context(v){context=v;},set hold(v){hashHold=v;}};
}
test('batch uses existing Rust permits without HTTP or deadline renewal and preserves duplicates/order',async()=>{
 const h=setup();try{await h.authority.readWithPermit(h.input('a'));const calls=h.calls;h.now=100;const r=await h.authority.readCachedManyWithPermit([h.input('a'),h.input('missing'),h.input('a')]);assert.deepEqual(r.map(x=>x.status),['allowed','unavailable','allowed']);assert.equal(r[1].reason,'permit_missing');assert.equal(h.calls,calls);assert.ok(r[0].lease.validForMs<=901);h.now=1001;assert.equal((await h.authority.readCachedManyWithPermit([h.input('a')]))[0].status,'unavailable');}finally{h.authority.close();}
});
test('batch validates all input before work, snapshots caller values, and drops allow on session change',async()=>{
 const h=setup();try{await h.authority.readWithPermit(h.input('a'));await assert.rejects(h.authority.readCachedManyWithPermit(Array.from({length:65},()=>h.input('a'))),/batch_invalid/);await assert.rejects(h.authority.readCachedManyWithPermit(Array.from({length:5},(_,i)=>({...h.input(String(i)),content:'x'.repeat(1048576)}))),/batch_invalid/);
  let release;h.hold=new Promise(r=>release=r);const inputs=[h.input('a')],pending=h.authority.readCachedManyWithPermit(inputs);inputs[0].resourceId='changed';await new Promise(r=>setImmediate(r));h.context='other';release();assert.equal((await pending)[0].status,'unavailable');assert.equal(h.calls,1);
 }finally{h.authority.close();}
});
