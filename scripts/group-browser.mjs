import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('packages/core');
let sequence=0;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext();
 await context.route('https://authzflow.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Group contract</title>'});return;}
  if(url.pathname==='/subscribe'||url.pathname==='/changes'){
   const group={binding:'actor',resourceGroupId:'group'},requestId=url.searchParams.get('requestId'),cursor=url.searchParams.get('cursor')??'0';
   const response=url.pathname==='/subscribe'?{schemaVersion:2,kind:'resource_group',requestId,...group,position:{epoch:'e',sequence:String(sequence),cursor:String(sequence)}}:{schemaVersion:2,kind:'resource_group',requestId,hasMore:false,batch:{...group,epoch:'e',fromSequence:cursor,throughSequence:String(sequence),nextCursor:String(sequence),changes:sequence>Number(cursor)?[{sequence:String(sequence),action:'revoke'}]:[]}};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});return;
  }
  const file=resolve(root,url.pathname.replace(/^\/core\//,''));
  if(relative(root,file).startsWith('..'))throw Error('test_path_invalid');
  await route.fulfill({contentType:file.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(file)});
 });
 const pages=await Promise.all([context.newPage(),context.newPage()]);
 for(const page of pages){await page.goto('https://authzflow.test/');await page.evaluate(async()=>{
  const {createResourceGroupCoordinator}=await import('/core/dist/resource-group.js');
  const {createIndexedDBGroupStorage}=await import('/core/dist/group-indexeddb.js');
  const {createGroupNotificationPort}=await import('/core/dist/group-notifications.js');
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('group-contract',1);r.onupgradeneeded=()=>r.result.createObjectStore('groups');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  let pulls=0;
  const group={binding:'actor',resourceGroupId:'group'},storage=createIndexedDBGroupStorage(db,'groups'),channel=new BroadcastChannel('group-contract');
  const c=await createResourceGroupCoordinator({namespace:'browser-contract',storage,wall:()=>Date.now(),session:async()=>({binding:'actor',context:'session',expiresAtMs:Date.now()+60000}),randomUUID:()=>crypto.randomUUID(),pollIntervalMs:0,
   ...createGroupNotificationPort(channel),purge:async()=>({status:'blocked'}),transport:{
    subscribe:async(g,requestId)=>fetch('/subscribe?requestId='+requestId),
    fetch:async(g,{requestId,cursor})=>{pulls++;return fetch('/changes?requestId='+requestId+'&cursor='+cursor);},
   }});
  const input={...group,resourceId:'article'};await c.register(input);globalThis.groupTest={c,group,input,storage,db,channel,pulls:()=>pulls};
 });}
 await pages[0].evaluate(async()=>{const t=globalThis.groupTest;await t.c.granted(t.input,{resourceGroupId:'group',epoch:'e',sequence:'0'});t.stamp=await t.c.stamp(t.group);});
 await pages[1].evaluate(async()=>{const t=globalThis.groupTest;t.stamp=await t.c.stamp(t.group);await t.c.guard(t.input,t.stamp);});
 const before=await pages[1].evaluate(()=>globalThis.groupTest.pulls());await pages[1].evaluate(()=>globalThis.groupTest.c.catchUp());
 assert.equal(await pages[1].evaluate(()=>globalThis.groupTest.pulls()),before);
 sequence++;await pages[0].evaluate(()=>globalThis.groupTest.c.catchUp());
 const denied=await pages[1].evaluate(async()=>{const t=globalThis.groupTest;try{await t.c.guard(t.input,t.stamp);return false;}catch{return true;}});assert.equal(denied,true);
 // Closing the owner releases only its own term; the second tab takes over the same checkpoint.
 await pages[0].evaluate(()=>globalThis.groupTest.c.close());await pages[1].evaluate(()=>globalThis.groupTest.c.catchUp());
 assert.ok(await pages[1].evaluate(()=>globalThis.groupTest.pulls())>before);
 for(const page of pages)await page.evaluate(async()=>{const t=globalThis.groupTest;await t.c.close();t.channel.close();t.db.close();});
 console.log('PASS: real Chrome two-tab IndexedDB/Wasm owner sharing, revoke and takeover (3 cases)');
 await context.close();
}finally{await browser.close();}
