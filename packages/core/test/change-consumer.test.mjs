import test from 'node:test';
import assert from 'node:assert/strict';
import {createChangeConsumer} from '../dist/change-consumer.js';
// change consumer tests: commit deny/cursor before purge, replay and reset.
test('invalid responses fence the runtime before commit or purge', async () => {
  for (const mutation of [b=>b.requestId='old',b=>b.batch.binding='other',b=>b.batch.epoch='old',b=>b.batch.from_sequence='0',b=>b.batch.changes[0].sequence='3',b=>b.hasMore='yes']) {
    let closed=false,commits=0;
    const runtime={snapshot:()=>({binding:'b',epoch:'e',sequence:'1',revision:'1',cursor:'c1',resources:{},scopes:{}}),close(){closed=true;},async applyChanges(){commits++;}};
    const consumer=createChangeConsumer({runtime,purge:async()=>assert.fail('purge before validation'),fetchChanges:async({requestId})=>({status:200,json:async()=>{
      const body={schemaVersion:1,requestId,batch:{binding:'b',epoch:'e',from_sequence:'1',through_sequence:'2',next_cursor:'c2',changes:[{sequence:'2',target:{kind:'scope',id:'s'},action:'revoke'}]},hasMore:false};
      mutation(body);return body;
    }})});
    await assert.rejects(consumer.catchUp(),/authz_changes_invalid/);assert.equal(commits,0);assert.equal(closed,true);
  }
});
test('pending purge retries before fetching and failure keeps durable deny', async()=>{
  let fetches=0,closed=false;
  const runtime={snapshot:()=>({binding:'b',epoch:'e',sequence:'2',revision:'2',cursor:'c2',resources:{a:{access:'deny',scopes:[]}},scopes:{}}),close(){closed=true;}};
  const consumer=createChangeConsumer({runtime,purge:async(ids,revision)=>{assert.deepEqual(ids,['a']);assert.equal(revision,'2');throw Error('disk_full');},fetchChanges:async()=>{fetches++;throw Error('should_not_fetch');}});
  await assert.rejects(consumer.catchUp(),/disk_full/);assert.equal(fetches,0);assert.equal(closed,false);
});
test('pages resume only from committed cursor and network failure preserves bounded host permit', async()=>{
  let state={binding:'b',epoch:'e',sequence:'0',revision:'0',cursor:'c0',resources:{},scopes:{}},fetches=0,closed=false;
  const runtime={snapshot:()=>structuredClone(state),close(){closed=true;},async applyChanges(batch){state.sequence=batch.through_sequence;state.cursor=batch.next_cursor;state.revision=String(Number(state.revision)+1);}};
  const consumer=createChangeConsumer({runtime,purge:async()=>{},fetchChanges:async({requestId,cursor})=>{
    assert.equal(cursor,'c'+fetches);fetches++;const n=fetches;
    return {status:200,json:async()=>({schemaVersion:1,requestId,batch:{binding:'b',epoch:'e',from_sequence:String(n-1),through_sequence:String(n),next_cursor:'c'+n,changes:[{sequence:String(n),target:{kind:'scope',id:'s'},action:'revalidate'}]},hasMore:n===1})};
  }});
  await consumer.catchUp();assert.equal(fetches,2);assert.equal(state.cursor,'c2');assert.equal(closed,false);
  const offline=createChangeConsumer({runtime,purge:async()=>{},fetchChanges:async()=>{throw new TypeError('offline');}});
  await assert.rejects(offline.catchUp(),TypeError);assert.equal(closed,false);
});
test('commit_before_purge', async () => {
  let state = {
    binding: 'b',
    epoch: 'e',
    sequence: '1',
    revision: '1',
    cursor: 'c1',
    phase: 'ready',
    resources: { a: { access: 'allow', scopes: ['s'] } },
    scopes: { s: { access: 'allow' } }
  };
  const order = [];
  const runtime = {
    snapshot: () => structuredClone(state),
    close: () => order.push('close'),
    applyChanges: async (batch) => {
      assert.equal(batch.from_sequence, '1');
      state.sequence = '2';
      state.cursor = 'c2';
      state.revision = '2';
      state.scopes.s.access = 'deny';
      order.push('commit');
    }
  };
  const consumer = createChangeConsumer({
    runtime,
    fetchChanges: async ({ requestId, cursor }) => {
      assert.equal(cursor, 'c1');
      return {
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          requestId,
          batch: {
            binding: 'b',
            epoch: 'e',
            from_sequence: '1',
            through_sequence: '2',
            next_cursor: 'c2',
            changes: [{ sequence: '2', target: { kind: 'scope', id: 's' }, action: 'revoke' }]
          },
          hasMore: false
        })
      };
    },
    purge: async (ids, revision) => {
      assert.deepEqual(ids, ['a']);
      assert.equal(revision, '2');
      assert.equal(state.cursor, 'c2');
      order.push('purge');
    }
  });
  await consumer.catchUp();
  assert.deepEqual(order, ['commit', 'purge']);
});

test('real Wasm commits scope revoke before host deletion and keeps denial after purge error',async()=>{
  const {createRuntime}=await import('../dist/index.js');
  const {readFile}=await import('node:fs/promises');
  const checkpoint=JSON.parse(await readFile(new URL('../../../fixtures/ready.json',import.meta.url),'utf8'));
  const wasmBytes=new Uint8Array(await readFile(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
  let saved,attempts=0;
  const runtime=await createRuntime({checkpoint,wasmBytes,clock:()=>({boot:'boot',now_ms:50}),commit:async plan=>{saved=structuredClone(plan.next);return saved.revision;}});
  try{
    await runtime.applySnapshot(checkpoint);
    const consumer=createChangeConsumer({runtime,fetchChanges:async({requestId,cursor})=>({status:200,json:async()=>({schemaVersion:1,requestId,batch:{binding:'actor',epoch:'epoch',from_sequence:'1',through_sequence:'2',next_cursor:'cursor-2',changes:[{sequence:'2',target:{kind:'scope',id:'scope'},action:'revoke'}]},hasMore:false})}),purge:async(ids,revision)=>{
      assert.deepEqual(ids,['article']);assert.equal(saved.cursor,'cursor-2');assert.equal(saved.revision,revision);assert.equal(saved.scopes.scope.access,'deny');attempts++;throw Error('purge_unavailable');
    }});
    await assert.rejects(consumer.catchUp(),/purge_unavailable/);
    await assert.rejects(runtime.get('article',async()=>assert.fail('revoked body read')));
    await assert.rejects(consumer.catchUp(),/purge_unavailable/);assert.equal(attempts,2);
  }finally{runtime.close();}
});
test('structured blocked purge cannot advance catch-up and retries durable denial',async()=>{
 let blocked=true,fetches=0,purges=0;
 const state={binding:'b',epoch:'e',sequence:'1',revision:'2',cursor:'c1',resources:{a:{access:'deny',scopes:[]}},scopes:{}};
 const runtime={snapshot:()=>structuredClone(state),close(){assert.fail('blocking preserves durable runtime');},applyChanges:async()=>{}};
 const consumer=createChangeConsumer({runtime,purge:async()=>{purges++;return {status:blocked?'blocked':'purged'};},fetchChanges:async({requestId})=>{fetches++;return {status:200,json:async()=>({schemaVersion:1,requestId,hasMore:false,batch:{binding:'b',epoch:'e',from_sequence:'1',through_sequence:'1',next_cursor:'c1',changes:[]}})};}});
 await assert.rejects(consumer.catchUp(),/authz_purge_blocked/);assert.equal(fetches,0);assert.equal(state.resources.a.access,'deny');
 blocked=false;await consumer.catchUp();assert.equal(fetches,1);assert.equal(purges,3);
});
test('malformed purge completion fails closed',async()=>{
 const runtime={snapshot:()=>({resources:{a:{access:'deny',scopes:[]}},scopes:{},revision:'1'}),close(){}};
 const consumer=createChangeConsumer({runtime,purge:async()=>({status:'unknown'}),fetchChanges:async()=>{assert.fail('invalid completion must not fetch');}});
 await assert.rejects(consumer.catchUp(),/authz_purge_result_invalid/);
});
