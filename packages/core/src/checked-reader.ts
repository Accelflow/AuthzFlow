import {createRuntime} from './index.js';
import {createProtocolCheckedReader,type CheckedReaderOptions,type CheckedReader} from './checked-reader-protocol.js';
export type {CheckedReaderOptions,CheckedRead,CheckedReader} from './checked-reader-protocol.js';
/** Rust/Wasm reader for Node and browser hosts. */
export async function createCheckedReader<T>(options:CheckedReaderOptions<T>):Promise<CheckedReader<T>> {
 return createProtocolCheckedReader({...options,createRuntime,clone:value=>structuredClone(value),randomUUID:()=>globalThis.crypto.randomUUID()});
}
