/** Use the same explicit projection/serialization on client and server. No stored hash is reused. */
export function createContentHasher<T>(options: {
 serialize: (value:T)=>string;
 digest: (bytes:Uint8Array<ArrayBuffer>)=>string|Promise<string>;
}): (value:T)=>Promise<string> {
 return async value=>{
  const snapshot=structuredClone(value);
  const payload=options.serialize(snapshot);
  if(typeof payload!=='string')throw Error('content_serialization_invalid');
  const hash=await options.digest(new TextEncoder().encode(payload));
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw Error('content_hash_invalid');
  return hash;
 };
}
