import {createNativeCheckedReader} from '../dist/native-reader.js';
import {registerCheckedReaderContract} from './checked-reader-contract.mjs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const binary=fileURLToPath(new URL('../../../target/debug/authzflow-native-json',import.meta.url));
// Replay each transport transcript in a real native Rust process. No JS decisions.
function nativePort(){const lines=[];return {call(input){lines.push(input);const result=spawnSync(binary,[],{input:lines.join('\n')+'\n',encoding:'utf8'});if(result.status!==0)throw Error('native_fixture_failed');return result.stdout.trim().split('\n').at(-1);}};}
registerCheckedReaderContract('Native Rust',options=>createNativeCheckedReader({...options,native:nativePort(),randomUUID}));

import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRuntime} from '../dist/native-reader.js';
import {readFileSync} from 'node:fs';
test('native Rust operates without browser globals and retains a Rust-produced closed snapshot',async()=>{
 const names=['WebAssembly','structuredClone','TextEncoder','TextDecoder','crypto'],saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
 const cp=JSON.parse(readFileSync(new URL('../../../fixtures/ready.json',import.meta.url)));
 try{
  names.forEach(name=>Object.defineProperty(globalThis,name,{configurable:true,value:undefined}));
  const r=await createNativeRuntime({native:nativePort(),checkpoint:cp,clock:()=>({boot:'boot',now_ms:0}),commit:async plan=>plan.next.revision});
  assert.equal(r.snapshot().phase,'resync_required');await r.applySnapshot(cp);assert.equal(r.snapshot().phase,'ready');r.close();assert.equal(r.snapshot().phase,'closed');assert.deepEqual(r.snapshot().resources,{});await assert.rejects(r.get('article',async()=> 'must not read'),/runtime_unavailable/);
 }finally{names.forEach((name,i)=>saved[i]?Object.defineProperty(globalThis,name,saved[i]):delete globalThis[name]);}
});
test('missing or incompatible native ABI fails closed without a fallback',async()=>{
 let reads=0;const r=await createNativeCheckedReader({binding:'a',resourceId:'r',scopeId:'s',native:{call:()=>JSON.stringify({ok:true,value:99})},randomUUID,session:async()=>({binding:'a',context:'c',expiresAtMs:10000}),clock:()=>({boot:'b',now_ms:0,wall_ms:1}),storage:{load:async()=>null,commit:async()=>{throw Error('must not persist');}},check:async()=>({status:403,json:async()=>null}),read:async()=>{reads++;return '';},contentHash:async()=> '0'.repeat(64)});
 await assert.rejects(r.read(),/abi_mismatch/);assert.equal(reads,0);r.close();
});

import {createNativeResourceAuthority} from '../dist/native-reader.js';
const createResourceAuthority=options=>createNativeResourceAuthority({...options,native:nativePort(),randomUUID});
import {registerResourceAuthorityContract} from '../testing/resource-authority-conformance.mjs';
registerResourceAuthorityContract('Native Rust coordinator',options=>createResourceAuthority({...options,clone:value=>JSON.parse(JSON.stringify(value)),randomUUID,
 runtime:input=>createNativeRuntime({...input,native:nativePort()}),
 reader:input=>createNativeCheckedReader({...input,native:nativePort(),randomUUID}),
}));

test('native coordinator changes and cached grants work without browser globals',async()=>{
 const names=['WebAssembly','structuredClone','TextEncoder','TextDecoder','crypto'],saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
 const rows=new Map();let offline=false;const digest='1'.repeat(64),input={binding:'b',resourceId:'r',scopeId:'s',content:'body'};
 const host=createResourceAuthority({clone:value=>JSON.parse(JSON.stringify(value)),randomUUID,pollIntervalMs:0,onDenied:async()=>{},
 runtime:options=>createNativeRuntime({...options,native:nativePort()}),reader:options=>createNativeCheckedReader({...options,native:nativePort(),randomUUID}),
 clock:()=>({boot:'b',now_ms:1,wall_ms:1}),session:async()=>({binding:'b',context:'c',expiresAtMs:100000}),hash:async()=>digest,
 storage:{load:async(kind,id)=>rows.get(kind+id)??null,commit:async(kind,id,plan)=>{rows.set(kind+id,plan.next);return plan.next.revision;}},
 check:async(_input,requestId)=>{if(offline)throw new TypeError('offline');return {status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'b',resourceId:'r',scopeId:'s',epoch:'e',contentHash:digest,leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000}})};},
 changes:{snapshot:async(_input,requestId)=>({status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'b',resourceId:'r',scopeId:'s',stream:{epoch:'e',sequence:'0',cursor:'c'}})}),fetch:async(_input,{requestId})=>({status:200,json:async()=>({schemaVersion:1,requestId,hasMore:false,batch:{binding:'b',epoch:'e',from_sequence:'0',through_sequence:'0',next_cursor:'c',changes:[]}})})},
 });
 try{names.forEach(name=>Object.defineProperty(globalThis,name,{configurable:true,value:undefined}));assert.equal((await host.readWithPermit(input)).allowed,true);await host.catchUp();offline=true;assert.equal((await host.readCachedWithPermit(input)).allowed,true);}
 finally{host.close();names.forEach((name,i)=>saved[i]?Object.defineProperty(globalThis,name,saved[i]):delete globalThis[name]);}
});

test('native authority entrypoint exports coordination without a Wasm module in its import graph',async()=>{
 const {readFile}=await import('node:fs/promises'),entry=new URL('../dist/native-reader.js',import.meta.url),seen=new Set();
 assert.equal(typeof (await import(entry.href)).createNativeResourceAuthority,'function');
 const walk=async url=>{if(seen.has(url.href))return;seen.add(url.href);const source=await readFile(url,'utf8');assert.doesNotMatch(source,/import\.meta|WebAssembly/);for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+\.js)['"]/g))await walk(new URL(match[1],url));};await walk(entry);
});
