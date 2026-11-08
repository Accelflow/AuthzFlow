import init, {dispatch} from '../wasm/authzflow_wasm.js';
import {createDrivenResourceGroup, type ResourceGroupOptions} from './resource-group-driver.js';
export type * from './resource-group-driver.js';

/** Wasm transport only; Group protocol and transition validation execute Rust. */
export async function createResourceGroupCoordinator(options: ResourceGroupOptions & {wasmBytes?: Uint8Array<ArrayBuffer>}) {
  await init(options.wasmBytes ? {module_or_path: options.wasmBytes} : undefined);
  return createDrivenResourceGroup(options, request=>JSON.parse(dispatch(JSON.stringify({op:'group',request}))));
}
