export interface ResourceGroupTarget {resourceGroupId:string}
export interface ResourceGroupPosition {epoch:string;sequence:string;cursor:string}
export interface ResourceGroupJournal<Target extends ResourceGroupTarget> {
  barrier<T>(work:()=>Promise<T>):Promise<T>;
  /** Authoritative entitlement, including a bounded former-subscriber revocation path. */
  subscribe(binding:string,target:Target):Promise<ResourceGroupPosition>;
  read(binding:string,target:Target,cursor:string,limit:number):Promise<{
    batch:{binding:string;resourceGroupId:string;epoch:string;fromSequence:string;throughSequence:string;nextCursor:string;changes:{sequence:string;action:'revoke'|'revalidate'}[]};hasMore:boolean;
  }>;
}
type FeedResult={status:number;headers:Readonly<{'Cache-Control':'no-store'}>;body:unknown};
export interface ResourceGroupFeedOptions<Context,Target extends ResourceGroupTarget> {
  authenticate(context:Context):Promise<{binding:string}|null>;
  journal:ResourceGroupJournal<Target>;
}

/** Metadata-only Group feed. Product journal must enforce cursor and subscriber binding. */
export function createResourceGroupFeed<Context,Target extends ResourceGroupTarget>(options:ResourceGroupFeedOptions<Context,Target>) {
  const headers=Object.freeze({'Cache-Control':'no-store' as const});
  const error=(status:number,code:string):FeedResult=>({status,headers,body:{error:{code}}});
  const identity=async(context:Context)=>{
    const actor=await options.authenticate(context);
    if(actor&&(typeof actor.binding!=='string'||!actor.binding||actor.binding.length>4096))throw Error('group_identity_invalid');return actor;
  };
  const query=(value:Readonly<Record<string,unknown>>,cursor:boolean)=>value&&!Array.isArray(value)&&typeof value.requestId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)&&Object.keys(value).length===(cursor?2:1)&&(!cursor||typeof value.cursor==='string'&&value.cursor.length>0&&value.cursor.length<=8192);
  return {
    async subscribe({query:q,context,target}:{query:Readonly<Record<string,unknown>>;context:Context;target:Target}):Promise<FeedResult>{
      if(!query(q,false)||typeof target?.resourceGroupId!=='string'||!target.resourceGroupId||target.resourceGroupId.length>4096)return error(400,'invalid_group_request');
      try{
        const actor=await identity(context);if(!actor)return error(401,'user_session_required');
        const position=await options.journal.barrier(()=>options.journal.subscribe(actor.binding,target));
        if(!position||Object.keys(position).sort().join(',')!=='cursor,epoch,sequence'||typeof position.epoch!=='string'||!position.epoch||position.epoch.length>128||typeof position.cursor!=='string'||!position.cursor||position.cursor.length>8192||typeof position.sequence!=='string'||!/^(0|[1-9][0-9]*)$/.test(position.sequence)||position.sequence.length>20||BigInt(position.sequence)>18446744073709551615n)throw Error('group_position_invalid');
        return {status:200,headers,body:{schemaVersion:2,kind:'resource_group',requestId:q.requestId,binding:actor.binding,resourceGroupId:target.resourceGroupId,position}};
      }catch(failure){return failure instanceof Error&&failure.message==='access_required'?error(403,'access_required'):error(503,'group_unavailable');}
    },
    async changes({query:q,context,target}:{query:Readonly<Record<string,unknown>>;context:Context;target:Target}):Promise<FeedResult>{
      if(!query(q,true)||typeof target?.resourceGroupId!=='string'||!target.resourceGroupId||target.resourceGroupId.length>4096)return error(400,'invalid_group_request');
      try{
        const actor=await identity(context);if(!actor)return error(401,'user_session_required');
        const result=await options.journal.barrier(()=>options.journal.read(actor.binding,target,q.cursor as string,100));
        // The producer also rejects Resource IDs/unknown event fields, not just the consumer.
        const b=result.batch;
        if(!b||Object.keys(b).sort().join(',')!=='binding,changes,epoch,fromSequence,nextCursor,resourceGroupId,throughSequence'||typeof result.hasMore!=='boolean'||b.binding!==actor.binding||b.resourceGroupId!==target.resourceGroupId||typeof b.epoch!=='string'||!b.epoch||b.epoch.length>128||typeof b.nextCursor!=='string'||!b.nextCursor||b.nextCursor.length>8192||!Array.isArray(b.changes)||b.changes.length>100||b.changes.some(e=>Object.keys(e).sort().join(',')!=='action,sequence'||!['revoke','revalidate'].includes(e.action)))throw Error('group_batch_invalid');
        let previous=BigInt(b.fromSequence);
        if(!/^(0|[1-9][0-9]*)$/.test(b.fromSequence)||!/^(0|[1-9][0-9]*)$/.test(b.throughSequence))throw Error('group_batch_invalid');
        for(const e of b.changes){previous++;if(String(previous)!==e.sequence)throw Error('group_batch_invalid');}
        if(String(previous)!==b.throughSequence||previous>18446744073709551615n)throw Error('group_batch_invalid');
        return {status:200,headers,body:{schemaVersion:2,kind:'resource_group',requestId:q.requestId,batch:b,hasMore:result.hasMore}};
      }catch(failure){return failure instanceof Error&&failure.message==='cursor_reset_required'?error(409,'reset_required'):error(503,'group_unavailable');}
    },
  };
}

/** Attach a trusted Group watermark inside the SAME ACL/journal barrier. No group-wide allow. */
export function createResourceGroupCheck<Context,Target>(options:{
  check(input:{query:Readonly<Record<string,unknown>>;context:Context;target:Target}):Promise<{status:number;headers:Readonly<{'Cache-Control':'no-store'}>;body:unknown}>;
  resolveGroup(target:Target):Promise<ResourceGroupTarget>;
  journal:ResourceGroupJournal<ResourceGroupTarget>;
}){
  return async(input:{query:Readonly<Record<string,unknown>>;context:Context;target:Target}):Promise<FeedResult>=>{
    try{return await options.journal.barrier(async()=>{
      const result=await options.check(input);if(result.status!==200)return result;
      const body=result.body as Record<string,unknown>;
      if(typeof body?.binding!=='string')throw Error('group_identity_invalid');
      const target=await options.resolveGroup(input.target),position=await options.journal.subscribe(body.binding,target);
      return {...result,headers:{'Cache-Control':'no-store' as const},body:{...body,resourceGroup:{resourceGroupId:target.resourceGroupId,epoch:position.epoch,sequence:position.sequence}}};
    });}catch{return {status:503,headers:{'Cache-Control':'no-store'},body:{error:{code:'group_check_unavailable'}}};}
  };
}
