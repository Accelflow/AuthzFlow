import {createHash} from 'node:crypto';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
export function registerResourceAuthorityContract(name,createResourceAuthority,wasmBytes){
const test=(label,fn)=>nodeTest(name+': '+label,fn);

const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(maxOfflineMs=1000,ownsContent,overrides={}){
 let now=100,wall=10000,status=200,offline=false,context='session-a';const rows=new Map(),binding='["account","actor"]';
 const reply=(input,requestId)=>({status,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding,resourceId:input.resourceId,scopeId:input.scopeId,epoch:'epoch',contentHash:hash(input.content),leaseMs:5000,readPolicy:{mode:maxOfflineMs?'offline_ttl':'online_only',maxOfflineMs}})});
 const host=createResourceAuthority({ownsContent,wasmBytes,hash:async value=>hash(value),clock:()=>({boot:'boot',now_ms:now,wall_ms:wall}),session:async()=>({binding,context,expiresAtMs:100000}),storage:{load:async (kind,resource)=>rows.get(kind+resource)??null,commit:async(kind,resource,plan)=>{assert.equal(rows.get(kind+resource)?.revision??'0',plan.expected_revision);rows.set(kind+resource,structuredClone(plan.next));return plan.next.revision;}},check:async(input,requestId)=>{if(offline)throw new TypeError('offline');return reply(input,requestId);},...overrides});
 const input={binding,scopeId:'ws',resourceId:'resource-a',target:{product:'example'},content:'body'};
 return {host,input,rows,reply,setStatus:value=>status=value,offline:()=>offline=true,online:()=>offline=false,switch:()=>context='session-b',tick:ms=>{now+=ms;wall+=ms;}};

}
test('real Rust authority handles multiple resources independently and preserves original offline expiry',async()=>{
 const f=fixture();const first=await f.host.readWithPermit(f.input);assert.equal(first.allowed,true);await f.host.readWithPermit({...f.input,resourceId:'resource-b'});assert.equal(f.rows.size,2);f.offline();f.tick(400);const next=await f.host.readWithPermit(f.input);assert.equal(next.expiresAt,first.expiresAt);assert.equal(next.validForMs,600);f.tick(601);await assert.rejects(f.host.readWithPermit(f.input),/authz_offline_expired/);f.host.close();
});
test('online-only has no offline grant',async()=>{const f=fixture(0);await f.host.readWithPermit(f.input);f.offline();await assert.rejects(f.host.readWithPermit(f.input),/authz_offline_expired/);f.host.close();});
test('server denial is durable and never becomes an offline permit',async()=>{const f=fixture();await f.host.readWithPermit(f.input);f.setStatus(403);await assert.rejects(f.host.readWithPermit(f.input),/authz_check_denied/);assert.equal([...f.rows.values()][0].resources['resource-a'].access,'deny');f.offline();await assert.rejects(f.host.readWithPermit(f.input));f.host.close();});
test('server failures and content changes fail closed',async()=>{const f=fixture();await f.host.readWithPermit(f.input);f.offline();await assert.rejects(f.host.readWithPermit({...f.input,content:'changed'}),/authz_content_changed/);f.host.close();const g=fixture();await g.host.readWithPermit(g.input);g.setStatus(503);await assert.rejects(g.host.readWithPermit(g.input),/authz_check_unavailable/);g.host.close();});
test('session change and cold restart do not reuse an offline grant',async()=>{const f=fixture();await f.host.readWithPermit(f.input);f.switch();f.offline();await assert.rejects(f.host.readWithPermit(f.input),/authz_offline_expired|context_changed/);f.host.close();});
test('malformed target and closed host fail before reading',async()=>{const f=fixture();await assert.rejects(f.host.readWithPermit({...f.input,resourceId:''}));f.host.close();await assert.rejects(f.host.readWithPermit(f.input),/context_changed/);});

test('duplicate in-flight UI checks share the exact check without a settled grant cache',async()=>{const f=fixture();const [a,b]=await Promise.all([f.host.readWithPermit(f.input),f.host.readWithPermit({...f.input})]);assert.deepEqual(a,b);assert.equal(f.rows.size,1);f.host.close();});

test('secondary cache checks never renew, create or destroy a live read grant',async()=>{
 const f=fixture();await assert.rejects(f.host.readCachedWithPermit(f.input),/authz_cached_permit_missing/);const first=await f.host.readWithPermit(f.input);f.tick(200);const cached=await f.host.readCachedWithPermit(f.input);assert.equal(cached.expiresAt,first.expiresAt);await assert.rejects(f.host.readCachedWithPermit({...f.input,content:'poisoned'}),/authz_content_changed/);assert.equal((await f.host.readCachedWithPermit(f.input)).allowed,true);f.offline();assert.equal((await f.host.readWithPermit(f.input)).allowed,true);f.host.close();
});
test('only an explicit owned-replica port may project edits from the original checked baseline',async()=>{
 const f=fixture(1000,async input=>input.content==='owned edit');await f.host.readWithPermit(f.input);assert.equal((await f.host.readCachedWithPermit({...f.input,content:'owned edit'})).allowed,true);await assert.rejects(f.host.readCachedWithPermit({...f.input,resourceId:'different'}),/authz_cached_permit_missing/);f.host.close();
});

test('trusted host projection can keep the original grant through an ACK/disconnect race without renewing it',async()=>{
 const f=fixture(1000,async input=>input.content==='confirmed own edit');const original=await f.host.readWithPermit(f.input);f.tick(300);f.offline();const result=await f.host.readWithPermit({...f.input,content:'confirmed own edit'});assert.equal(result.expiresAt,original.expiresAt);assert.equal(result.validForMs,700);await assert.rejects(f.host.readCachedWithPermit({...f.input,content:'untrusted cached edit'}),/authz_content_changed/);assert.equal((await f.host.readCachedWithPermit(f.input)).allowed,true);await assert.rejects(f.host.readWithPermit({...f.input,content:'untrusted edit'}),/authz_content_changed/);f.host.close();
});
test('the exact original checked bytes need no proof from a newer local projection',async()=>{const f=fixture(1000,async()=>{throw Error('authz_content_changed');});const first=await f.host.readWithPermit(f.input);f.offline();f.tick(200);assert.equal((await f.host.readWithPermit(f.input)).expiresAt,first.expiresAt);f.host.close();});

test('one dirty revoked resource cannot block invalidation of another registered resource',async()=>{let denied=false;const binding='["account","actor"]',scopeId='ws',epoch='epoch',changes={snapshot:async(input,requestId)=>({status:denied?403:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding,resourceId:input.resourceId,scopeId,stream:{epoch,sequence:'0',cursor:'c0'}})}),fetch:async(input,{requestId})=>({status:200,json:async()=>({schemaVersion:1,requestId,hasMore:false,batch:{binding,epoch,from_sequence:'0',through_sequence:denied?'1':'0',next_cursor:denied?'c1':'c0',changes:denied?[{sequence:'1',action:'revoke',target:{kind:'scope',id:scopeId}}]:[]}})})};const f=fixture(1000,undefined,{changes,pollIntervalMs:0,onDenied:async input=>{if(input.resourceId==='resource-a')throw Error('authz_purge_blocked');}});await f.host.readWithPermit(f.input);await f.host.readWithPermit({...f.input,resourceId:'resource-b'});denied=true;await assert.rejects(f.host.catchUp(),/authz_purge_blocked/);assert.equal(f.rows.get('readerresource-b').resources['resource-b'].access,'deny');await assert.rejects(f.host.readCachedWithPermit({...f.input,resourceId:'resource-b'}));f.host.close();});

test('a cached read cannot join an unfinished full check or acquire its new lease',async()=>{
 let release,entered;const hold=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),rows=new Map();const input={binding:'b',resourceId:'r',scopeId:'s',content:'body'};
 const host=createResourceAuthority({wasmBytes,pollIntervalMs:0,hash:async value=>hash(value),clock:()=>({boot:'b',now_ms:1,wall_ms:1}),session:async()=>({binding:'b',context:'c',expiresAtMs:10000}),storage:{load:async(kind,id)=>rows.get(kind+id)??null,commit:async(kind,id,plan)=>{rows.set(kind+id,plan.next);return plan.next.revision;}},check:async(_input,requestId)=>{entered();await hold;return {status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'b',resourceId:'r',scopeId:'s',epoch:'e',contentHash:hash('body'),leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000}})};}});
 const pending=host.readWithPermit(input);await started;
 try{const outcome=await Promise.race([host.readCachedWithPermit(input).then(()=> 'granted',error=>error.message),new Promise(resolve=>setTimeout(()=>resolve('waited_for_network'),20))]);assert.equal(outcome,'check_in_progress');}
 finally{release();await pending;host.close();}
});

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function journal(){
 const binding='["account","actor"]',events=[];
 return {append:action=>events.push({sequence:String(events.length+1),action,target:{kind:'scope',id:'ws'}}),changes:{
  snapshot:async(input,requestId)=>({status:200,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding,resourceId:input.resourceId,scopeId:input.scopeId,stream:{epoch:'feed',sequence:String(events.length),cursor:String(events.length)}})}),
  fetch:async(_input,{requestId,cursor})=>({status:200,json:async()=>({schemaVersion:1,requestId,hasMore:false,batch:{binding,epoch:'feed',from_sequence:cursor,through_sequence:String(events.length),next_cursor:String(events.length),changes:events.slice(Number(cursor))}})}),
 }};
}
test('observable states are immutable, revisioned, isolated per resource, and expire without renewal',async()=>{
 const f=fixture(),seen=[];const unsubscribe=f.host.subscribe(f.input,state=>seen.push(state));
 try{
  assert.equal(f.host.getState(f.input).phase,'idle');const grant=await f.host.readWithPermit(f.input);
  const state=f.host.getState(f.input);assert.equal(state.phase,'allowed');assert.equal(state.mode,'online');assert.equal(state.expiresAt,grant.expiresAt);assert.ok(Object.isFrozen(state));assert.throws(()=>{state.phase='allowed';},TypeError);
  assert.equal(f.host.getState({...f.input,resourceId:'unopened'}).phase,'idle');f.offline();f.tick(400);await f.host.readWithPermit(f.input);assert.equal(f.host.getState(f.input).mode,'offline');assert.equal(f.host.getState(f.input).expiresAt,grant.expiresAt);
  f.tick(601);assert.equal(f.host.getState(f.input).phase,'expired');assert.equal(f.host.getState(f.input).validForMs,0);assert.ok(seen.every((state,index)=>!index||state.revision>seen[index-1].revision));
  const count=seen.length;unsubscribe();f.host.close();assert.equal(seen.length,count);assert.equal(f.host.getState(f.input).phase,'closed');
 }finally{unsubscribe();f.host.close();}
});
test('subscriber failure cannot change authorization or leak a rejected async callback',async()=>{
 const f=fixture();const off=f.host.subscribe(f.input,()=>{throw Error('private subscriber error');});const offAsync=f.host.subscribe(f.input,async()=>{throw Error('private async subscriber error');});
 try{assert.equal((await f.host.readWithPermit(f.input)).allowed,true);}finally{off();offAsync();f.host.close();}
});
test('explicit revalidation requires a fresh online grant and never falls back to an earlier lease',async()=>{
 const f=fixture();try{await f.host.revalidate(f.input);f.offline();await assert.rejects(f.host.revalidate(f.input));await assert.rejects(f.host.readCachedWithPermit(f.input));f.online();assert.equal((await f.host.revalidate(f.input)).allowed,true);assert.equal(f.host.getState(f.input).mode,'online');}finally{f.host.close();}
});
test('duplicate strict checks coalesce while a weaker pending read cannot satisfy revalidation',async()=>{
 const started=deferred(),release=deferred();let calls=0;const f=fixture(1000,undefined,{check:async(input,id)=>{calls++;if(calls===1){started.resolve();await release.promise;}return f.reply(input,id);}});
 const first=f.host.readWithPermit(f.input);await started.promise;
 try{const a=f.host.revalidate(f.input),b=f.host.revalidate(f.input);release.resolve();await Promise.all([first,a,b]);assert.equal(calls,2);}finally{release.resolve();await first.catch(()=>{});f.host.close();}
});
test('known ACK revalidation followed by disconnect cannot revive the old permit',async()=>{
 const feed=journal(),f=fixture(1000,undefined,{changes:feed.changes,pollIntervalMs:0,onDenied:async()=>{}});
 try{await f.host.readWithPermit(f.input);feed.append('revalidate');await f.host.catchUp();assert.equal(f.host.getState(f.input).phase,'revalidate');f.offline();await assert.rejects(f.host.readWithPermit(f.input));assert.notEqual(f.host.getState(f.input).phase,'allowed');f.online();await f.host.revalidate(f.input);assert.equal(f.host.getState(f.input).phase,'allowed');}finally{f.host.close();}
});
test('a late granted host effect is fenced and finishes before a concurrent durable revoke purge',async()=>{
 const feed=journal(),entered=deferred(),release=deferred(),invalidated=deferred(),order=[];let hold=false;
 const f=fixture(1000,undefined,{changes:feed.changes,pollIntervalMs:0,onGranted:async()=>{if(hold){order.push('grant-start');entered.resolve();await release.promise;order.push('grant-end');}},onInvalidated:async()=>invalidated.resolve(),onDenied:async()=>order.push('deny')});
 await f.host.readWithPermit(f.input);hold=true;const pending=f.host.readWithPermit(f.input);void pending.catch(()=>{});await entered.promise;feed.append('revoke');const catchup=f.host.catchUp();void catchup.catch(()=>{});await invalidated.promise;
 try{release.resolve();await assert.rejects(pending,/context_changed/);await catchup;assert.deepEqual(order,['grant-start','grant-end','deny']);assert.equal(f.rows.get('readerresource-a').resources['resource-a'].access,'deny');assert.equal(f.host.getState(f.input).phase,'denied');}finally{release.resolve();await Promise.allSettled([pending,catchup]);f.host.close();}
});
test('expiry or session switch during a held response cannot publish a grant',async()=>{
 for(const change of [f=>f.tick(6000),f=>f.switch()]){
  const entered=deferred(),release=deferred();const f=fixture(1000,undefined,{check:async(input,id)=>{entered.resolve();await release.promise;return f.reply(input,id);}});const pending=f.host.revalidate(f.input);void pending.catch(()=>{});await entered.promise;
  try{change(f);release.resolve();await assert.rejects(pending);assert.notEqual(f.host.getState(f.input).phase,'allowed');}finally{release.resolve();await pending.catch(()=>{});f.host.close();}
 }
});
test('diagnostics connect runtime and coordinator events without content, identifiers or raw errors',async()=>{
 const events=[],feed=journal(),f=fixture(1000,undefined,{onEvent:event=>events.push(event),changes:feed.changes,pollIntervalMs:0,onDenied:async()=>{throw Error('authz_purge_blocked');}});
 try{await f.host.revalidate(f.input);feed.append('revoke');await assert.rejects(f.host.catchUp());assert.ok(events.some(event=>event.code==='runtime_initialized'));assert.ok(events.some(event=>event.code==='authority_revalidation_started'));assert.ok(events.some(event=>event.code==='authority_purge_blocked'));assert.ok(events.some(event=>event.code==='authority_catch_up_failed'));const text=JSON.stringify(events);for(const secret of ['account','actor','resource-a','private','product','body','token'])assert.equal(text.includes(secret),false);}finally{f.host.close();}
});
test('diagnostic exceptions and rejected promises never change a valid read',async()=>{
 for(const onEvent of [()=>{throw Error('private observer');},async()=>{throw Error('private async observer');}]){const f=fixture(1000,undefined,{onEvent});try{assert.equal((await f.host.readWithPermit(f.input)).allowed,true);}finally{f.host.close();}}
});


test('cached session failure updates advisory state without reviving the old grant',async()=>{
 const f=fixture();try{await f.host.readWithPermit(f.input);f.switch();await assert.rejects(f.host.readCachedWithPermit(f.input));assert.notEqual(f.host.getState(f.input).phase,'allowed');}finally{f.host.close();}
});
test('invalid or regressing clocks invalidate the observable state',async()=>{
 for(const broken of [{boot:'other',now_ms:101,wall_ms:10001},{boot:'boot',now_ms:99,wall_ms:10001},{boot:'boot',now_ms:101,wall_ms:NaN}]){
  let clock={boot:'boot',now_ms:100,wall_ms:10000};const f=fixture(1000,undefined,{clock:()=>clock});try{await f.host.readWithPermit(f.input);clock=broken;assert.equal(f.host.getState(f.input).phase,'denied');assert.equal(f.host.getState(f.input).reason,'clock_discontinuity');}finally{f.host.close();}
 }
});
test('a delayed server response after durable revoke cannot restore allow',async()=>{
 const feed=journal(),entered=deferred(),release=deferred();let hold=false;
 const f=fixture(1000,undefined,{changes:feed.changes,pollIntervalMs:0,onDenied:async()=>{},check:async(input,id)=>{if(hold){entered.resolve();await release.promise;}return f.reply(input,id);}});
 await f.host.readWithPermit(f.input);hold=true;const pending=f.host.readWithPermit(f.input);void pending.catch(()=>{});await entered.promise;
 try{feed.append('revoke');await f.host.catchUp();release.resolve();await assert.rejects(pending);assert.equal(f.host.getState(f.input).phase,'denied');await assert.rejects(f.host.readCachedWithPermit(f.input));}finally{release.resolve();await pending.catch(()=>{});f.host.close();}
});
test('a stalled diagnostic sink is bounded and never awaited by authorization',async()=>{
 const release=deferred(),events=[];let stalled=true;const f=fixture(1000,undefined,{onEvent:event=>{events.push(event);if(stalled)return release.promise;}});
 try{assert.equal((await f.host.revalidate(f.input)).allowed,true);assert.equal(events.length,1);stalled=false;release.resolve();await Promise.resolve();await f.host.revalidate(f.input);assert.ok(events.some(event=>event.droppedEvents>0));}finally{release.resolve();f.host.close();}
});
test('background change failures are observable with bounded sanitized diagnostics',async()=>{
 const feed=journal(),failed=deferred(),events=[];let breakFeed=false;
 const f=fixture(1000,undefined,{changes:{...feed.changes,fetch:async(...args)=>{if(breakFeed)throw Error('confidential transport payload hidden');return feed.changes.fetch(...args);}},pollIntervalMs:5,onDenied:async()=>{},onEvent:event=>{events.push(event);if(event.code==='authority_catch_up_failed')failed.resolve();}});
 let timeout;
 try{await f.host.readWithPermit(f.input);breakFeed=true;await Promise.race([failed.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('diagnostic_missing')),2000);})]);assert.equal(JSON.stringify(events).includes('hidden'),false);assert.equal(JSON.stringify(events).includes('confidential transport'),false);}finally{clearTimeout(timeout);f.host.close();}
});
test('callbacks after close are isolated and observations remain bounded',async()=>{
 const f=fixture(),states=[];f.host.subscribe(f.input,state=>states.push(state));await f.host.readWithPermit(f.input);
 for(let index=0;index<64;index++)f.host.subscribe({...f.input,resourceId:'watched-'+index},()=>{});
 assert.equal(states.at(-1).phase,'closed');assert.equal(states.at(-1).reason,'evicted');f.host.close();assert.doesNotThrow(()=>f.host.subscribe(f.input,()=>{throw Error('private');}));
});

test('slow asynchronous state observers coalesce to the newest snapshot without blocking reads',async()=>{
 const release=deferred(),seen=[];let hold=true;const f=fixture();const off=f.host.subscribe(f.input,state=>{seen.push(state);if(hold)return release.promise;});
 try{await f.host.readWithPermit(f.input);assert.equal(seen.length,1);hold=false;release.resolve();await Promise.resolve();await Promise.resolve();assert.equal(seen.at(-1).phase,'allowed');assert.equal(seen.length,2);}finally{release.resolve();off();f.host.close();}
});

test('non-finite clocks after a delayed granted callback cannot return a lease',async()=>{
 let clock={boot:'boot',now_ms:100,wall_ms:10000};const f=fixture(1000,undefined,{clock:()=>clock,onGranted:async()=>{clock={...clock,wall_ms:NaN};}});
 try{await assert.rejects(f.host.revalidate(f.input));assert.notEqual(f.host.getState(f.input).phase,'allowed');await assert.rejects(f.host.readCachedWithPermit(f.input));}finally{f.host.close();}
});
test('separate subscriptions using the same callback unsubscribe independently',async()=>{
 const f=fixture(),states=[],listener=state=>states.push(state.phase),off1=f.host.subscribe(f.input,listener),off2=f.host.subscribe(f.input,listener);
 try{assert.deepEqual(states,['idle','idle']);off1();await f.host.revalidate(f.input);assert.deepEqual(states,['idle','idle','checking','allowed']);off2();const count=states.length;f.host.close();assert.equal(states.length,count);}finally{off1();off2();f.host.close();}
});

test('a strict retry waits for a rejected check host denial without spinning on the settled inner promise',async()=>{
 const entered=deferred(),release=deferred();let held=false,reads=0;
 const f=fixture(1000,undefined,{onDenied:async()=>{if(!held){held=true;entered.resolve();await release.promise;}}});f.setStatus(403);
 const first=f.host.readWithPermit(f.input);void first.catch(()=>{});await entered.promise;
 const next={...f.input,get resourceId(){if(++reads>100)throw Error('recursive_retry');return f.input.resourceId;}};
 const retry=f.host.revalidate(next);void retry.catch(()=>{});const timer=setTimeout(()=>release.resolve(),5);
 try{await assert.rejects(first,/authz_check_denied/);await assert.rejects(retry,/authz_check_denied/);assert.ok(reads<100);}finally{clearTimeout(timer);release.resolve();await Promise.allSettled([first,retry]);f.host.close();}
});

test('a failed granted host callback cannot leave a usable secondary cache permit',async()=>{
 const f=fixture(1000,undefined,{onGranted:async()=>{throw Error('private storage failure');}});
 try{await assert.rejects(f.host.readWithPermit(f.input));assert.equal(f.host.getState(f.input).phase,'denied');await assert.rejects(f.host.readCachedWithPermit(f.input));}finally{f.host.close();}
});

}
