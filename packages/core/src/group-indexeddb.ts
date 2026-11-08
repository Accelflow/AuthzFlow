import type {GroupCoordinationStorage, GroupRow} from './resource-group-driver.js';

/** Pass the product's DB/store to share the transaction boundary with product replicas. */
export function createIndexedDBGroupStorage(db: IDBDatabase, storeName: string): GroupCoordinationStorage {
  if(!db.objectStoreNames.contains(storeName))throw Error('group_store_missing');
  const request=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const run=async<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>Promise<T>):Promise<T>=>{
    const tx=db.transaction([storeName],mode,{durability:'strict'});
    const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('group_transaction_aborted'));});
    try{const result=await work(tx.objectStore(storeName));await done;return result;}
    catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
  };
  return {
    async read(key){return run('readonly',async store=>((await request(store.get(key))) as GroupRow|undefined)??null);},
    async readMany(keys){return run('readonly',async store=>Promise.all(keys.map(async key=>((await request(store.get(key))) as GroupRow|undefined)??null)));},
    async transaction(key,work){return run('readwrite',async store=>{
      const saved=((await request(store.get(key))) as GroupRow|undefined)??null;
      const {row,result}=work(saved);
      if(new TextEncoder().encode(JSON.stringify(row)).byteLength>1048576)throw Error('group_capacity');
      await request(store.put(row,key));return result;
    });},
  };
}
