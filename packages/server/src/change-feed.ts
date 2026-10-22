import type { CheckResult, CheckResponse } from './index.js';

export interface StreamPosition { epoch: string; sequence: string; cursor: string }
export interface ChangeBatch {
  binding: string; epoch: string; from_sequence: string; through_sequence: string; next_cursor: string;
  changes: {sequence: string; target: {kind: 'scope' | 'resource'; id: string}; action: 'revoke' | 'revalidate' | 'invalidate' | 'purge' | 'grant'}[];
}
/** Host serializes checks and all relevant permission mutations in the same barrier.
 * Append a conservative invalidation durably BEFORE changing the upstream ACL.
 * Only a successful fresh check can grant access. Unknown/expired cursors reset.
 */
export interface ChangeJournal<Target> {
  barrier<T>(run: () => Promise<T>): Promise<T>;
  subscribe(binding: string, target: Target): Promise<StreamPosition>;
  read(binding: string, target: Target, cursor: string, limit: number): Promise<{batch: ChangeBatch; hasMore: boolean}>;
}
export type FeedResult = {status: number; headers: Readonly<{'Cache-Control': 'no-store'}>; body: unknown};
export interface ChangeFeedOptions<Context, Target> {
  authenticate(context: Context): Promise<{binding: string} | null>;
  check(input: {query: Readonly<Record<string, unknown>>; context: Context; target: Target}): Promise<CheckResult>;
  journal: ChangeJournal<Target>;
}
export interface ChangeFeed<Context, Target> {
  snapshot(input: {query: Readonly<Record<string, unknown>>; context: Context; target: Target}): Promise<FeedResult>;
  changes(input: {query: Readonly<Record<string, unknown>>; context: Context; target: Target}): Promise<FeedResult>;
}
export type StreamCheck = CheckResponse & {stream: StreamPosition};
export function createChangeFeed<Context, Target>(options: ChangeFeedOptions<Context, Target>): ChangeFeed<Context, Target> {
  const headers = Object.freeze({'Cache-Control': 'no-store' as const});
  const failure = (status: number, code: string): FeedResult => ({status, headers, body: {error: {code}}});
  return {
    async snapshot(input) {
      try {
        return await options.journal.barrier(async () => {
          const result = await options.check(input);
          if (result.status !== 200) return result;
          const stream = await options.journal.subscribe(result.body.binding, input.target);
          return {...result, headers, body: {...result.body, stream}};
        });
      } catch { return failure(503, 'authz_changes_unavailable'); }
    },
    async changes({query, context, target}) {
      const requestId = query.requestId, cursor = query.cursor;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        || typeof cursor !== 'string' || !cursor || cursor.length > 8192
        || Object.keys(query).length !== 2) return failure(400, 'invalid_authz_changes');
      try {
        const identity = await options.authenticate(context);
        if (!identity) return failure(401, 'user_session_required');
        if (typeof identity.binding !== 'string' || !identity.binding || identity.binding.length > 4096) throw Error();
        const result = await options.journal.barrier(() => options.journal.read(identity.binding, target, cursor, 100));
        return {status: 200, headers, body: {schemaVersion: 1, requestId, ...result}};
      } catch (error) {
        return error instanceof Error && error.message === 'cursor_reset_required'
          ? failure(409, 'reset_required') : failure(503, 'authz_changes_unavailable');
      }
    },
  };
}
