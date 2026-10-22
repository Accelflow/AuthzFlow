export {createChangeFeed, type ChangeFeed, type ChangeFeedOptions, type ChangeJournal, type ChangeBatch, type StreamPosition, type StreamCheck} from './change-feed.js';
export type ReadPolicy = { mode: 'online_only' } | { mode: 'offline_ttl'; ttlMinutes: number };
export type CheckMetadata = { scopeId: string; resourceId: string; contentHash: string };
export type AuthorizationDecision = { allowed: true; metadata: CheckMetadata } | { allowed: false; reason: 'forbidden' | 'not_found' };
export type CheckResponse = CheckMetadata & {
  schemaVersion: 1; mode: 'check_only'; requestId: string; binding: string;
  epoch: string; leaseMs: number;
  readPolicy: { mode: 'online_only' | 'offline_ttl'; maxOfflineMs: number };
};
export type CheckError = 'invalid_authz_check' | 'user_session_required' | 'access_required' | 'resource_not_found' | 'authz_check_unavailable';
export type CheckResult = {
  status: 200; headers: Readonly<{ 'Cache-Control': 'no-store' }>; body: CheckResponse;
} | {
  status: 400 | 401 | 403 | 404 | 503;
  headers: Readonly<{ 'Cache-Control': 'no-store' }>; body: { error: { code: CheckError } };
};
export type ProviderOptions<Context, Principal, Target> = {
  authenticate(context: Context): Promise<{ binding: string; principal: Principal } | null>;
  authorize(input: { context: Context; principal: Principal; target: Target }): Promise<AuthorizationDecision>;
  readPolicy?: ReadPolicy;
  leaseMs?: number;
};
export type CheckProvider<Context, Target> = {
  check(input: { query: Readonly<Record<string, unknown>>; context: Context; target: Target }): Promise<CheckResult>;
};
export function createCheckProvider<Context, Principal, Target>(options: ProviderOptions<Context, Principal, Target>): CheckProvider<Context, Target> {
  const policy = options.readPolicy ?? { mode: 'online_only' };
  const maxOfflineMs = policy.mode === 'offline_ttl' ? policy.ttlMinutes * 60_000 : 0;
  const leaseMs = options.leaseMs ?? 5000;
  if (!['online_only', 'offline_ttl'].includes(policy.mode)
    || (policy.mode === 'offline_ttl' && typeof policy.ttlMinutes !== 'number')
    || !Number.isSafeInteger(maxOfflineMs) || maxOfflineMs < 0 || maxOfflineMs > 86_400_000
    || (policy.mode === 'offline_ttl' && maxOfflineMs === 0)
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 5000
    || typeof options.authenticate !== 'function' || typeof options.authorize !== 'function') {
    throw new Error('authz_server_config_invalid');
  }
  const readPolicy = Object.freeze({ mode: policy.mode, maxOfflineMs });
  const headers = Object.freeze({ 'Cache-Control': 'no-store' as const });
  const { authenticate, authorize } = options;
  return {
    async check({ query, context, target }): Promise<CheckResult> {
      // Copy the nonce before awaiting host I/O; client input never supplies identity or policy.
      const requestId = query.requestId;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        || Object.keys(query).length !== 1) {
        return { status: 400, headers, body: { error: { code: 'invalid_authz_check' } } };
      }
      try {
        const identity = await authenticate(context);
        if (identity === null) return { status: 401, headers, body: { error: { code: 'user_session_required' } } };
        if (typeof identity.binding !== 'string' || identity.binding.length === 0 || identity.binding.length > 4096) {
          throw new Error('authz_adapter_invalid');
        }
        const binding = identity.binding;
        const decision = await authorize({ context, principal: identity.principal, target });
        if (decision.allowed === false) {
          if (decision.reason === 'forbidden') return { status: 403, headers, body: { error: { code: 'access_required' } } };
          if (decision.reason === 'not_found') return { status: 404, headers, body: { error: { code: 'resource_not_found' } } };
          throw new Error('authz_adapter_invalid');
        }
        if (decision.allowed !== true) throw new Error('authz_adapter_invalid');
        const { scopeId, resourceId, contentHash } = decision.metadata;
        if (typeof scopeId !== 'string' || scopeId.length === 0 || scopeId.length > 4096
          || typeof resourceId !== 'string' || resourceId.length === 0 || resourceId.length > 4096
          || typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
          throw new Error('authz_adapter_invalid');
        }
        return { status: 200, headers, body: {
          schemaVersion: 1, mode: 'check_only', requestId, binding,
          epoch: globalThis.crypto.randomUUID(), scopeId, resourceId, contentHash, leaseMs, readPolicy,
        } };
      } catch {
        // Host exceptions can contain credentials, SQL or private URLs. Never return or log them.
        return { status: 503, headers, body: { error: { code: 'authz_check_unavailable' } } };
      }
    },
  };
}
