import type {ReplicaPurgeOutcome} from './replicas.js';
import type {Runtime, Batch} from './index.js';
export interface ChangeConsumerOptions {
  randomUUID?:()=>string;
  runtime: Pick<Runtime, 'snapshot' | 'applyChanges' | 'close'>;
  fetchChanges(input: {requestId: string; cursor: string}): Promise<{status: number; json(): Promise<unknown>}>;
  /** Idempotent host deletion. A durable deny remains the retry intent on failure. */
  purge(resourceIds: string[], checkpointRevision: string): Promise<void | ReplicaPurgeOutcome>;
}
export interface ChangeConsumer { catchUp(): Promise<void> }
export function createChangeConsumer(options: ChangeConsumerOptions): ChangeConsumer {
  const drain = async () => {
      const saved = options.runtime.snapshot();
      const ids = Object.entries(saved.resources).filter(([, e]) => e.access === 'deny' || e.scopes.some(id => saved.scopes[id]?.access === 'deny')).map(([id]) => id).sort();
      if (ids.length) {
        const outcome=await options.purge(ids, saved.revision);
        if(outcome!==undefined&&outcome?.status!=='purged')throw Error(outcome?.status==='blocked'?'authz_purge_blocked':'authz_purge_result_invalid');
      }
  };
  return {
    async catchUp() {
      await drain();
      for (let page = 0; page < 32; page++) {
        const state = options.runtime.snapshot();
        const requestId = options.randomUUID?.() ?? crypto.randomUUID();
        const response = await options.fetchChanges({ requestId, cursor: state.cursor });
        if (response.status !== 200) {
          options.runtime.close();
          throw Error(response.status === 409 ? 'authz_changes_reset_required' : 'authz_changes_unavailable');
        }
        let body: {schemaVersion: number; requestId: string; hasMore: boolean; batch: Batch};
        try {
          body = await response.json() as typeof body;
          const batch = body?.batch;
          const number = (v: string) => {
            if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 20 || BigInt(v) > 18446744073709551615n) throw Error();
            return BigInt(v);
          };
          if (body?.schemaVersion !== 1 || body.requestId !== requestId || typeof body.hasMore !== 'boolean'
            || !batch || batch.binding !== state.binding || batch.epoch !== state.epoch || batch.from_sequence !== state.sequence
            || typeof batch.next_cursor !== 'string' || !batch.next_cursor || batch.next_cursor.length > 8192
            || !Array.isArray(batch.changes) || batch.changes.length > 100) throw Error();
          let previous = number(batch.from_sequence); const through = number(batch.through_sequence);
          for (const event of batch.changes) {
            if (!event || number(event.sequence) !== previous + 1n || !event.target || !['resource','scope'].includes(event.target.kind)
              || typeof event.target.id !== 'string' || !event.target.id || event.target.id.length > 4096
              || !['revoke','revalidate','invalidate','purge','grant'].includes(event.action)) throw Error();
            previous = number(event.sequence);
          }
          if (previous !== through || through < number(state.sequence) || body.hasMore && through === number(state.sequence)) throw Error();
        } catch {
          options.runtime.close(); throw Error('authz_changes_invalid');
        }
        await options.runtime.applyChanges(body.batch);
        await drain();
        if (!body.hasMore) return;
      }
      options.runtime.close();
      throw Error('authz_changes_limit');
    }
  };
}
