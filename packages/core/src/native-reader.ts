import {createProtocolCheckedReader,type CheckedReaderOptions} from './checked-reader-protocol.js';
import {createDrivenRuntime,type Authority} from './runtime-driver.js';
import type {Options,Runtime} from './index.js';
/** Synchronous UTF-8 JSON port implemented by the native Rust library bridge. */
export interface NativePort {call(request:string):string}
export async function createNativeRuntime(options:Omit<Options,'wasmBytes'> & {native:NativePort}):Promise<Runtime>{
 const invoke=(request:Record<string,unknown>)=>{
  const reply=JSON.parse(options.native.call(JSON.stringify(request)));
  if(reply?.ok!==true)throw Error(typeof reply?.error==='string'?reply.error:'native_response_invalid');
  return reply.value;
 };
 if(invoke({op:'version'})!==2)throw Error('abi_mismatch');
 const handle=invoke({op:'create',checkpoint:options.checkpoint});
 if(typeof handle!=='string'||!handle)throw Error('native_response_invalid');
 let closed=false,closedSnapshot:unknown;
 const run=(op:string,fields:Record<string,unknown>={})=>{if(closed)throw Error('runtime_unavailable');return invoke({op,handle,...fields});};
 const authority:Authority={
  evaluate:(resource,clock,offline)=>JSON.stringify(run('evaluate',{resource,clock:JSON.parse(clock),offline})),
  invalidated:(resources,clock,offline)=>JSON.stringify(run('invalidated',{resources:JSON.parse(resources),clock:JSON.parse(clock),offline})),
  prepare_snapshot:input=>JSON.stringify(run('prepare_snapshot',{input:JSON.parse(input)})),
  prepare_changes:input=>JSON.stringify(run('prepare_changes',{input:JSON.parse(input)})),
  acknowledge:(transitionId,revision)=>{run('acknowledge',{transitionId,revision});},
  snapshot:()=>JSON.stringify(closed?closedSnapshot:run('snapshot')),phase:()=>closed?'closed':run('phase'),fence:()=>{run('fence');},
  close:()=>{if(!closed){try{closedSnapshot=run('close');}finally{closed=true;}}},
 };
 return createDrivenRuntime({...options,authority,clone:value=>JSON.parse(JSON.stringify(value))});
}
export async function createNativeCheckedReader<T>(options:Omit<CheckedReaderOptions<T>,'wasmBytes'> & {native:NativePort;randomUUID():string}){
 return createProtocolCheckedReader({...options,clone:value=>JSON.parse(JSON.stringify(value)),createRuntime:input=>createNativeRuntime({...input,native:options.native})});
}
export type {CheckedRead,CheckedReader} from './checked-reader-protocol.js';

import {createDrivenResourceAuthority,type ResourceAuthorityOptions} from './resource-authority-driver.js';
/** Native-only module graph: no Wasm loader is imported or used. */
export function createNativeResourceAuthority<T=unknown>(options:Omit<ResourceAuthorityOptions<T>,'wasmBytes'> & {native:NativePort;randomUUID():string}){
 return createDrivenResourceAuthority({...options,clone:options.clone??(value=>JSON.parse(JSON.stringify(value))),runtime:options.runtime??(settings=>createNativeRuntime({...settings,native:options.native})),reader:options.reader??(settings=>createNativeCheckedReader({...settings,native:options.native,randomUUID:options.randomUUID}))});
}
