import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
const cases = JSON.parse(readFileSync('fixtures/conformance.json','utf8'));
const browser = await chromium.launch({...(process.env.AUTHZFLOW_BUNDLED_BROWSER==='1'?{}:{channel:'chrome'}),headless:true});
try {
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://authzflow.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if(path==='/') return route.fulfill({contentType:'text/html',body:'<!doctype html><title>AuthzFlow conformance</title><output id="result">Running</output>'});
    const files={
      '/dist/resource-authority-driver.js':'packages/core/dist/resource-authority-driver.js',
      '/dist/resource-change-tracker-driver.js':'packages/core/dist/resource-change-tracker-driver.js',
      '/dist/resource-authority.js':'packages/core/dist/resource-authority.js',
      '/dist/resource-change-tracker.js':'packages/core/dist/resource-change-tracker.js',
      '/wasm/authzflow_wasm.js':'packages/core/wasm/authzflow_wasm.js',
      '/wasm/authzflow_wasm_bg.wasm':'packages/core/wasm/authzflow_wasm_bg.wasm',
      '/dist/content-hash.js':'packages/core/dist/content-hash.js',
      '/dist/runtime-driver.js':'packages/core/dist/runtime-driver.js',
      '/dist/index.js':'packages/core/dist/index.js',
      '/dist/checked-reader.js':'packages/core/dist/checked-reader.js',
      '/dist/checked-reader-protocol.js':'packages/core/dist/checked-reader-protocol.js',
      '/dist/change-consumer.js':'packages/core/dist/change-consumer.js'
    };
    if(!files[path]) return route.fulfill({status:404,body:'not found'});
    await route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:readFileSync(resolve(files[path]))});
  });
  await page.goto('https://authzflow.test/');
  const result = await page.evaluate(async cases => {
    const sdk=await import('/dist/index.js');
    const state=cases[0].request.state;
    let badInit=false;
    try { await sdk.createRuntime({checkpoint:state,clock:()=>({boot:'boot',now_ms:50}),commit:async p=>p.next.revision,wasmBytes:new Uint8Array([0])}); }
    catch { badInit=true; }
    const wasm=await import('/wasm/authzflow_wasm.js'); await wasm.default();
    const results=cases.map(c=>{try{return {name:c.name,actual:JSON.parse(wasm.dispatch(JSON.stringify(c.request)))}}catch(e){return {name:c.name,error:String(e)}}});
    const invalidated=[];
    const rt=await sdk.createRuntime({checkpoint:state,clock:()=>({boot:'boot',now_ms:50}),commit:async p=>p.next.revision,onInvalidate:ids=>invalidated.push(...ids)});
    let precheck=false;try{await rt.get('article',async()=>'secret')}catch{precheck=true}
    await rt.applySnapshot(state); const content=await rt.get('article',async()=>'content');
    await rt.applyChanges({binding:state.binding,epoch:state.epoch,from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]});let blocked=false;try{await rt.get('article',async()=>'secret')}catch{blocked=true}
    let saved=null,now=100,wall=1000,network=true,allow=true;
    const reader=await sdk.createCheckedReader({binding:'browser/user',resourceId:'article',scopeId:'workspace',
      session:async()=>({binding:'browser/user',context:'session',expiresAtMs:1000000}),clock:()=>({boot:'browser',now_ms:now,wall_ms:wall}),
      storage:{load:async()=>structuredClone(saved),commit:async plan=>{if(plan.expected_revision!==(saved?.revision??'0'))throw Error('cas_conflict');saved=structuredClone(plan.next);return saved.revision;}},
      check:async({requestId})=>{if(!network)throw new TypeError('network unavailable');return {status:allow?200:403,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'browser/user',resourceId:'article',scopeId:'workspace',contentHash:'a'.repeat(64),epoch:'browser-epoch',leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000}})};},
      read:async()=>'content',contentHash:async()=>'a'.repeat(64),
    });
    let checkedOffline=false,checkedExpired=false,checkedDenied=false;
    try {
      const first=await reader.readWithPermit();if(first.validForMs!==1000||first.expiresAtMs!==2000)throw Error('display_permit_invalid');
      network=false;now+=999;wall+=999;const offline=await reader.readWithPermit();checkedOffline=offline.value==='content'&&offline.validForMs===1&&offline.expiresAtMs===first.expiresAtMs;now++;wall++;
      try{await reader.read();}catch{checkedExpired=true;}
      network=true;allow=false;try{await reader.read();}catch{checkedDenied=saved.resources.article.access==='deny';}
    }finally{reader.close();}
    let changeDenied=false;
    const stream=await sdk.createRuntime({checkpoint:state,clock:()=>({boot:'boot',now_ms:50}),commit:async p=>p.next.revision});
    try{
      await stream.applySnapshot(state);
      const receiver=sdk.createChangeConsumer({runtime:stream,fetchChanges:async({requestId})=>({status:200,json:async()=>({schemaVersion:1,requestId,batch:{binding:state.binding,epoch:state.epoch,from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]},hasMore:false})}),purge:async(ids,revision)=>{if(ids.join(',')!=='article'||stream.snapshot().revision!==revision||stream.snapshot().cursor!=='cursor-2')throw Error('browser_change_commit_invalid');try{await stream.get('article',async()=>'secret');}catch{changeDenied=true;}}});
      await receiver.catchUp();
    }finally{stream.close();}
    let coordinated=false;const authorityRows=new Map(),input={binding:'browser/user',resourceId:'article',scopeId:'workspace',content:'content'};
    const host=sdk.createResourceAuthority({pollIntervalMs:0,
      session:async()=>({binding:'browser/user',context:'session',expiresAtMs:1000000}),clock:()=>({boot:'browser',now_ms:now,wall_ms:wall}),hash:async()=> 'a'.repeat(64),
      storage:{load:async(kind,id)=>authorityRows.get(kind+id)??null,commit:async(kind,id,plan)=>{if(plan.expected_revision!==(authorityRows.get(kind+id)?.revision??'0'))throw Error('cas_conflict');authorityRows.set(kind+id,structuredClone(plan.next));return plan.next.revision;}},
      check:async(_input,requestId)=>{if(!network)throw new TypeError('offline');return {status:allow?200:403,json:async()=>({schemaVersion:1,mode:'check_only',requestId,binding:'browser/user',resourceId:'article',scopeId:'workspace',epoch:'e',contentHash:'a'.repeat(64),leaseMs:5000,readPolicy:{mode:'offline_ttl',maxOfflineMs:1000}})};},
    });
    try{allow=true;const states=[];const unsubscribe=host.subscribe(input,state=>states.push(state));const full=await host.revalidate(input);network=false;now+=100;wall+=100;const cached=await host.readCachedWithPermit(input);coordinated=cached.allowed&&cached.expiresAt===full.expiresAt&&cached.validForMs===900&&host.getState(input).phase==='allowed';
      let strictDenied=false;try{await host.revalidate(input);}catch{strictDenied=true;}
      network=true;await host.revalidate(input);coordinated=coordinated&&strictDenied&&states.some(state=>state.phase==='checking')&&host.getState(input).mode==='online';unsubscribe();}
    finally{host.close();}
    document.querySelector('#result').textContent=`${results.length} Native/Wasm fixtures; SDK revoke: ${blocked?'blocked':'FAILED'}`;
    const {createContentHasher}=await import('/dist/content-hash.js');
    const contentHash=await createContentHasher({serialize:value=>JSON.stringify([value.title,value.body]),digest:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')})({title:'日本語',body:['One','Two']});
    return {coordinated,contentHash,badInit,results,precheck,content,blocked,invalidated,checkedOffline,checkedExpired,checkedDenied,changeDenied};
  },cases);
  assert.equal(result.contentHash,createHash('sha256').update('["日本語",["One","Two"]]').digest('hex'));
  assert.equal(result.coordinated,true);
  assert.equal(result.badInit,true,'invalid Wasm initialization must reject');
  for(let i=0;i<cases.length;i++) {
    const c=cases[i],actual=result.results[i];
    if(c.error) assert.equal(actual.error,c.error,c.name);
    else assert.deepEqual(actual.actual,c.expected,c.name);
  }
  assert.equal(result.precheck,true);assert.equal(result.content,'content');assert.equal(result.blocked,true);
  assert.ok(result.invalidated.includes('article'));assert.deepEqual(errors,[]);
  assert.equal(result.changeDenied,true);
  assert.equal(result.checkedOffline,true);assert.equal(result.checkedExpired,true);assert.equal(result.checkedDenied,true);
  mkdirSync('test-results',{recursive:true});
  writeFileSync('test-results/browser-parity.json',JSON.stringify(result,null,2));
  await page.screenshot({path:'test-results/browser-parity.png'});
  console.log(`PASS: ${cases.length} browser Wasm fixtures match Native expectations; real SDK initialization and revocation passed`);
} finally { await browser.close(); await import("./storage-browser.mjs"); }
