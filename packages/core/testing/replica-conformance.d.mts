import type {ReplicaPurgeOutcome} from '../dist/replicas.js';
export interface ReplicaConformanceFixture {
 deny():Promise<string>;grant():Promise<void>;
 purge(revision:string):Promise<ReplicaPurgeOutcome>;
 read():Promise<unknown>;delayedWrite():Promise<unknown>;
 inventory():Promise<string[]>;isDenied():Promise<boolean>;
 markDirty(kind:'pendingWrites'|'inFlight'|'conflicts'|'holds'|'unresolvedSources'|'contentChanged'):Promise<void>;
 failDeletion(enabled:boolean):Promise<void>;reopen():Promise<void>;close():Promise<void>;
}
export function registerReplicaConformance(options:{name:string;createFixture:()=>Promise<ReplicaConformanceFixture>}):void;
