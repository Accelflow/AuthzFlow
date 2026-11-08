import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../../../contracts/resource-group/v2/fixtures.json',import.meta.url)));
export function memoryGroupStore(){
 const rows=new Map();let tail=Promise.resolve();
 return {rows,async read(key){await tail;return structuredClone(rows.get(key)??null);},async readMany(keys){await tail;return keys.map(key=>structuredClone(rows.get(key)??null));},transaction(key,work){const task=tail.then(()=>{const {row,result}=work(structuredClone(rows.get(key)??null));rows.set(key,structuredClone(row));return structuredClone(result);});tail=task.catch(()=>{});return task;}};
}
export function groupHost(create,extra={}){
 const storage=extra.storage??memoryGroupStore(),group=fixture.identity;let wall=1000,context='context-a',seq=0,pulls=0,subscribes=0,offline=false,block=false,failPurge=false,purges=[];
 const events=[],listeners=new Set();
 const transport={
  async subscribe(g,requestId){subscribes++;if(offline)throw new TypeError('offline');return {status:200,json:async()=>({schemaVersion:2,kind:'resource_group',requestId,...g,position:{epoch:'epoch-a',sequence:String(seq),cursor:'cursor-'+seq}})};},
  async fetch(g,{requestId,cursor}){pulls++;if(offline)throw new TypeError('offline');const from=Number(cursor.slice(7));return {status:200,json:async()=>({schemaVersion:2,kind:'resource_group',requestId,hasMore:false,batch:{...g,epoch:'epoch-a',fromSequence:String(from),throughSequence:String(seq),nextCursor:'cursor-'+seq,changes:events.filter(e=>Number(e.sequence)>from)}})};},
 };
 const options={namespace:'test-authority',storage,session:async()=>({binding:group.binding,context,expiresAtMs:100000}),wall:()=>wall,randomUUID:()=>crypto.randomUUID(),transport,pollIntervalMs:0,
  async purge(input){await input.assertCurrent();if(block)return {status:'blocked'};if(failPurge)throw Error('delete failed');purges.push(input.resourceId);return {status:'purged'};},
  notify:notice=>{for(const l of listeners)l(notice);},listen:l=>{listeners.add(l);return ()=>listeners.delete(l);},...extra};
 return {group,storage,options,async create(){return create(options);},set wall(v){wall=v;},get wall(){return wall;},set context(v){context=v;},set offline(v){offline=v;},set block(v){block=v;},set failPurge(v){failPurge=v;},get pulls(){return pulls;},get purges(){return purges;},get subscribes(){return subscribes;},anchor:()=>({resourceGroupId:group.resourceGroupId,epoch:'epoch-a',sequence:String(seq)}),event(action='revoke'){seq++;events.push({sequence:String(seq),action});},emit(n){for(const l of listeners)l(n);}};
}
export function registerGroupContract(name,create){
 test(`${name}: another process's regrant cannot suppress local invalidation`,async()=>{
  const h=groupHost(create,{notify:undefined,listen:undefined}),a=await h.create(),b=await h.create(),i={...h.group,resourceId:'article-a'};let invalidated=0;
  try{await a.register(i);await a.granted(i,h.anchor());await b.register(i,()=>invalidated++);const old=await b.stamp(i);h.event();await a.catchUp();await a.granted(i,h.anchor());await assert.rejects(b.guard(i,old));assert.equal(invalidated,1);}finally{await a.close();await b.close();}
 });
 test(`${name}: delayed old owner response cannot commit after takeover`,async()=>{
  const h=groupHost(create),a=await h.create(),b=await h.create(),i={...h.group,resourceId:'article-a'};
  let release,started;const began=new Promise(r=>started=r),hold=new Promise(r=>release=r),original=h.options.transport.fetch;
  try{await a.register(i);await a.granted(i,h.anchor());await b.register(i);
   let once=true;h.options.transport.fetch=async(...args)=>{if(once){once=false;started();await hold;}return original(...args);};
   const old=a.catchUp();await began;h.wall+=16000;h.event();await b.catchUp();release();await assert.rejects(old,/group_owner_changed/);assert.equal([...h.storage.rows.values()][0].term,'2');
  }finally{release?.();await a.close();await b.close();}
 });
 test(`${name}: two Resources share one poll and revoke fences both`,async()=>{
  const host=groupHost(create),c=await host.create();host.block=true;
  try{
   const inputs=fixture.resources.map(resourceId=>({...host.group,resourceId}));
   for(const input of inputs){await c.register(input);await c.granted(input,host.anchor());}
   const stamps=await Promise.all(inputs.map(i=>c.stamp(i))),before=host.pulls;host.event();await c.catchUp();
   assert.equal(host.pulls-before,1);
   for(let i=0;i<inputs.length;i++)await assert.rejects(c.guard(inputs[i],stamps[i]),/group_revalidation_required/);
   assert.equal([...host.storage.rows.values()][0].state.resources['article-a'].intent,'revoke');
   host.block=false;await c.catchUp();assert.deepEqual(host.purges.sort(),fixture.resources.slice().sort());
   await c.granted(inputs[0],host.anchor());await c.guard(inputs[0],await c.stamp(inputs[0]));await assert.rejects(c.guard(inputs[1],stamps[1]));
  }finally{await c.close();}
 });
 test(`${name}: stale check, wrong Group, malformed batch and missing cursor cannot grant`,async()=>{
  const h=groupHost(create),c=await h.create(),input={...h.group,resourceId:'article-a'};
  try{await c.register(input);const old=h.anchor();h.event('revalidate');await c.catchUp();await assert.rejects(c.granted(input,old),/group_check_raced/);await assert.rejects(c.acceptCheck(input,{...h.anchor(),resourceGroupId:'other'}),/membership/);
   h.options.transport.fetch=async(g,{requestId})=>({status:200,json:async()=>({schemaVersion:2,kind:'resource_group',requestId,hasMore:false,batch:{...g,epoch:'epoch-a',fromSequence:'1',throughSequence:'3',nextCursor:'c',changes:[{sequence:'3',action:'revoke'}]}})});
   await assert.rejects(c.catchUp());await assert.rejects(c.guard(input,await c.stamp(input)));
  }finally{await c.close();}
 });
 test(`${name}: owner takeover fences delayed old commit; grants are not transferred`,async()=>{
  const h=groupHost(create),first=await h.create(),second=await h.create(),i={...h.group,resourceId:'article-a'};
  try{await first.register(i);await first.granted(i,h.anchor());await second.register(i);const before=h.pulls;await second.catchUp();assert.equal(h.pulls,before);
   h.wall+=16000;h.event();await second.catchUp();assert.equal(h.pulls,before+1);await assert.rejects(first.guard(i,{...await first.stamp(i),generation:'0'}));
   await first.close();const row=[...h.storage.rows.values()][0];assert.ok(row.owner);assert.equal(row.term,'2');
  }finally{await first.close();await second.close();}
 });
 test(`${name}: purge failure survives restart and dirty Resource does not stall later changes`,async()=>{
  const h=groupHost(create),c=await h.create(),i={...h.group,resourceId:'article-a'};await c.register(i);await c.granted(i,h.anchor());h.failPurge=true;h.event();await c.catchUp();await c.close();
  const restarted=await h.create();try{h.event('revalidate');await restarted.catchUp(h.group);assert.equal([...h.storage.rows.values()][0].state.sequence,'2');assert.equal([...h.storage.rows.values()][0].state.resources['article-a'].intent,'revoke');h.failPurge=false;await restarted.catchUp();assert.ok(h.purges.includes('article-a'));}finally{await restarted.close();}
 });
 test(`${name}: notification loss, forged notification, context switch and clock rollback fail safely`,async()=>{
  const storage=memoryGroupStore(),h=groupHost(create,{storage,notify:undefined,listen:undefined}),a=await h.create(),b=await h.create(),i={...h.group,resourceId:'article-a'};
  try{await a.register(i);await a.granted(i,h.anchor());await b.register(i);const stamp=await b.stamp(i);h.event();await a.catchUp();await assert.rejects(b.guard(i,stamp));
   h.context='different';await assert.rejects(b.stamp(i),/context_changed/);
  }finally{await a.close();await b.close();}
  const h2=groupHost(create),c=await h2.create();try{await c.prepare(h2.group);h2.wall=1;await assert.rejects(c.stamp(h2.group),/clock_discontinuity/);}finally{await c.close();}
 });
 test(`${name}: unknown future wire is rejected by real Rust`,async()=>{
  const h=groupHost(create),c=await h.create();try{await c.register({...h.group,resourceId:'r'});const saved=[...h.storage.rows.values()][0];saved.state.schemaVersion=999;h.storage.rows.set([...h.storage.rows.keys()][0],saved);await assert.rejects(c.stamp(h.group),/group_state_invalid/);}finally{await c.close();}
 });
}
