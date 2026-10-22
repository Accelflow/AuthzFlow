import {readFile} from 'node:fs/promises';
import {createCheckedReader} from '../dist/checked-reader.js';
import {registerCheckedReaderContract} from './checked-reader-contract.mjs';
const wasmBytes=new Uint8Array(await readFile(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
registerCheckedReaderContract('Rust/Wasm',createCheckedReader,wasmBytes);
