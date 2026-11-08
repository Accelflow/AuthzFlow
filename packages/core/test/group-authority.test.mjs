import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createResourceAuthority} from '../dist/resource-authority.js';import {createResourceGroupCoordinator} from '../dist/resource-group.js';
import {groupHost} from './resource-group-contract.mjs';
const wasmBytes=new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
test('real Rust Resource authority uses Group watermarks, cached batch fences, offline deadline and fresh regrant',async()=>{
 const h=groupHost(o=>createResourceGroupCoordinator({...o,wasmBytes})),groups=await h.create(),rows=new Map();let offline=false,calls=0,now=1;
 const options={groups,wasmBytes,pollIntervalMs:0,session:async()=>({binding:h.group.binding,context:'context-a',expiresAtMs:100000}),clock:()=>({boot:'boot',now_ms:now,wall_ms:now}),hash:async()=> 'a'.repeat(64),
 storage:{load:async(kind,id)=>rows.get(kind+id)??null,commit:async(kind,id,plan)=>{rows.set(kind+id,plan.next);return plan.next.revision;}},
 check:async(i,requestId)=>{calls++;if(offline)throw new TypeError('offline');return {status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:i.binding,resourceId:i.resourceId,scopeId:i.scopeId,epoch:'resource-epoch',contentHash:'a'.repeat(64),leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000},resourceGroup:h.anchor()})};}};
 const a=createResourceAuthority(options),input=id=>({...h.group,resourceId:id,scopeId:'scope',content:'body'});
 try{
  await a.readWithPermit(input('a'));await a.readWithPermit(input('b'));const before=calls;
  assert.deepEqual((await a.readCachedManyWithPermit([input('a'),input('b')])).map(r=>r.status),['allowed','allowed']);assert.equal(calls,before);
  offline=true;now=400;assert.equal((await a.readWithPermit(input('a'))).allowed,true);now=1001;await assert.rejects(a.readCachedWithPermit(input('a')));
  offline=false;await a.revalidate(input('a'));h.event();await a.catchUp();assert.notEqual((await a.readCachedManyWithPermit([input('a')]))[0].status,'allowed');
  await a.revalidate(input('a'));assert.equal((await a.readCachedWithPermit(input('a'))).allowed,true);
 }finally{a.close();await groups.close();}
});
