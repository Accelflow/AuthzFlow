// SDK runtime regression anchor.
test('owned Wasm state requires a runtime-bound one-use durable commit acknowledgement',async()=>{
 const wasm=await import('../wasm/authzflow_wasm.js');
 assert.equal(typeof wasm.WasmRuntime,'function','STATEFUL_RUNTIME_MISSING');await wasm.default({module_or_path:wasmBytes});assert.equal(wasm.runtime_abi_version(),2);
 const a=new wasm.WasmRuntime(JSON.stringify(checkpoint)),b=new wasm.WasmRuntime(JSON.stringify(checkpoint));
 const clock=JSON.stringify({boot:'boot',now_ms:50});
 try{
  assert.equal(JSON.parse(a.evaluate('article',clock,false)).allowed,false);
  const pa=JSON.parse(a.prepare_snapshot(JSON.stringify(checkpoint))),pb=JSON.parse(b.prepare_snapshot(JSON.stringify(checkpoint)));
  assert.notEqual(pa.transition_id,pb.transition_id);assert.equal(JSON.parse(a.evaluate('article',clock,false)).allowed,false);
  a.acknowledge(pa.transition_id,pa.plan.next.revision);assert.equal(JSON.parse(a.evaluate('article',clock,false)).allowed,true);
  assert.deepEqual(JSON.parse(a.evaluate_many(JSON.stringify(['article','missing','article']),clock,false)).map(d=>d.allowed),[true,false,true]);
  assert.throws(()=>b.acknowledge(pa.transition_id,pb.plan.next.revision),/commit_mismatch/);assert.equal(JSON.parse(b.snapshot()).phase,'resync_required');
  assert.throws(()=>a.evaluate_many(JSON.stringify(Array(1025).fill('article')),clock,false),/invalid_request/);
  const pending=JSON.parse(a.prepare_snapshot(JSON.stringify(revoke())));a.close();assert.throws(()=>a.acknowledge(pending.transition_id,pending.plan.next.revision),/runtime_unavailable|commit_mismatch/);assert.equal(JSON.parse(a.snapshot()).phase,'closed');assert.deepEqual(JSON.parse(a.snapshot()).resources,{});
 }finally{a.free();b.free();}
 const c=new wasm.WasmRuntime(JSON.stringify(checkpoint));try{const p=JSON.parse(c.prepare_snapshot(JSON.stringify(checkpoint)));c.acknowledge(p.transition_id,p.plan.next.revision);assert.throws(()=>c.acknowledge(p.transition_id,p.plan.next.revision),/commit_mismatch/);assert.equal(JSON.parse(c.evaluate('article',clock,false)).allowed,false);}finally{c.free();}
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRuntime } from '../dist/index.js';
const checkpoint = JSON.parse(readFileSync(new URL('../../../fixtures/ready.json', import.meta.url), 'utf8'));
const wasmBytes = new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm', import.meta.url)));
const options = (extra = {}) => ({ checkpoint, wasmBytes, clock: () => ({boot:'boot',now_ms:50}),
  commit: async plan => plan.next.revision, ...extra });
const revoke = () => {
  const next=structuredClone(checkpoint); next.sequence='2'; next.cursor='cursor-2';
  next.scopes.scope.access='deny'; next.scopes.scope.version='2'; return next;
};

test('SDK hot reads and batched expiry checks do not serialize the whole checkpoint',async()=>{
 let clockCalls=0;const state=structuredClone(checkpoint);for(let i=0;i<20;i++)state.resources['a'+i]=structuredClone(state.resources.article);
 const rt=await createRuntime(options({checkpoint:state,clock:()=>{clockCalls++;return {boot:'boot',now_ms:50};}}));
 await rt.applySnapshot(state);for(let i=0;i<20;i++)await rt.get('a'+i,async()=>i);
 const original=JSON.stringify;let fullStates=0;
 JSON.stringify=(value,...args)=>{if(value&&typeof value==='object'&&value.state?.resources)fullStates++;return original(value,...args);};
 try{await rt.get('article',async()=>'body');const before=clockCalls;rt.tick();assert.equal(fullStates,0,'CHECKPOINT_CROSSED_HOT_BOUNDARY');assert.equal(clockCalls-before,1,'batch_tick_sampled_clock_per_resource');}finally{JSON.stringify=original;rt.close();}
});
test('structured events are optional bounded and never change authorization on observer failure',async()=>{
 const events=[];const rt=await createRuntime(options({onEvent:e=>{events.push(e);throw Error('observer-private-secret');}}));
 assert.ok(events.some(e=>e.code==='runtime_initialized'),'STRUCTURED_EVENTS_MISSING');
 await rt.applySnapshot(checkpoint);assert.equal(await rt.get('article',async()=>'private-body',true),'private-body');await rt.applySnapshot(revoke());await assert.rejects(rt.get('article',async()=>'secret'));rt.close();
 for(const code of ['snapshot_applied','offline_read','resources_invalidated','read_denied','runtime_closed'])assert.ok(events.some(e=>e.code===code),code);
 const serialized=JSON.stringify(events);for(const secret of ['observer-private-secret','private-body','actor','cursor-1','article'])assert.equal(serialized.includes(secret),false,secret);
 assert.ok(events.every(e=>e.schemaVersion===1&&Object.isFrozen(e)));
 let release;const slowEvents=[];const pending=new Promise(r=>release=r);
 const slow=await createRuntime(options({onEvent:e=>{slowEvents.push(e);return slowEvents.length===1?pending:undefined;}}));
 await slow.applySnapshot(checkpoint);await slow.get('article',async()=>'ok');await slow.applySnapshot(revoke());assert.equal(slowEvents.length,1,'observer_queue_not_bounded');release();await new Promise(r=>setImmediate(r));slow.close();assert.equal(slowEvents.length,2);assert.ok(slowEvents[1].droppedEvents>0);
 const rejected=await createRuntime(options({onEvent:()=>Promise.reject(Error('never-log-this'))}));await rejected.applySnapshot(checkpoint);assert.equal(await rejected.get('article',async()=>'ok'),'ok');rejected.close();await new Promise(r=>setImmediate(r));
 let output=0;const info=console.info,warn=console.warn,error=console.error;console.info=console.warn=console.error=()=>output++;
 try{const quiet=await createRuntime(options());await quiet.applySnapshot(checkpoint);await quiet.get('article',async()=>'ok');quiet.close();assert.equal(output,0,'logging_not_disabled_by_default');}finally{console.info=info;console.warn=warn;console.error=error;}
});
test('runtime_commit_and_read_fence', async () => {
  const invalidated=[];
  const rt=await createRuntime(options({onInvalidate: ids=>invalidated.push(...ids)}));
  let reads=0;
  await assert.rejects(rt.get('article',async()=>{reads++;return 'content';}));
  assert.equal(reads,0);
  await rt.applySnapshot(checkpoint);
  assert.equal(await rt.get('article',async()=>'content'),'content');
  let release;
  const pending=rt.get('article',()=>new Promise(resolve=>{release=resolve;}));
  const rejected=assert.rejects(pending);
  await rt.applySnapshot(revoke());
  release('secret'); await rejected;
  assert.ok(invalidated.includes('article'));
  await assert.rejects(rt.get('article',async()=>'secret'));
  rt.close(); await assert.rejects(rt.get('article',async()=>'secret'));
});

test('failed commit and concurrent commit stay fenced', async () => {
  let finish;
  const rt=await createRuntime(options({commit:()=>new Promise(resolve=>{finish=resolve;})}));
  const applying=rt.applySnapshot(checkpoint);
  await assert.rejects(rt.get('article',async()=>'secret'));
  await assert.rejects(rt.applySnapshot(checkpoint));
  finish('wrong'); await assert.rejects(applying);
  assert.equal(rt.snapshot().phase,'resync_required');
  await assert.rejects(rt.get('article',async()=>'secret'));
});

test('expiry, rollback and close during commit never expose data', async () => {
  let now=50;
  const notices=[];
  const rt=await createRuntime(options({clock:()=>({boot:'boot',now_ms:now}),onInvalidate:ids=>notices.push(...ids)}));
  await rt.applySnapshot(checkpoint); await rt.get('article',async()=>'content');
  now=100; rt.tick(); assert.ok(notices.includes('article'));
  await assert.rejects(rt.get('article',async()=>'secret'));
  now=10; await assert.rejects(rt.get('article',async()=>'secret'));
  let finish;
  const other=await createRuntime(options({commit:()=>new Promise(resolve=>{finish=resolve;})}));
  const applying=other.applySnapshot(checkpoint); other.close(); finish('2');
  await assert.rejects(applying); assert.equal(other.snapshot().phase,'closed');
});

test('malformed checkpoint fails initialization without exposing runtime', async () => {
  // Separate module instance initialization is covered by browser test; reject a malformed checkpoint here.
  await assert.rejects(createRuntime(options({checkpoint:{}})));
});

test('cursor batch denies the viewer through the same commit gate', async () => {
  const rt=await createRuntime(options()); await rt.applySnapshot(checkpoint);
  await rt.applyChanges({binding:'actor',epoch:'epoch',from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',
    changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]});
  assert.equal(rt.snapshot().cursor,'cursor-2');
  await assert.rejects(rt.get('article',async()=>'secret'));
});

test('SDK expiry pruning crosses the 1024-ID boundary with one clock sample',async()=>{
 const state=structuredClone(checkpoint);state.resources={};for(let i=0;i<1030;i++)state.resources['article-'+i]=structuredClone(checkpoint.resources.article);
 let now=50,samples=0;const invalidated=[];
 const rt=await createRuntime(options({checkpoint:state,clock:()=>{samples++;return {boot:'boot',now_ms:now};},onInvalidate:ids=>invalidated.push(...ids)}));
 try{await rt.applySnapshot(state);for(let i=0;i<1030;i++)await rt.get('article-'+i,async()=>i);now=100;const before=samples;rt.tick();assert.equal(samples-before,1);assert.equal(new Set(invalidated).size,1030);await assert.rejects(rt.get('article-1029',async()=>'expired'));}finally{rt.close();}
});
