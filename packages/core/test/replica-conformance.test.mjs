import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canPurgeReplica} from '../dist/replicas.js';
import {registerReplicaConformance} from '../testing/replica-conformance.mjs';
// A standalone external SQLite journal. No Yjs/framework/runtime dependency.
registerReplicaConformance({name:'external SQLite journal',createFixture:async()=>{
 const dir=mkdtempSync(join(tmpdir(),'authz-replica-contract-')),path=join(dir,'db');let db=new DatabaseSync(path);
 db.exec('CREATE TABLE authority(revision INTEGER,denied INTEGER); INSERT INTO authority VALUES(0,0); CREATE TABLE replicas(key TEXT PRIMARY KEY,principal TEXT,resource TEXT,flags TEXT);');
 const clean={pendingWrites:false,inFlight:false,conflicts:false,holds:false,unresolvedSources:false,contentChanged:false};
 for(const [key,principal,resource] of [['generation-1','actor','target'],['generation-2','actor','target'],['other-principal','other','target'],['other-resource','actor','other']])db.prepare('INSERT INTO replicas VALUES(?,?,?,?)').run(key,principal,resource,JSON.stringify(clean));
 const authority=()=>db.prepare('SELECT * FROM authority').get();
 const f={
  deny:async()=>{db.exec('UPDATE authority SET denied=1,revision=revision+1');return String(authority().revision);},
  grant:async()=>{db.exec('UPDATE authority SET denied=0,revision=revision+1');},
  purge:async revision=>{
   db.exec('BEGIN IMMEDIATE');try{
    const state=authority();if(String(state.revision)!==revision)throw Error('revision_conflict');if(!state.denied)throw Error('purge_not_denied');
    const rows=db.prepare("SELECT * FROM replicas WHERE principal='actor' AND resource='target' ORDER BY key").all();
    if(rows.some(row=>!canPurgeReplica(JSON.parse(row.flags)))){db.exec('COMMIT');return {status:'blocked'};}
    for(const row of rows)db.prepare('DELETE FROM replicas WHERE key=?').run(row.key);db.exec('COMMIT');return {status:'purged'};
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  read:async()=>{if(authority().denied)throw Error('read_denied');return 'body';},
  delayedWrite:async()=>{if(authority().denied||authority().revision!==0)throw Error('write_denied');},
  inventory:async()=>db.prepare('SELECT key FROM replicas ORDER BY key').all().map(row=>row.key),
  isDenied:async()=>Boolean(authority().denied),
  markDirty:async kind=>{db.prepare("UPDATE replicas SET flags=? WHERE key='generation-2'").run(JSON.stringify({...clean,[kind]:true}));},
  failDeletion:async on=>db.exec(on?"CREATE TRIGGER fail_delete BEFORE DELETE ON replicas WHEN OLD.key='generation-2' BEGIN SELECT RAISE(ABORT,'disk_failure'); END":"DROP TRIGGER fail_delete"),
  reopen:async()=>{db.close();db=new DatabaseSync(path);},close:async()=>{db.close();rmSync(dir,{recursive:true,force:true});},
 };return f;
}});
