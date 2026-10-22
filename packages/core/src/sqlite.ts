import type {CacheStorage} from './cache.js';
import type {Checkpoint} from './index.js';
export interface SQLiteDatabase {exec(sql:string):unknown;prepare(sql:string):{get(...params:any[]):any;all(...params:any[]):any[];run(...params:any[]):unknown}}
/** Host owns SQLite connection and encryption codec. No native build dependency. */
export function createSQLiteStorage(db:SQLiteDatabase,codec:{seal(value:Uint8Array,aad:string):Uint8Array;open(value:Uint8Array,aad:string):Uint8Array}):CacheStorage{
 db.exec(`CREATE TABLE IF NOT EXISTS authz_checkpoints(binding TEXT PRIMARY KEY,revision TEXT NOT NULL,payload BLOB NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS authz_bodies(binding TEXT NOT NULL,resource TEXT NOT NULL,stamp TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(binding,resource)) STRICT;
 PRAGMA busy_timeout=5000;`);
 let closed=false;
 const ensure=()=>{if(closed)throw Error('cache_storage_closed');};
 const load=(binding:string):Checkpoint|null=>{
  ensure();const row=db.prepare('SELECT revision,payload FROM authz_checkpoints WHERE binding=?').get(binding);if(!row)return null;
  const value=JSON.parse(new TextDecoder().decode(codec.open(new Uint8Array(row.payload),JSON.stringify(['checkpoint',binding,row.revision])))) as Checkpoint;
  if(value.binding!==binding||value.revision!==row.revision)throw Error('cache_checkpoint_corrupt');return value;
 };
 const transact=<T>(run:()=>T):T=>{ensure();db.exec('BEGIN IMMEDIATE');try{const result=run();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
 const current=(binding:string,revision:string)=>{const state=load(binding);if(!state||state.revision!==revision)throw Error('cache_revision_conflict');return state;};
 const stamp=(state:Checkpoint,resource:string)=>JSON.stringify([state.epoch,state.resources[resource],state.resources[resource]?.scopes.map(id=>[id,state.scopes[id]])]);
 return {
  async load(binding){return load(binding);},
  async commit(plan){
   ensure();const next=structuredClone(plan.next),bytes=new TextEncoder().encode(JSON.stringify(next));
   if(bytes.byteLength>1024*1024)throw Error('cache_checkpoint_too_large');
   return transact(()=>{
    if((load(next.binding)?.revision??'0')!==plan.expected_revision)throw Error('cache_revision_conflict');
    const sealed=codec.seal(bytes,JSON.stringify(['checkpoint',next.binding,next.revision]));
    db.prepare('INSERT OR REPLACE INTO authz_checkpoints VALUES(?,?,?)').run(next.binding,next.revision,sealed);return next.revision;
   });
  },
  async read(binding,resource){
   const state=load(binding),row=db.prepare('SELECT stamp,payload FROM authz_bodies WHERE binding=? AND resource=?').get(binding,resource);
   if(!row||!state||row.stamp!==stamp(state,resource))return null;
   return new Uint8Array(codec.open(new Uint8Array(row.payload),JSON.stringify(['body',binding,resource,row.stamp])));
  },
  async put(binding,resource,value,revision){
   ensure();if(!(value instanceof Uint8Array)||value.byteLength>4*1024*1024)throw Error('cache_value_invalid');const copy=new Uint8Array(value);
   transact(()=>{
    const state=current(binding,revision),e=state.resources[resource];
    if(state.phase!=='ready'||!Object.hasOwn(state.resources,resource)||!e||e.access!=='allow'||e.stale||e.scopes.some(id=>!state.scopes[id]||state.scopes[id]!.access!=='allow'||state.scopes[id]!.stale))throw Error('cache_write_denied');
    const identity=stamp(state,resource),sealed=codec.seal(copy,JSON.stringify(['body',binding,resource,identity]));
    db.prepare('INSERT OR REPLACE INTO authz_bodies VALUES(?,?,?,?)').run(binding,resource,identity,sealed);
   });
  },
  async purge(binding,resources,revision){
   const ids=[...resources];transact(()=>{
    const state=current(binding,revision);
    for(const id of ids){const e=state.resources[id];if(!Object.hasOwn(state.resources,id)||!e||!(e.access==='deny'||e.scopes.some(scope=>state.scopes[scope]?.access==='deny')))throw Error('cache_purge_not_denied');}
    for(const id of ids)db.prepare('DELETE FROM authz_bodies WHERE binding=? AND resource=?').run(binding,id);
   });
  },
  close(){closed=true;},
 };
}
