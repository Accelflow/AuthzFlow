export {canPurgeReplica} from './replica-eligibility.js';
/** A blocked purge is unfinished. Durable denial must remain installed for retry. */
export type ReplicaPurgeOutcome = {status:'purged'} | {status:'blocked'};
/** Host must atomically check revision + denial, inspect all matching replicas, then delete all or none.
 * The host owns principal/product/resource binding, dirty-state extraction and its transaction.
 * No generation may be omitted. This port must not grant access or erase unsent edits.
 */
export interface ExternalReplicaPurger {
 purge(resources:string[],expectedRevision:string):Promise<ReplicaPurgeOutcome>;
}
