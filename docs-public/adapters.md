# Host adapters

The package deliberately uses callbacks instead of depending on a web framework, database or identity product. [The executable example](../examples/check-only/main.mjs) connects both Node modules and the real Wasm core without requiring another product.

## Server

`createCheckProvider<Context, Principal, Target>` requires:

- `authenticate(context)`: verify the existing user session and return `{ binding, principal }`, or `null`. A machine token is not a user session.
- `authorize({ context, principal, target })`: check existence, tenant boundary and permission, then return `{ allowed: true, metadata: { scopeId, resourceId, contentHash } }`, or `{ allowed: false, reason: 'forbidden' | 'not_found' }`.
- Optional `readPolicy` and `leaseMs`: copied at construction, never accepted from a request.

The route calls `provider.check({ query, context, target })` and applies `status`, every returned header, and `body`. Authorization must also remain on all ordinary content APIs. Host errors become sanitized 503 responses. Neither server module writes logs by itself.

Native Rust APIs implement `AuthorizationAdapter` and await `CheckProvider::check`. Futures are Send and the library selects no async runtime. Return `Ok(None)` for missing identity and `Err(AdapterError)` for backend failures; do not use panics for ordinary errors. Use a fixed reviewed Git revision when depending on the alpha source.

## Checked reader

`createCheckedReader<T>` requires the expected `binding`, `resourceId`, `scopeId`, and:

- `session()`: return trusted `{ binding, context, expiresAtMs }`. Context is an opaque signed-in session generation and must change on logout/account changes. Do not return raw tokens or include them in IDs.
- `clock()`: return `{ boot, now_ms, wall_ms }` with nonnegative safe integer millisecond values. Boot identifies this process/clock origin; monotonic milliseconds advance with elapsed time, and wall milliseconds detect sleep and session expiry. For example, create one `boot = crypto.randomUUID()` per process/clock owner, then sample `{ boot, now_ms: Math.floor(performance.now()), wall_ms: Date.now() }`. Clocks must not move backward.
- `storage.load(binding)`: read the checkpoint for exactly that authority/product/tenant/principal and this reader's fixed target. Bind target-specific storage namespaces in the adapter closure when using more than one reader. Do not share it across bindings or uncoordinated owners.
- `storage.commit(plan)`: atomically compare `expected_revision`, persist `plan.next`, and return its revision only after durable success. Never acknowledge a pending or stale write. A production adapter must use actual database CAS; the example's memory store is educational.
- `check({ requestId })`: call a fixed trusted endpoint with the current session and return a Response-compatible status and JSON reader. Preserve HTTP errors; reject transport errors as TypeError or TimeoutError. For web callers use the product's authenticated same-origin transport.
- `read()` and `contentHash(value)`: read structured-cloneable target content and hash that exact value using the same canonicalization as the server. The reader clones the returned value before hashing so shared host-cache mutations cannot change the checked snapshot. Functions and other non-cloneable values fail closed. Do not supply a stale stored hash for newly changed content.

Node callers supply `wasmBytes` loaded from the installed package; browsers may fetch the Wasm asset from their bundler output. [Getting started](getting-started.md) describes asset loading. Readers serialize their own operations; separate owners need a host coordination protocol and are outside alpha guarantees.

The host must pass every protected read through the runtime and remove already rendered content when its displayed permit expires or identity changes. Search, export, AI tools, background tasks and other raw store reads are separate integration surfaces. UI hiding alone is not access control.

Use `reader.readWithPermit()` for UI delivery. It returns `{ value, validForMs, expiresAtMs, offline }`, where times are the remaining original permit after the read completes. Schedule removal using the smaller of remaining monotonic time and the wall-clock deadline; never reset the deadline after a failed check. Close the reader and clear content when the signed-in context changes. `reader.read()` remains the convenience API for immediate tool/server consumption and does not manage already delivered plaintext.

## Common local content storage

The additional entry points are `@authzflow/core/cache`, `@authzflow/core/sqlite` and `@authzflow/core/indexeddb`. They have no runtime dependencies. The SQLite adapter receives a synchronous database handle owned by the host; the browser adapter opens a named IndexedDB database. Both require synchronous `seal(bytes, aad)` / `open(bytes, aad)` codec callbacks. An identity codec in a test is not encryption. Key ownership, encryption and any content serialization belong to the host.

`createCachedRuntime({checkpoint, storage, clock, wasmBytes})` loads persisted authorization state with the same cold-start fence as the Rust runtime. A trusted host must install a fresh authoritative snapshot before serving content. `put(resourceId, bytes, expectedRevision)` registers local bytes under an existing grant; it does not grant access or edit server content. Capture the revision before the fetch, validate the authenticated response and its content hash, then pass that revision to `put`. A concurrent authority update rejects the old result.

`get(resourceId, offline?)` checks the Rust authority and the durable checkpoint before and after storage I/O, then returns an isolated byte copy. The host still owns session validity, authenticated snapshot provenance, hash validation, UI lease expiry and any derived data outside this storage. Reading raw Storage directly bypasses the Runtime boundary.

The body stamp binds its epoch, Resource metadata and required Scope metadata. A changed grant does not silently reactivate old bytes: the host must register the body again. `purge(resourceIds, expectedRevision)` accepts only resources denied directly or through a required Scope. It validates all targets before deleting any body. A failed purge leaves the durable deny intact for retry. It removes logical database rows; forensic device erasure and external copies are outside the contract.

Checkpoint and body operations use transactional revision CAS. SQLite uses `BEGIN IMMEDIATE`; IndexedDB uses a strict-durability transaction over checkpoint and body stores. Competing writers cannot overwrite a newer checkpoint. Keep one Runtime owner per context, and recreate/revalidate an owner after a revision conflict. Closing the SQLite adapter leaves the host database connection open; closing the IndexedDB adapter closes its connection. A browser `versionchange` closes the old owner.

For authority-epoch or cursor reset, fence the old Runtime, persist denial and purge old bodies before installing the fresh authority. Preserve monotonic storage revisions across the reset; deleting a checkpoint and reusing its old revision can allow an old fetch to collide with a new grant. The Storage `commit` port is a trusted host boundary, not an end-user authorization API. The change consumer requires only `snapshot`, `applyChanges` and `close`, so it can consume a cached runtime and call its `purge` method.

## Existing document journals and replica purge

Use `@authzflow/core/replicas` when content is already owned by another journal.
The package exports `canPurgeReplica` and the `ExternalReplicaPurger` /
`ReplicaPurgeOutcome` types. It has no database, editor or CRDT dependency.

The host must run these steps in one transaction:

1. Check the durable authorization checkpoint's binding, revision and direct or inherited denial.
2. Enumerate every matching replica, including older generations, for exactly that product, principal and resource.
3. Extract the six boolean flags from the host journal: pending writes, sending batch, conflicts, holds, unresolved original sources and content/metadata changes.
4. Call `canPurgeReplica` for every replica before deleting any. Return `{status:'blocked'}` if any is unsafe. Keep all replicas and durable denial.
5. Delete all matching clean replicas and associated projections atomically, then return `{status:'purged'}`. Roll back all deletions on failure.

This predicate is eligibility only: it neither grants permission nor establishes a
transaction. Supply complete boolean inputs from trusted journal state, compare
metadata by content rather than object key insertion order, and reject malformed
journal data. Unrelated principals/resources must remain untouched. Fence reads
and late hydrate/ACK/write operations against durable denial in their own
transaction. A fresh grant requires revalidation; a stale purge revision cannot
delete content belonging to that grant.

A blocked purge is **unfinished**, not successful physical removal. Unsent changes
remain quarantined and inaccessible; resolving them needs a separate host policy.
Do not silently discard them or automatically upload them under revoked authority.
`createChangeConsumer` accepts the structured outcome and throws
`authz_purge_blocked` before further catch-up when deletion is blocked. It retries
from durable denial on the next call. Existing callbacks returning void retain
their contract: resolve only after complete deletion, otherwise reject.

Node adapter tests can import `registerReplicaConformance` from
`@authzflow/core/testing`. Pass `{name,createFixture}`; the fixture interface is
published with the entrypoint. The ten cases check all generations, principal and
resource isolation, six dirty states, delayed access/write fencing, stale grant,
transaction rollback/retry and reopen. Use the real adapter/database; privileged
`inventory` is test-only raw inspection and must report physically present rows,
even while denied. `failDeletion` must fail during deletion after work can have
started. `reopen` must actually close/reopen durable storage. The executable
external SQLite journal in `packages/core/test/replica-conformance.test.mjs`
demonstrates the fixture. The Node test harness is optional and is never imported
by browser/runtime entrypoints.

## One content hash adapter on both sides

```js
import {createContentHasher} from '@authzflow/core/content-hash';
const hashContent = createContentHasher({
  serialize: value => JSON.stringify([value.id, value.title, value.body]),
  digest: async bytes => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')
  ).join('')
});
// Server authorize: contentHash: await hashContent(currentContent)
// Checked reader: contentHash: hashContent
```

Use the same explicit projection and serializer on client/server. The helper
clones content before serialization, encodes UTF-8 and validates a lowercase
SHA-256 hex digest. Node hosts can inject `createHash('sha256').update(bytes).digest('hex')`.
It never reuses a stored digest or selects fields on the host's behalf. Do not
sort document arrays or hash arbitrary CRDT encoding as a substitute for defining
the displayed-content contract. Excluded fields are outside the hash guarantee.

### React Native and native Rust

`@authzflow/core/native-reader` exports `createNativeRuntime` and
`createNativeCheckedReader`. Supply a synchronous `NativePort.call(JSON)` bridge
backed by `authzflow-native` ABI2. iOS uses a prebuilt Rust static library/XCFramework;
Android uses the same Rust crate as a shared library. `authzflow-core::OwnedRuntime`
owns decisions, preparation, receipt acknowledgement, fencing and closed state.
No authorization engine is reimplemented in TypeScript.

The host supplies secure entropy, boot-bound monotonic/wall clocks, trusted session,
durable SQLite CAS and a content hash matching the server serialization. Native
and Wasm share the checked-reader protocol and host orchestration. Cold restart
requires a complete online check. Server policy bounds offline access; background
and session changes must invalidate the reader and remove the displayed view.
Keep this bridge in the trusted host, outside the editor realm. Missing native
binaries or ABI mismatches fail closed without a JavaScript/Wasm fallback.

Persist denial before attempting replica purge. Retain unsent work and durable
denial on a blocked/failed purge; report purge as unfinished. A complete-check
reader remains separate from adopting the runtime's change-consumer path.

## Resource authority and recovery coordinator

`createResourceAuthority<Target>()` composes the existing Rust CheckedReader and change consumer. Inputs contain `binding`, stable `resourceId`, `scopeId`, serialized `content`, and an optional JSON `target` for host routing. Neither a target nor a stream event grants access. Keep resource IDs unique within the authority/product/tenant/principal storage namespace, independent of display names and mutable routes.

The host supplies:

- `storage.load(kind, resourceId)` and `commit(kind, resourceId, plan)`, where kind is `reader` or `changes`. Keep the two namespaces distinct and enforce durable revision CAS for the same principal. A cursor must not overwrite a content checkpoint.
- `check(input, requestId)` plus optional `changes.snapshot(input, requestId)` and `changes.fetch(input, query)` using authenticated trusted transport.
- When changes are enabled, an explicit `onDenied(input)` is required. Persisted denial precedes this callback. Delete clean replicas idempotently; throw `authz_purge_blocked` for pending edits or incomplete deletion. Never return successful deletion for a dirty replica. `onGranted(input)` may remove the host deny marker and schedule its existing write journal, but is not a write receipt.
- `onInvalidated(input)` to hide/recheck a view after durable invalidation. The host must also enforce the returned deadline for already rendered content.
- Optional `ownsContent(input)` at the trusted storage owner. It must compare the same principal/resource's actual confirmed or local projection. A UI boolean is not proof. This only permits reuse of the original checked bytes under the original offline deadline, never renewal or a new offline grant.

`readWithPermit(input)` performs the full check/recovery path. `readCachedWithPermit(input)` never joins an unfinished online check or obtains its new lease; it rejects with `check_in_progress` during another operation. It otherwise uses an existing live Rust grant. Cold checkpoints alone cannot grant offline reads.

Advance the content baseline only from server-acknowledged state. Keep unsent local edits separate. Do not present a stale pre-save baseline indefinitely after a successful server ACK. Product projection/default normalization must be identical on client and server; the coordinator does not change product bytes.

On reconnect, cursors resume missing changes. Reset fences old authority before a fresh authenticated snapshot; after clean purge or blocked dirty purge a fresh snapshot is required before a complete check can regrant. One blocked resource does not prevent other registered resources from receiving denial. Failed multi-store deletion remains unfinished and retryable. The host preserves its immutable in-flight batch and verifies its real receipt when sending resumes.

Coordination retains at most 64 resource readers and catches up eight at a time. Polls coalesce; the default interval is five seconds. These are resource bounds, not a latency or scale guarantee. Use `pollIntervalMs: 0` for host-managed wakeups and call `catchUp()` in the verified session context; `runWithSession` can supply that context to background polling.

Hermes/native hosts import `createNativeResourceAuthority` from
`@authzflow/core/native-reader` and supply `native` and `randomUUID`. This entry
has no Wasm loader in its runtime import graph. Do not import the Web default
authority from the package root into Hermes. Hosts can override both `runtime`
and `reader` factories using `createNativeRuntime` and `createNativeCheckedReader` with the real Rust port. JSON-only native environments can also supply `clone` and `randomUUID` ports. Web defaults load the real Wasm runtime. Factory/ABI failure has no JavaScript authorization fallback. Existing replica conformance remains necessary for real IndexedDB/SQLite deletion semantics.

### State and explicit revalidation (alpha.8)

The existing `readWithPermit(input)` can use a still-valid in-memory offline
permit after a transport failure. `readCachedWithPermit(input)` is a secondary
cache check: it never starts/joins an online check or renews a grant.
`revalidate(input)` instead drops the previous in-memory permit, catches up known
changes and requires a fresh online full check, durable checkpoint commit and
successful `onGranted` callback before returning a lease. Offline failure does
not fall back to the old permit. A later invalidation can still revoke a returned
lease; no API makes a concurrent future ACL change impossible.

```ts
const identity = { binding, resourceId, scopeId };
const unsubscribe = authority.subscribe(identity, state => viewStore.set(state));
await authority.revalidate({ ...identity, content, target });
const state = authority.getState(identity);
// Dispose with the view. Reading content still uses a checked operation.
unsubscribe();
```

Snapshots are frozen and contain `phase`, a fixed `reason`, local `revision`,
`mode`, `expiresAt` and `validForMs`. Phases are `idle`, `checking`, `allowed`,
`revalidate`, `denied`, `expired`, `closed`. Only active allowed snapshots carry
expiry/mode information. Mode describes the last successful primary operation;
secondary cache checks do not relabel an active UI's connectivity. Snapshots are
advisory, never credentials or permission to bypass a checked read. In particular,
`getState()` cannot asynchronously validate a session that changed outside the
adapter. The trusted session port must still fence each operation.

Revisions increase within a resident observation and are not durable storage
revisions or cross-process ordering tokens. The coordinator bounds resident
resources to 64, including watched resources; eviction closes that observation
and reader. Each resource permits at most 64 subscriptions. A subscription emits
the initial state, transitions and expiry; expiry timers exist only while there
are subscribers. `getState()` also samples elapsed time and rejects invalid,
regressing or changed-boot clocks in the advisory state. Slow async subscribers
coalesce to the newest snapshot; exceptions/rejections do not affect reads.
Unsubscribe and `close()` release subscriptions/timers. Prefer synchronous
view-store updates rather than asynchronous work in subscribers.

Known invalidation immediately fences pending grant results. Host allow/deny
effects are serialized per resource: a delayed allow callback must finish before
a concurrent revoke's purge callback. A failed allow callback leaves no usable
secondary permit. These callbacks must not re-enter operations on the same
resource and must retain the host's transactional revision guards.

Optional `onEvent` receives the existing Rust runtime events and fixed
`authority_*` events for check/revalidation start, grant, invalidation, expiry,
check/catch-up failure, blocked purge and close. The callback is disabled by
default; the SDK writes no logs itself. Events omit binding/resource IDs, body,
target, cursor, tokens and raw exception messages. The sink is never awaited by
authorization; one async sink invocation can be in flight, excess events are
dropped with a bounded `droppedEvents` count. Observer failure is isolated.

`registerResourceAuthorityContract()` now exercises both Wasm and native Rust
with held responses, ACK/disconnect, strict/ordinary concurrent checks, expiry,
session changes, delayed host effects, revoke ordering and diagnostic isolation.
Its in-memory storage fixtures validate coordination, not physical deletion by a
particular product. Continue running the replica contract against real storage.

## Reusable integration contracts

`@authzflow/core/testing` retains `registerReplicaConformance` and adds:

- `registerResourceAuthorityContract(name, createAuthority, wasmBytes?)`: exercise original offline deadlines, cold/session rejection, cached-read isolation, trusted projection/ACK races, dirty resource isolation and reader coalescing. The suite is run against both real Wasm and native Rust in this repository. Its memory transport/storage fixture is not proof of a consumer's physical purge.
- `registerContentHashConformance({name, clientSerialize, serverSerialize, equivalent, different})`: verify independently expected canonical bytes, actual client/server serializer parity, unchanged inputs and hashes that change when protected fields change. Each equivalent group supplies at least two differently shaped values and an explicit expected string; each different pair specifies a field-sensitive change. Supply product cases for key order, null/default editor attributes, ACK projections, identity and body changes.

No universal JSON/editor normalizer is imposed. Existing products keep their reviewed serialization and pass real serializers into this contract. Run normal content APIs, cache/CLI reads and offline/reconnect tests in the consuming application as well.
