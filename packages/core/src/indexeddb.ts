import type {CacheStorage} from './cache.js';
import type {Checkpoint} from './index.js';
/** Separate database name per isolated profile; host owns encryption keys. */
export async function openIndexedDBStorage(name:string,codec:{seal(value:Uint8Array,aad:string):Uint8Array;open(value:Uint8Array,aad:string):Uint8Array},factory:IDBFactory=globalThis.indexedDB):Promise<CacheStorage>{
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('checkpoints');
      request.result.createObjectStore('bodies');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('cache_storage_blocked'));
  });
  let closed = false;
  db.onversionchange = () => { closed = true; db.close(); };
  function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function run<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    if (closed) throw Error('cache_storage_closed');
    const tx = db.transaction(['checkpoints', 'bodies'], mode, {durability: 'strict'});
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? Error('cache_transaction_aborted'));
    });
    try {
      const value = await work(tx);
      await done;
      return value;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  function decode(binding: string, row: any): Checkpoint | null {
    if (!row) return null;
    const cp = JSON.parse(new TextDecoder().decode(codec.open(new Uint8Array(row.payload), JSON.stringify(['checkpoint', binding, row.revision]))));
    if (cp.binding !== binding || cp.revision !== row.revision) throw Error('cache_checkpoint_corrupt');
    return cp;
  }
  function stamp(state: Checkpoint, resource: string): string {
    return JSON.stringify([state.epoch, state.resources[resource], state.resources[resource]?.scopes.map(id => [id, state.scopes[id]])]);
  }
  function close() { closed = true; db.close(); }
  return {
  async load(binding){return run("readonly",async tx=>decode(binding,await req(tx.objectStore("checkpoints").get(binding))));},
  async commit(plan){const next=structuredClone(plan.next),bytes=new TextEncoder().encode(JSON.stringify(next));if(bytes.byteLength>1048576)throw Error("cache_checkpoint_too_large");return run("readwrite",async tx=>{const store=tx.objectStore("checkpoints");const saved=decode(next.binding,await req(store.get(next.binding)));if((saved?.revision??"0")!==plan.expected_revision)throw Error("cache_revision_conflict");const payload=codec.seal(bytes,JSON.stringify(["checkpoint",next.binding,next.revision]));await req(store.put({revision:next.revision,payload},next.binding));return next.revision;});},
  async read(binding,resource){return run("readonly",async tx=>{const state=decode(binding,await req(tx.objectStore("checkpoints").get(binding)));const row=await req(tx.objectStore("bodies").get(JSON.stringify([binding,resource])));if(!state||!row||row.stamp!==stamp(state,resource))return null;return new Uint8Array(codec.open(new Uint8Array(row.payload),JSON.stringify(["body",binding,resource,row.stamp])));});},
  async put(binding,resource,value,expectedRevision){if(!(value instanceof Uint8Array)||value.byteLength>4194304)throw Error('cache_value_invalid');const copy=new Uint8Array(value);await run("readwrite",async tx=>{const state=decode(binding,await req(tx.objectStore("checkpoints").get(binding)));if(!state||state.revision!==expectedRevision)throw Error('cache_revision_conflict');const e=state.resources[resource];if(state.phase!=="ready"||!Object.hasOwn(state.resources,resource)||!e||e.access!=="allow"||e.stale||e.scopes.some(id=>!state.scopes[id]||state.scopes[id]!.access!=="allow"||state.scopes[id]!.stale))throw Error('cache_write_denied');const identity=stamp(state,resource);await req(tx.objectStore("bodies").put({stamp:identity,payload:codec.seal(copy,JSON.stringify(["body",binding,resource,identity]))},JSON.stringify([binding,resource])));});},
  async purge(binding,resources,expectedRevision){const ids=[...resources];await run("readwrite",async tx=>{const state=decode(binding,await req(tx.objectStore("checkpoints").get(binding)));if(!state||state.revision!==expectedRevision)throw Error('cache_revision_conflict');for(const id of ids){const e=state.resources[id];if(!Object.hasOwn(state.resources,id)||!e||!(e.access==="deny"||e.scopes.some(scope=>state.scopes[scope]?.access==="deny")))throw Error('cache_purge_not_denied');}for(const id of ids)await req(tx.objectStore("bodies").delete(JSON.stringify([binding,id])));});},
  close,
 };
}
