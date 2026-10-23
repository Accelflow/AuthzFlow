# Complete-check protocol

The product chooses its HTTP route and authentication. Use HTTPS with a fixed trusted authority in deployed applications. The caller sends only `requestId`, an ASCII alphanumeric, underscore or hyphen string of 1 to 128 characters. The checked reader creates a fresh cryptographic nonce for each check. Query parameters must not select identity, binding or offline policy.

A successful server response has this shape:

```json
{
  "schemaVersion": 1,
  "mode": "check_only",
  "requestId": "the-request-nonce",
  "binding": "product-tenant-principal",
  "epoch": "a-fresh-cryptographic-UUID",
  "scopeId": "workspace",
  "resourceId": "article",
  "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "leaseMs": 5000,
  "readPolicy": { "mode": "offline_ttl", "maxOfflineMs": 60000 }
}
```

All responses, including errors, use `Cache-Control: no-store`. Error codes are `invalid_authz_check` (400), `user_session_required` (401), `access_required` (403), `resource_not_found` (404), or `authz_check_unavailable` (503). Product routes may translate error codes while preserving status and cache behavior.

`contentHash` is lowercase SHA-256 of a product-defined canonical representation. Server and client must use exactly the same fields and ordering. Do not return article content or credentials in metadata.

`leaseMs` is a positive integer, at most 5000. The client counts request and storage time from before the check starts. The server configuration uses `{ mode: 'online_only' }` by default or `{ mode: 'offline_ttl', ttlMinutes: 30 }`. Offline durations are positive, at most 1440 minutes and must convert to an integer number of milliseconds. Whole minutes are recommended.

A bounded offline permit exists only after a successful authenticated read in the current reader instance. Transport failures may use the original permit until its original deadline. A 401, 403, 404, malformed response, failed storage operation or HTTP backend error does not create or renew a permit. Both monotonic and wall elapsed time, the original session expiry, and the current verified session bound offline reads. Restart, clock rollback, boot change or session-context change requires a fresh check.

The checked reader rejects expired, missing, denied or unverified states. On explicit denial it attempts to durably save deny for an existing target; even if that persistence fails it returns no content. A new successful complete check may restore permission. No resumable stream version is fabricated from timestamps or client counters.

## Resumable invalidation companion

The Node server additionally exports `createChangeFeed`. Its `snapshot` operation calls the existing complete-check provider and obtains `{ stream: { epoch, sequence, cursor } }` inside one host journal barrier. The same barrier must cover every relevant permission mutation. A conservative invalidation must be durably recorded before an upstream ACL mutation; publishing only after a mutation creates a crash gap. A host that cannot provide this contract must keep using complete checks.

The `changes` operation accepts only `requestId` and an opaque `cursor`. It authenticates the existing user session. A cursor is scoped to the authenticated binding and the exact subscribed target; knowing a cursor never grants a different user's access. An authenticated former subscriber must be able to receive its revocation even after membership is removed. No article body or credentials belong in the feed.

A successful pull returns `{ schemaVersion: 1, requestId, batch, hasMore }`. `batch` uses the Core's snake_case `binding`, `epoch`, `from_sequence`, `through_sequence`, `next_cursor` and `changes`. Event sequences are canonical decimal u64 strings, consecutive within this target stream. The response is complete through its declared position. A changed epoch, unknown/expired cursor, or retained-history gap requires a 409 `reset_required`; never silently jump to the latest cursor.

`createChangeConsumer` validates the response, commits deny and cursor together through the supplied Runtime, then calls the host's idempotent purge. Durable deny is also the retry intent: pending deletion is retried before fetching more changes. Failed deletion never grants content. The host must serialize consumer operations and fence its content reader when changes arrive. Maximum page size is 100 events and a catch-up is bounded to 32 pages. Reset requires a host-controlled fail-closed resynchronization; the consumer does not invent a grant or cursor.

This feed is an invalidation companion to complete checks. GRANT/REVALIDATE events require a fresh authenticated check. It does not extend offline permits, permit offline cold start, or turn transport failures into authorization decisions. Server journal durability, retention, permission mutation coverage and snapshot barriers must be verified by each host integration.
