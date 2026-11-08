import test from 'node:test';import assert from 'node:assert/strict';
import {createResourceGroupFeed} from '../dist/index.js';
test('Group feed authenticates, preserves former-subscriber revocation and rejects private Resource metadata',async()=>{
 let actor={binding:'b'},fail=false,privateEvent=false;
 const feed=createResourceGroupFeed({authenticate:async()=>actor,journal:{barrier:async run=>run(),subscribe:async()=>({epoch:'e',sequence:'0',cursor:'c'}),read:async(binding,target)=>{if(fail)throw Error('cursor_reset_required');return {hasMore:false,batch:{binding,resourceGroupId:target.resourceGroupId,epoch:'e',fromSequence:'0',throughSequence:'1',nextCursor:'d',changes:[{sequence:'1',action:'revoke',...(privateEvent?{resourceId:'private'}:{})}]}};}}});
 const target={resourceGroupId:'g'},input={target,context:{},query:{requestId:'n'}};
 assert.equal((await feed.subscribe(input)).body.schemaVersion,2);const changes={...input,query:{requestId:'n',cursor:'c'}};assert.equal((await feed.changes(changes)).status,200);
 privateEvent=true;assert.equal((await feed.changes(changes)).status,503);privateEvent=false;fail=true;assert.equal((await feed.changes(changes)).status,409);actor=null;const response=await feed.changes(changes);assert.equal(response.status,401);assert.equal(response.headers['Cache-Control'],'no-store');
 assert.equal((await feed.subscribe({...input,query:{requestId:'n',binding:'other'}})).status,400);
});
