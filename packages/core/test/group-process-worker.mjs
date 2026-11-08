import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {createSQLiteGroupStorage} from '../dist/group-sqlite.js';import {createResourceGroupCoordinator} from '../dist/resource-group.js';
const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE IF NOT EXISTS group_events(sequence INTEGER PRIMARY KEY,action TEXT NOT NULL) STRICT;');
let wall=1000,stamp;const group={binding:'process-actor',resourceGroupId:'process-group'},input={...group,resourceId:'article'};
const position=()=>{const seq=db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM group_events').get().n;return {epoch:'e',sequence:String(seq),cursor:String(seq)};};
const c=await createResourceGroupCoordinator({namespace:'process-contract',storage:createSQLiteGroupStorage(db),wall:()=>wall,session:async()=>({binding:group.binding,context:'c',expiresAtMs:100000}),randomUUID:()=>crypto.randomUUID(),pollIntervalMs:0,
wasmBytes:new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url))),purge:async()=>({status:'blocked'}),transport:{
 subscribe:async(g,requestId)=>({status:200,json:async()=>({schemaVersion:2,kind:'resource_group',requestId,...g,position:position()})}),
 fetch:async(g,{requestId,cursor})=>({status:200,json:async()=>({schemaVersion:2,kind:'resource_group',requestId,hasMore:false,batch:{...g,epoch:'e',fromSequence:cursor,throughSequence:position().sequence,nextCursor:position().cursor,changes:db.prepare('SELECT sequence,action FROM group_events WHERE sequence>? ORDER BY sequence').all(Number(cursor)).map(row=>({sequence:String(row.sequence),action:row.action}))}})}),
}});
let tail=Promise.resolve();process.on('message',message=>{tail=tail.then(async()=>{try{
 let value;
 if(message.command==='register'){await c.register(input);stamp=await c.stamp(input);value=stamp;}
 else if(message.command==='grant'){await c.granted(input,{resourceGroupId:group.resourceGroupId,epoch:'e',sequence:position().sequence});stamp=await c.stamp(input);value=stamp;}
 else if(message.command==='revoke'){db.prepare('INSERT INTO group_events VALUES(?,?)').run(Number(position().sequence)+1,'revoke');await c.catchUp();value=true;}
 else if(message.command==='guard'){await c.guard(input,stamp);value=true;}
 else if(message.command==='takeover'){wall=20000;await c.catchUp();value=await c.stamp(input);}
 else if(message.command==='close'){await c.close();db.close();value=true;}
 process.send({id:message.id,ok:true,value});
 }catch(error){process.send({id:message.id,ok:false,error:error.message});}});});
