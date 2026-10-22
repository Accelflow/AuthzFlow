import {createRuntime, type Checkpoint, type Clock, type Plan, type Runtime} from './index.js';
export interface CacheStorage {
 load(binding:string):Promise<Checkpoint|null>;
 commit(plan:Plan):Promise<string>;
 read(binding:string,resource:string):Promise<Uint8Array|null>;
 put(binding:string,resource:string,value:Uint8Array,expectedRevision:string):Promise<void>;
 purge(binding:string,resources:string[],expectedRevision:string):Promise<void>;
 close():void;
}
export interface CachedRuntime extends Omit<Runtime,'get'> {
 get(resource:string,offline?:boolean):Promise<Uint8Array|null>;
 put(resource:string,value:Uint8Array,expectedRevision:string):Promise<void>;
 purge(resources:string[],expectedRevision:string):Promise<void>;
}
/** One owner. put registers bytes under an existing grant; it never grants access.
 * Capture revision before fetching, and pass that revision to put. Server snapshots are trusted host inputs.
 */
export async function createCachedRuntime(options:{checkpoint:Checkpoint;storage:CacheStorage;clock:()=>Clock;wasmBytes?:Uint8Array<ArrayBuffer>}):Promise<CachedRuntime>{
 const {storage}=options,binding=options.checkpoint.binding;
 const saved=await storage.load(binding);
 if(saved&&saved.binding!==binding)throw Error('context_changed');
 const rt=await createRuntime({checkpoint:saved??options.checkpoint,clock:options.clock,wasmBytes:options.wasmBytes,commit:plan=>storage.commit(plan)});
 return {
  applySnapshot:state=>rt.applySnapshot(state),applyChanges:batch=>rt.applyChanges(batch),
  tick:offline=>rt.tick(offline),close:()=>rt.close(),snapshot:()=>rt.snapshot(),
  get:(resource,offline=false)=>rt.get(resource,async()=>{const revision=rt.snapshot().revision;const before=await storage.load(binding);if(before?.binding!==binding||before?.revision!==revision)throw Error('cache_revision_conflict');const value=await storage.read(binding,resource);const after=await storage.load(binding);if(after?.binding!==binding||after?.revision!==revision)throw Error('cache_revision_conflict');return value===null?null:new Uint8Array(value);},offline),
  async put(resource,value,expectedRevision){
   if(!(value instanceof Uint8Array)||value.byteLength>4*1024*1024)throw Error('cache_value_invalid');
   const copy=new Uint8Array(value);
   if(expectedRevision!==rt.snapshot().revision)throw Error('cache_revision_conflict');
   await rt.get(resource,()=>storage.put(binding,resource,copy,expectedRevision));
  },
  async purge(resources,expectedRevision){
   const state=rt.snapshot();
   if(expectedRevision!==state.revision)throw Error('cache_revision_conflict');
   for(const resource of resources){const e=state.resources[resource];if(!e||!(e.access==='deny'||e.scopes.some(id=>state.scopes[id]?.access==='deny')))throw Error('cache_purge_not_denied');}
   await storage.purge(binding,[...resources],expectedRevision);
  },
 };
}
