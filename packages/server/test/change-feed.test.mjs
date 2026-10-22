import test from 'node:test';
import assert from 'node:assert/strict';
import {createChangeFeed} from '../dist/change-feed.js';
// change feed tests: authenticated snapshot barrier and resumed batches.
test('changes authenticate cursors and sanitize resets and host failures',async()=>{
  let identity={binding:'b'},reads=0,fail;
  const batch={binding:'b',epoch:'e',from_sequence:'1',through_sequence:'2',next_cursor:'opaque-2',changes:[{sequence:'2',target:{kind:'scope',id:'s'},action:'revoke'}]};
  const feed=createChangeFeed({authenticate:async()=>identity,check:async()=>{throw Error('unused');},journal:{barrier:fn=>fn(),subscribe:async()=>{throw Error('unused');},read:async(binding,target,cursor,limit)=>{
    reads++;assert.equal(binding,'b');assert.equal(target,'t');assert.equal(cursor,'opaque-1');assert.equal(limit,100);if(fail)throw Error(fail);return {batch,hasMore:false};
  }}});
  const call=query=>feed.changes({context:{},target:'t',query});
  for(const query of [{requestId:'n'},{requestId:'n',cursor:'opaque-1',binding:'other'},{requestId:'',cursor:'opaque-1'}])assert.equal((await call(query)).status,400);
  assert.equal(reads,0);identity=null;assert.equal((await call({requestId:'n',cursor:'opaque-1'})).status,401);assert.equal(reads,0);
  identity={binding:'b'};const success=await call({requestId:'n',cursor:'opaque-1'});assert.deepEqual(success.body,{schemaVersion:1,requestId:'n',batch,hasMore:false});
  for(const [message,status,code] of [['cursor_reset_required',409,'reset_required'],['private backend credential',503,'authz_changes_unavailable']]){
    fail=message;const result=await call({requestId:'n',cursor:'opaque-1'});assert.equal(result.status,status);assert.deepEqual(result.body,{error:{code}});assert.equal(result.headers['Cache-Control'],'no-store');
  }
});

test('snapshot_barrier', async (t) => {
  const order = [];
  const feed = createChangeFeed({
    authenticate: async () => ({ binding: 'b' }),
    check: async () => {
      order.push('check');
      return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { binding: 'b' } };
    },
    journal: {
      barrier: async fn => {
        order.push('enter');
        const r = await fn();
        order.push('exit');
        return r;
      },
      subscribe: async (binding, target) => {
        assert.equal(binding, 'b');
        assert.equal(target, 't');
        order.push('subscribe');
        return { epoch: 'e', sequence: '2', cursor: 'opaque-2' };
      },
      read: async () => {
        throw Error('unexpected_read');
      }
    }
  });
  const result = await feed.snapshot({ query: { requestId: 'nonce' }, context: {}, target: 't' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { binding: 'b', stream: { epoch: 'e', sequence: '2', cursor: 'opaque-2' } });
  assert.deepEqual(order, ['enter', 'check', 'subscribe', 'exit']);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

