import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSQLiteGroupStorage} from '../dist/group-sqlite.js';
import {fork} from 'node:child_process';
test('real SQLite shares atomic Group state, rolls back failed transactions, and survives reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'authz-group-')),path=join(dir,'groups.db');let first,second;
 try{first=new DatabaseSync(path);second=new DatabaseSync(path);const a=createSQLiteGroupStorage(first),b=createSQLiteGroupStorage(second);
  await a.transaction('k',()=>({row:{term:'1',owner:null,state:null},result:null}));
  await assert.rejects(a.transaction('k',row=>{row.term='99';throw Error('rollback');}),/rollback/);
  assert.equal((await b.read('k')).term,'1');assert.equal((await b.readMany(['k','missing']))[0].term,'1');
  first.close();first=new DatabaseSync(path);assert.equal((await createSQLiteGroupStorage(first).read('k')).term,'1');
 }finally{first?.close();second?.close();rmSync(dir,{recursive:true,force:true});}
});
test('independent real Node processes share SQLite denial and recover owner after crash without notification',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'authz-group-process-')),path=join(dir,'groups.db'),children=[];
 const start=()=>{const child=fork(new URL('./group-process-worker.mjs',import.meta.url),[path],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);let id=0;return {child,request(command){const requestId=++id;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.off('message',receive);reject(Error('worker timeout'));},15000);const receive=m=>{if(m.id!==requestId)return;clearTimeout(timeout);child.off('message',receive);m.ok?resolve(m.value):reject(Error(m.error));};child.on('message',receive);child.send({id:requestId,command});});}};};
 try{const a=start();await a.request('register');await a.request('grant');const b=start();await b.request('register');await b.request('guard');await a.request('revoke');await assert.rejects(b.request('guard'),/group_revalidation_required/);a.child.kill('SIGKILL');const next=await b.request('takeover');assert.equal(next.term,'2');await assert.rejects(b.request('guard'));await b.request('close');}
 finally{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}}rmSync(dir,{recursive:true,force:true});}
});
