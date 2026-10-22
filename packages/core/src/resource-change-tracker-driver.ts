import type {Runtime,Options,Checkpoint,Entry,Plan,RuntimeEvent} from './index.js';
import {createChangeConsumer,type ChangeConsumer} from './change-consumer.js';
import type {ReplicaPurgeOutcome} from './replicas.js';
export interface ResourceChangeTrackerOptions {
 onEvent?:(event:RuntimeEvent)=>void|Promise<void>;
 binding:string;resource:string;scopeId:string;randomUUID?:()=>string;wasmBytes?:Uint8Array<ArrayBuffer>;
 runtime?:(options:Options)=>Promise<Runtime>;
 session():Promise<{binding:string;context:string;expiresAtMs:number}>;
 clock():{boot:string;now_ms:number};wall():number;
 storage:{load():Promise<Checkpoint|null>;commit(plan:Plan):Promise<string>};
 snapshot(input:{requestId:string}):Promise<{status:number;json():Promise<unknown>}>;
 fetchChanges(input:{requestId:string;cursor:string}):Promise<{status:number;json():Promise<unknown>}>;
 invalidate(snapshot:Checkpoint):Promise<void>;
 purge(ids:string[],revision:string):Promise<void|ReplicaPurgeOutcome>;
}
export interface ResourceChangeTracker {prepare():Promise<void>;catchUp():Promise<void>;close():void}
/** Metadata never grants content. A complete online check remains necessary after recovery. */
export async function createDrivenResourceChangeTracker(options:ResourceChangeTrackerOptions,runtimeFactory=options.runtime!):Promise<ResourceChangeTracker>{
 let runtime:Runtime|undefined,consumer:ChangeConsumer|undefined,closed=false,identity:{context:string}|undefined,tail=Promise.resolve();
 const current=async()=>{const value=await options.session();if(closed||value.binding!==options.binding||value.expiresAtMs<=options.wall()||identity&&value.context!==identity.context)throw Error('context_changed');identity??={context:value.context};};
 const entry=(access:Entry['access']):Entry=>({access,version:runtime?.snapshot().sequence??'0',expires_at_ms:0,offline:false,boot:options.clock().boot,scopes:[],stale:false});
 const initial=(saved:Checkpoint|null,epoch='uninitialized'):Checkpoint=>({schema_version:1,binding:options.binding,epoch,sequence:'0',revision:saved?.revision??'0',cursor:'',phase:'uninitialized',resources:{},scopes:{}});
 const commit=async(plan:Plan)=>{await current();const old=await options.storage.load();await current();const revision=await options.storage.commit(plan);await current();if(old&&(old.sequence!==plan.next.sequence||old.epoch!==plan.next.epoch||JSON.stringify(old.scopes)!==JSON.stringify(plan.next.scopes)||JSON.stringify(old.resources)!==JSON.stringify(plan.next.resources)))await options.invalidate(plan.next);await current();return revision;};
 const attach=async(saved:Checkpoint)=>{
  runtime?.close();const next=await runtimeFactory({checkpoint:saved,clock:options.clock,commit,wasmBytes:options.wasmBytes,onEvent:options.onEvent});
  try{await current();}catch(error){next.close();throw error;}runtime=next;
  if(saved.phase==='ready'){await runtime.applySnapshot({...saved,phase:'ready'});await current();}
  consumer=createChangeConsumer({runtime,randomUUID:options.randomUUID,purge:async(ids,revision)=>{await current();const result=await options.purge(ids,revision);await current();return result;},fetchChanges:async input=>{
   await current();const response=await options.fetchChanges(input);await current();if(response.status!==200)return response;
   const body:any=await response.json();await current();
   if(body?.batch?.changes?.some((event:any)=>!event?.target||(event.target.kind==='scope'?event.target.id!==options.scopeId:event.target.kind!=='resource'||event.target.id!==options.resource)))throw Error('authz_changes_invalid');
   return {status:200,json:async()=>body};
  }});
 };
 const fence=async()=>{await current();const saved=await options.storage.load();await current();await attach(saved??initial(null,'denied'));const state=runtime!.snapshot();await runtime!.applySnapshot({...state,phase:'ready',resources:{[options.resource]:{...entry('deny'),scopes:[options.scopeId]}},scopes:{[options.scopeId]:entry('deny')}});await current();};
 const install=async()=>{
  const requestId=options.randomUUID?.()??crypto.randomUUID(),response=await options.snapshot({requestId});await current();
  if(response.status!==200){if([401,403,404].includes(response.status)){await fence();await options.purge([options.resource],runtime!.snapshot().revision);throw Error('authz_check_denied');}throw Error('authz_check_unavailable');}
  const body:any=await response.json();await current();const stream=body?.stream;
  if(body?.schemaVersion!==1||body.mode!=='check_only'||body.requestId!==requestId||body.binding!==options.binding||body.resourceId!==options.resource||body.scopeId!==options.scopeId||!stream||typeof stream.epoch!=='string'||!stream.epoch||stream.epoch.length>128||typeof stream.sequence!=='string'||!/^(0|[1-9][0-9]*)$/.test(stream.sequence)||stream.sequence.length>20||BigInt(stream.sequence)>18446744073709551615n||typeof stream.cursor!=='string'||!stream.cursor||stream.cursor.length>8192)throw Error('authz_check_invalid');
  const saved=await options.storage.load();await current();await attach(initial(saved,stream.epoch));
  await runtime!.applySnapshot({...runtime!.snapshot(),phase:'ready',sequence:stream.sequence,cursor:stream.cursor,resources:{[options.resource]:{...entry('revalidate'),version:stream.sequence,scopes:[options.scopeId]}},scopes:{[options.scopeId]:{...entry('revalidate'),version:stream.sequence}}});await current();
 };
 const run=async(prepare:boolean)=>{
  await current();if(!runtime){const saved=await options.storage.load();await current();if(saved)await attach(saved);}
  if(!runtime){if(prepare)await install();return;}
  try{await consumer!.catchUp();await current();}
  catch(error:any){
   if(error?.message==='authz_changes_reset_required'){await fence();try{await options.purge([options.resource],runtime.snapshot().revision);}catch(failure:any){if(failure?.message!=='authz_purge_blocked')throw failure;}await install();return;}
   if(error?.message==='authz_purge_blocked'){if(prepare){await install();return;}throw error;}
   if(!(error instanceof TypeError||error?.name==='TimeoutError'))await fence();throw error;
  }
  const state=runtime.snapshot();if(prepare&&[...Object.values(state.resources),...Object.values(state.scopes)].some(value=>value.access==='deny'))await install();
 };
 const serial=(prepare:boolean)=>{const pending=tail.then(()=>run(prepare));tail=pending.catch(()=>{});return pending;};
 return {prepare:()=>serial(true),catchUp:()=>serial(false),close(){closed=true;runtime?.close();}};
}
