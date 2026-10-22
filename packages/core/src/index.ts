export {createResourceAuthority,type ResourceAuthority,type ResourceAuthorityOptions,type ResourceReadInput,type ResourceReadLease,type ResourceIdentity,type ResourceAuthorityState,type ResourceAuthorityPhase,type ResourceAuthorityReason,type ResourceAuthorityEvent,type ResourceAuthorityEventCode,type ResourceAuthorityDiagnostic} from './resource-authority.js';
import {createDrivenRuntime} from './runtime-driver.js';
export {createChangeConsumer, type ChangeConsumer, type ChangeConsumerOptions} from './change-consumer.js';
import init, { WasmRuntime, runtime_abi_version } from '../wasm/authzflow_wasm.js';
export { createCheckedReader, type CheckedRead, type CheckedReader, type CheckedReaderOptions } from './checked-reader.js';

export interface Clock { boot: string; now_ms: number }
export interface Entry {
  access: 'allow' | 'deny' | 'revalidate'; version: string; expires_at_ms: number;
  offline: boolean; boot: string; scopes: string[]; stale: boolean;
}
export interface Checkpoint {
  schema_version: number; binding: string; epoch: string; sequence: string; revision: string;
  cursor: string; phase: 'uninitialized' | 'ready' | 'commit_pending' | 'resync_required' | 'closed';
  resources: Record<string, Entry>; scopes: Record<string, Entry>;
}
export interface Batch {
  binding: string; epoch: string; from_sequence: string; through_sequence: string; next_cursor: string;
  changes: {sequence: string; target: {kind:'resource'|'scope';id:string};action:'revoke'|'revalidate'|'invalidate'|'purge'|'grant'}[];
}
export interface Plan { expected_revision: string; pending: Checkpoint; next: Checkpoint }
export type RuntimeEventCode = 'runtime_initialized' | 'snapshot_applied' | 'changes_applied' |
  'resources_invalidated' | 'read_denied' | 'offline_read' | 'online_resumed' |
  'runtime_fenced' | 'runtime_closed' | 'operation_failed';
export interface RuntimeEvent {
  readonly schemaVersion: 1;
  readonly code: RuntimeEventCode;
  readonly level: 'info' | 'warn' | 'error';
  readonly phase: Checkpoint['phase'];
  readonly reason?: 'not_ready' | 'resource_not_found' | 'resource_invalid' | 'scope_not_found' | 'scope_invalid' |
    'authorization_denied' | 'clock_discontinuity' | 'persistence_failed' | 'transition_failed' | 'context_changed';
  readonly count?: number;
  readonly durationMs?: number;
  readonly droppedEvents?: number;
}
export interface Options {
  checkpoint: Checkpoint;
  clock: () => Clock;
  commit: (plan: Plan) => Promise<string>;
  onInvalidate?: (resources: string[]) => void;
  wasmBytes?: Uint8Array<ArrayBuffer>;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}
export interface Runtime {
  get<T>(resource: string, read: () => Promise<T>, offline?: boolean): Promise<T>;
  applySnapshot(snapshot: Checkpoint): Promise<void>;
  applyChanges(batch: Batch): Promise<void>;
  tick(offline?: boolean): void;
  close(): void;
  snapshot(): Checkpoint;
}

/** Loads the Rust authority. Restored state always requires a fresh server check. */
export async function createRuntime(options: Options): Promise<Runtime> {
  await init(options.wasmBytes ? {module_or_path:options.wasmBytes} : undefined);
  if(runtime_abi_version()!==2)throw Error('abi_mismatch');
  return createDrivenRuntime({...options,authority:new WasmRuntime(JSON.stringify(options.checkpoint)),clone:value=>structuredClone(value)});
}
