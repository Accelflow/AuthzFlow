import type {Checkpoint,Options,Plan,Runtime,RuntimeEvent} from './index.js';
import type {CheckedReader,CheckedReaderOptions} from './checked-reader.js';
import {createDrivenResourceChangeTracker,type ResourceChangeTracker} from './resource-change-tracker-driver.js';
export interface ResourceIdentity {binding:string;resourceId:string;scopeId:string}
export interface ResourceReadInput<T=unknown> extends ResourceIdentity {content:string;target?:T}
export type ResourceAuthorityPhase='idle'|'checking'|'allowed'|'revalidate'|'denied'|'expired'|'closed';
export type ResourceAuthorityReason='initial'|'check_started'|'online_grant'|'offline_grant'|'revalidation_required'|'server_denied'|'deadline_elapsed'|'context_changed'|'clock_discontinuity'|'check_failed'|'purge_blocked'|'closed'|'evicted';
/** Advisory snapshot; only a checked read/revalidation grants content access. */
export interface ResourceAuthorityState {readonly phase:ResourceAuthorityPhase;readonly reason:ResourceAuthorityReason;readonly revision:number;readonly mode:'online'|'offline'|null;readonly expiresAt:number|null;readonly validForMs:number}
export type ResourceAuthorityEventCode='authority_check_started'|'authority_revalidation_started'|'authority_granted'|'authority_invalidated'|'authority_check_failed'|'authority_catch_up_failed'|'authority_purge_blocked'|'authority_expired'|'authority_closed';
/** No content, identifiers, cursor, credential or raw error text. */
export interface ResourceAuthorityEvent {readonly schemaVersion:1;readonly code:ResourceAuthorityEventCode;readonly level:'info'|'warn'|'error';readonly phase:ResourceAuthorityPhase;readonly reason?:ResourceAuthorityReason;readonly revision?:number;readonly droppedEvents?:number}
export type ResourceAuthorityDiagnostic=RuntimeEvent|ResourceAuthorityEvent;
export interface ResourceReadLease {allowed:true;validForMs:number;expiresAt:number}
type Response={status:number;json():Promise<unknown>};
export interface ResourceAuthorityOptions<T=unknown> {
 session():Promise<{binding:string;context:string;expiresAtMs:number}>;
 clock():{boot:string;now_ms:number;wall_ms:number};hash(content:string):Promise<string>;
 storage:{load(kind:'reader'|'changes',resourceId:string):Promise<Checkpoint|null>;commit(kind:'reader'|'changes',resourceId:string,plan:Plan):Promise<string>};
 check(input:ResourceReadInput<T>,requestId:string):Promise<Response>;
 changes?:{snapshot(input:ResourceReadInput<T>,requestId:string):Promise<Response>;fetch(input:ResourceReadInput<T>,query:{requestId:string;cursor:string}):Promise<Response>};
 /** Trusted host storage proof, never a renderer-provided flag. Does not grant or renew. */
 ownsContent?(input:ResourceReadInput<T>):Promise<boolean>;
 onGranted?(input:ResourceReadInput<T>):Promise<void>;
 onDenied?(input:ResourceReadInput<T>):Promise<void>;
 onInvalidated?(input:ResourceReadInput<T>):void|Promise<void>;
 /** Optional bounded observer. Exceptions/rejections never affect authorization. */
 onEvent?(event:ResourceAuthorityDiagnostic):void|Promise<void>;
 runWithSession?(work:()=>Promise<void>):Promise<void>;
 wasmBytes?:Uint8Array<ArrayBuffer>;pollIntervalMs?:number;
 clone?<V>(value:V):V;randomUUID?:()=>string;
 /** Supply both factories for native Rust ports; neither may use a JS authorization fallback. */
 runtime?:(options:Options)=>Promise<Runtime>;
 reader?:(options:CheckedReaderOptions<string>)=>Promise<CheckedReader<string>>;
}
export interface ResourceAuthority<T=unknown> {
 readWithPermit(input:ResourceReadInput<T>):Promise<ResourceReadLease>;
 readCachedWithPermit(input:ResourceReadInput<T>):Promise<ResourceReadLease>;
 /** Drops the old in-memory permit; only a fresh online full check can succeed. */
 revalidate(input:ResourceReadInput<T>):Promise<ResourceReadLease>;
 getState(input:ResourceIdentity):ResourceAuthorityState;
 subscribe(input:ResourceIdentity,listener:(state:ResourceAuthorityState)=>void):()=>void;
 catchUp():Promise<void>;close():void;
}
type ReaderEntry<T>={input:ResourceReadInput<T>;version:number;reader?:CheckedReader<string>;ready?:Promise<CheckedReader<string>>;pending?:Promise<ResourceReadLease>;cached?:boolean;strict?:boolean;effects:Promise<void>;grantedContent?:string;readContent?:string;tracker?:ResourceChangeTracker;trackerReady?:Promise<ResourceChangeTracker>;createReader():Promise<CheckedReader<string>>};
/** Bounded multi-resource coordination of Rust readers, durable cursors and host-owned replicas. */
export function createDrivenResourceAuthority<T=unknown>(options:ResourceAuthorityOptions<T>):ResourceAuthority<T>{
 if(options.changes&&typeof options.onDenied!=='function'||(options.runtime===undefined)!==(options.reader===undefined))throw Error('authz_authority_config_invalid');
 const clone=options.clone??structuredClone;
 const readers=new Map<string,ReaderEntry<T>>();let closed=false,polling:Promise<void>|undefined;
 type Observation={state:ResourceAuthorityState;listeners:Map<(state:ResourceAuthorityState)=>void,{busy:boolean;pending:boolean}>;clock?:ReturnType<typeof options.clock>;deadline?:number;timer?:ReturnType<typeof setTimeout>};
 const observations=new Map<string,Observation>();let observing=false,dropped=0;
 const emit=(event:ResourceAuthorityDiagnostic)=>{
  if(!options.onEvent)return;
  if(observing){dropped=Math.min(Number.MAX_SAFE_INTEGER,dropped+1);return;}
  observing=true;
  try{const value=Object.freeze({...event,...(dropped?{droppedEvents:dropped}:{})});dropped=0;const result=options.onEvent(value);
   if(result&&typeof result.then==='function')void Promise.resolve(result).then(()=>{observing=false;},()=>{observing=false;dropped=Math.min(Number.MAX_SAFE_INTEGER,dropped+1);});else observing=false;
  }catch{observing=false;dropped=Math.min(Number.MAX_SAFE_INTEGER,dropped+1);}
 };
 const runtimeEvent=options.onEvent?(event:RuntimeEvent)=>emit(event):undefined;
 const keyOf=(input:ResourceIdentity)=>{if(!input||![input.binding,input.resourceId,input.scopeId].every(value=>typeof value==='string'&&value.length>0&&value.length<=4096))throw Error('authz_view_invalid');return JSON.stringify([input.binding,input.resourceId,input.scopeId]);};
 const initial=(phase:ResourceAuthorityPhase='idle',reason:ResourceAuthorityReason='initial'):ResourceAuthorityState=>Object.freeze({phase,reason,revision:0,mode:null,expiresAt:null,validForMs:0});
 const notify=(record:Observation,listener:(state:ResourceAuthorityState)=>void)=>{
  const slot=record.listeners.get(listener);if(!slot)return;if(slot.busy){slot.pending=true;return;}slot.busy=true;
  const finished=()=>{slot.busy=false;if(record.listeners.get(listener)===slot&&slot.pending){slot.pending=false;notify(record,listener);}};
  try{const result=listener(record.state) as unknown;if(result&&typeof (result as Promise<void>).then==='function'){void Promise.resolve(result).then(finished,finished);}else finished();}catch{finished();}
 };
 const publish=(record:Observation,phase:ResourceAuthorityPhase,reason:ResourceAuthorityReason,lease?:ResourceReadLease,offline=false)=>{
  clearTimeout(record.timer);record.timer=undefined;record.clock=lease?options.clock():undefined;record.deadline=lease?record.clock!.now_ms+lease.validForMs:undefined;
  record.state=Object.freeze({phase,reason,revision:record.state.revision+1,mode:lease?(offline?'offline':'online'):null,expiresAt:lease?.expiresAt??null,validForMs:lease?.validForMs??0});
  for(const listener of [...record.listeners.keys()])notify(record,listener);
  schedule(record);
 };
 const sample=(record:Observation)=>{
  if(record.state.phase!=='allowed')return record.state;
  const now=options.clock(),last=record.clock!,remaining=Math.min(record.deadline!-now.now_ms,record.state.expiresAt!-now.wall_ms);
  if(!now.boot||!Number.isSafeInteger(now.now_ms)||now.now_ms<0||!Number.isSafeInteger(now.wall_ms)||now.wall_ms<0||now.boot!==last.boot||now.now_ms<last.now_ms||now.wall_ms<last.wall_ms){publish(record,'denied','clock_discontinuity');return record.state;}
  record.clock=now;
  if(remaining<=0){publish(record,'expired','deadline_elapsed');if(options.onEvent)emit({schemaVersion:1,code:'authority_expired',level:'info',phase:'expired',reason:'deadline_elapsed',revision:record.state.revision});}
  else record.state=Object.freeze({...record.state,validForMs:Math.floor(remaining)});
  return record.state;
 };
 const schedule=(record:Observation)=>{
  if(record.state.phase!=='allowed'||!record.listeners.size)return;
  record.timer=setTimeout(()=>{record.timer=undefined;sample(record);if(record.state.phase==='allowed')schedule(record);},Math.max(1,record.state.validForMs));
  (record.timer as unknown as {unref?():void})?.unref?.();
 };
 const retire=(key:string,reason:'closed'|'evicted')=>{
  const record=observations.get(key);if(record){publish(record,'closed',reason);record.listeners.clear();}
  const entry=readers.get(key);readers.delete(key);entry?.reader?.close();entry?.tracker?.close();
  if(reason==='evicted')observations.delete(key);
 };
 const observe=(input:ResourceIdentity)=>{
  const key=keyOf(input);let record=observations.get(key);
  if(!record){if(observations.size>=64)retire(observations.keys().next().value!,'evicted');record={state:initial(),listeners:new Map()};observations.set(key,record);}
  return record;
 };
 const effect=(entry:ReaderEntry<T>,work:()=>Promise<void>)=>{const task=entry.effects.then(work);entry.effects=task.catch(()=>{});return task;};
 const deny=async(entry:ReaderEntry<T>,record:Observation)=>{try{await effect(entry,async()=>{await options.onDenied?.(entry.input);});}catch(error:any){if(options.onEvent&&['authz_purge_dirty_target','authz_purge_blocked'].includes(error?.message))emit({schemaVersion:1,code:'authority_purge_blocked',level:'warn',phase:'denied',reason:'purge_blocked',revision:record.state.revision});throw error;}};
 const verify=async(input:ResourceReadInput<T>,cached=false,strict=false):Promise<ResourceReadLease>=>{
  if(closed)throw Error('context_changed');
  if(!input||!['binding','resourceId','scopeId','content'].every(key=>{const value=input[key as keyof ResourceReadInput<T>];return typeof value==='string'&&value.length>0&&value.length<=(key==='content'?1048576:4096);}))throw Error('authz_view_invalid');
  const resource=input.resourceId,key=keyOf(input),record=observe(input);let entry=readers.get(key);
  if(!entry){
   if(cached)throw Error('authz_cached_permit_missing');
   const owned:ReaderEntry<T>={input:clone(input),version:0,effects:Promise.resolve(),createReader(){const version=owned.version;return options.reader!({binding:input.binding,resourceId:resource,scopeId:input.scopeId,session:options.session,clock:options.clock,wasmBytes:options.wasmBytes,onEvent:runtimeEvent,
    storage:{load:()=>options.storage.load('reader',resource),commit:plan=>options.storage.commit('reader',resource,plan)},
    check:async({requestId})=>{owned.readContent=undefined;try{return await options.check(owned.input,requestId);}catch(error:any){if((error instanceof TypeError||error?.name==='TimeoutError')&&owned.grantedContent&&owned.input.content!==owned.grantedContent&&await options.ownsContent?.(owned.input))owned.readContent=owned.grantedContent;throw error;}},read:async()=>owned.readContent??owned.input.content,contentHash:options.hash,
   }).then(reader=>{if(closed||readers.get(key)!==owned||version!==owned.version){reader.close();throw Error('context_changed');}owned.reader=reader;return reader;});}};
   readers.set(key,owned);entry=owned;
   if(options.changes){owned.trackerReady=createDrivenResourceChangeTracker({binding:input.binding,resource,scopeId:input.scopeId,randomUUID:options.randomUUID,wasmBytes:options.wasmBytes,onEvent:runtimeEvent,runtime:options.runtime,session:options.session,clock:()=>{const {boot,now_ms}=options.clock();return {boot,now_ms};},wall:()=>options.clock().wall_ms,
    storage:{load:()=>options.storage.load('changes',resource),commit:plan=>options.storage.commit('changes',resource,plan)},
    snapshot:({requestId})=>options.changes!.snapshot(owned.input,requestId),fetchChanges:query=>options.changes!.fetch(owned.input,query),
    invalidate:async state=>{
     owned.version++;owned.reader?.close();owned.reader=undefined;owned.ready=undefined;owned.grantedContent=undefined;
     const denied=state.resources[resource]?.access==='deny'||state.scopes[input.scopeId]?.access==='deny';
     publish(record,denied?'denied':'revalidate',denied?'server_denied':'revalidation_required');
     if(options.onEvent)emit({schemaVersion:1,code:'authority_invalidated',level:'info',phase:record.state.phase,reason:record.state.reason,revision:record.state.revision});
     const saved=await options.storage.load('reader',resource),base:Checkpoint=saved??{schema_version:1,binding:input.binding,epoch:state.epoch,sequence:'0',revision:'0',cursor:'',phase:'uninitialized',resources:{},scopes:{}};
     const runtime=await options.runtime!({checkpoint:base,clock:()=>{const {boot,now_ms}=options.clock();return {boot,now_ms};},commit:plan=>options.storage.commit('reader',resource,plan),wasmBytes:options.wasmBytes,onEvent:runtimeEvent});
     try{const next=clone(base);next.phase='ready';const previous=Object.hasOwn(next.resources,resource)?next.resources[resource]:undefined;next.resources={...next.resources,[resource]:{...(previous??{version:'0',expires_at_ms:0,offline:false,boot:options.clock().boot,scopes:[],stale:false}),access:denied?'deny':'revalidate'}};await runtime.applySnapshot(next);}finally{runtime.close();}
     await options.onInvalidated?.(owned.input);
    },
    purge:async ids=>{if(ids.some(id=>id!==resource))throw Error('authz_purge_target_invalid');try{if(ids.length)await deny(owned,record);return {status:'purged'};}catch(error:any){if(['authz_purge_dirty_target','authz_purge_blocked'].includes(error?.message)){return {status:'blocked'};}throw error;}},
   }).then(tracker=>{if(closed||readers.get(key)!==owned){tracker.close();throw Error('context_changed');}owned.tracker=tracker;return tracker;});void owned.trackerReady.catch(()=>{});}
  }
  if(entry.pending){if(cached)throw Error('check_in_progress');if(entry.input.content===input.content&&!entry.cached&&entry.strict===strict)return entry.pending;await entry.pending.catch(()=>{});return verify(input,cached,strict);}
  entry.input=clone(input);entry.cached=cached;entry.strict=strict;entry.readContent=undefined;
  const owned=entry;
  let turn=owned.version;
  const valid=()=>{if(closed||readers.get(key)!==owned||owned.version!==turn)throw Error('context_changed');};
  const run=Promise.resolve().then(async()=>{
   if(strict){owned.version++;owned.reader?.close();owned.reader=undefined;owned.ready=undefined;owned.grantedContent=undefined;}
   turn=owned.version;
   if(!cached){publish(record,'checking','check_started');if(options.onEvent)emit({schemaVersion:1,code:strict?'authority_revalidation_started':'authority_check_started',level:'info',phase:'checking',revision:record.state.revision});}
   if(cached&&owned.grantedContent&&input.content!==owned.grantedContent&&await options.ownsContent?.(input)){if(closed||readers.get(key)!==owned)throw Error('context_changed');owned.input.content=owned.grantedContent;}
   if(!cached&&owned.trackerReady){try{await (await owned.trackerReady).prepare();}catch(error:any){if(!(error instanceof TypeError||error?.name==='TimeoutError'))throw error;}}
   turn=owned.version;owned.ready??=owned.createReader();const result=await (await owned.ready)[cached?'readCachedWithPermit':'readWithPermit']();
   valid();if(strict&&result.offline)throw Error('authz_online_check_required');
   if(closed||readers.get(key)!==owned)throw Error('context_changed');const delivered=options.clock();
   if(!cached&&!result.offline){await effect(owned,async()=>{valid();await options.onGranted?.(owned.input);valid();});owned.grantedContent=owned.input.content;}
   if(closed||readers.get(key)!==owned)throw Error('context_changed');const now=options.clock();
   const remaining=Math.min(result.validForMs-(now.now_ms-delivered.now_ms),result.expiresAtMs-now.wall_ms);
   if(![now.now_ms,now.wall_ms,delivered.now_ms,delivered.wall_ms].every(value=>Number.isSafeInteger(value)&&value>=0)||!now.boot||now.boot!==delivered.boot||now.now_ms<delivered.now_ms||now.wall_ms<delivered.wall_ms||remaining<1)throw Error('authz_offline_expired');
   valid();const lease={allowed:true as const,validForMs:Math.floor(remaining),expiresAt:Math.floor(Math.min(result.expiresAtMs,now.wall_ms+remaining))};
   if(!cached){publish(record,'allowed',result.offline?'offline_grant':'online_grant',lease,result.offline);if(options.onEvent)emit({schemaVersion:1,code:'authority_granted',level:'info',phase:'allowed',reason:record.state.reason,revision:record.state.revision});}
   return lease;
  });
  const complete:Promise<ResourceReadLease>=Promise.resolve().then(async()=>{
  try{return await run;}catch(error:any){
   if(!cached&&readers.get(key)===owned&&owned.version===turn){owned.reader?.close();owned.reader=undefined;owned.ready=undefined;owned.grantedContent=undefined;}
   const reason:ResourceAuthorityReason=error?.message==='authz_check_denied'?'server_denied':error?.message==='context_changed'?'context_changed':error?.message==='clock_discontinuity'?'clock_discontinuity':error?.message==='authz_offline_expired'?'deadline_elapsed':'check_failed';
   if((!cached||['context_changed','clock_discontinuity','authz_offline_expired','runtime_unavailable'].includes(error?.message))&&readers.get(key)===owned&&owned.version===turn)publish(record,reason==='deadline_elapsed'?'expired':'denied',reason);
   if(options.onEvent)emit({schemaVersion:1,code:'authority_check_failed',level:'warn',phase:record.state.phase,reason,revision:record.state.revision});
   if(!cached&&error?.message==='authz_check_denied')await deny(owned,record);throw error;
  }finally{if(owned.pending===complete)owned.pending=undefined;}
  });owned.pending=complete;return complete;

 };
 const api:ResourceAuthority<T>={readWithPermit:input=>verify(input),readCachedWithPermit:input=>verify(input,true),revalidate:input=>verify(input,false,true),
 getState(input){const key=keyOf(input),record=observations.get(key);return record?sample(record):initial(closed?'closed':'idle',closed?'closed':'initial');},
 subscribe(input,listener){if(typeof listener!=='function')throw Error('authz_observer_invalid');if(closed){notify({state:api.getState(input),listeners:new Map([[listener,{busy:false,pending:false}]])},listener);return ()=>{};}const subscriber=(state:ResourceAuthorityState)=>listener(state);const record=observe(input);if(record.listeners.size>=64)throw Error('authz_observer_limit');sample(record);record.listeners.set(subscriber,{busy:false,pending:false});notify(record,subscriber);clearTimeout(record.timer);schedule(record);return ()=>{record.listeners.delete(subscriber);if(!record.listeners.size){clearTimeout(record.timer);record.timer=undefined;}};},
 async catchUp(){
  if(polling)return polling;const task=(async()=>{let failure:unknown;const entries=[...readers.values()].filter(entry=>entry.trackerReady);for(let index=0;index<entries.length;index+=8){const results=await Promise.allSettled(entries.slice(index,index+8).map(async entry=>(await entry.trackerReady!).catchUp()));for(const result of results)if(result.status==='rejected')failure??=result.reason;}if(failure)throw failure;})();
  polling=task;try{return await task;}catch(error){if(options.onEvent)emit({schemaVersion:1,code:'authority_catch_up_failed',level:'warn',phase:'revalidate',reason:'check_failed'});throw error;}finally{if(polling===task)polling=undefined;}
 },close(){if(closed)return;closed=true;clearInterval(timer);for(const key of observations.keys())retire(key,'closed');if(options.onEvent)emit({schemaVersion:1,code:'authority_closed',level:'info',phase:'closed',reason:'closed'});}};
 const timer=options.changes&&options.pollIntervalMs!==0?setInterval(()=>{if(polling)return;const work=()=>api.catchUp();void (options.runWithSession?options.runWithSession(work):work()).catch(()=>{});},options.pollIntervalMs??5000):undefined;
 (timer as unknown as {unref?():void})?.unref?.();return api;
}
