# Resource Group protocol v2

Resource Groups aggregate invalidation delivery, not permissions or Scope
hierarchy. A Resource belongs to one delivery Group at a time. Group and Resource
IDs are opaque nonempty strings of at most 4096 UTF-8 bytes.

All authenticated responses use `Cache-Control: no-store`. Group subscribe
returns `{schemaVersion:2,kind:"resource_group",requestId,binding,resourceGroupId,
position:{epoch,sequence,cursor}}`. The host verifies current or previously
established subscription entitlement. Former subscribers can receive their own
revocation, without gaining access to content or new private resource IDs.

Pull returns `{schemaVersion:2,kind:"resource_group",requestId,hasMore,batch}`.
The batch contains `binding`, `resourceGroupId`, `epoch`, `fromSequence`,
`throughSequence`, `nextCursor`, and `changes:[{sequence,action}]`. Actions are
`revoke` and `revalidate`, affecting the whole Group. No Resource IDs or content
are disclosed in this feed. Decimal u64 sequences are contiguous; each page has
at most 100 events and one catch-up processes at most 32 pages. Empty pages must
not advance sequence. A cursor is opaque, authenticated and bound to protocol,
authority, binding, Group and epoch. It never grants content access.

A fresh Resource complete-check carries `resourceGroup:{resourceGroupId,epoch,
sequence}` from the same consistent server barrier as its ACL/hash check. The
client catches up to that position and refuses a stale check that crosses a
later invalidation. The random complete-check epoch is separate from Group epoch.
Existing v1 endpoints must not return v2 to an unaware client.

Rust owns Group transitions and rejects wrong identity/version, gaps, overflow,
invalid actions and unknown fields. A durable Group fence, cursor and fan-out
intent commit atomically. A new subscription/reset never creates a grant.
Revalidate does not erase an outstanding revoke. Purge completion does not grant.
Only a successful fresh Resource check can replace that Resource's fence.
All reads still pass the existing Rust Resource reader and exact content hash.

The host performs CAS transactions, retains pending intents, and rejects stale
owner terms. Physical deletion requires a revision/owner-fenced transaction and
must preserve dirty data. Unregistering a reader never removes durable denial.
The initial resident limits are 64 Groups and 64 Resources per authority;
capacity errors must not discard incomplete intents.

Subscribe/reset metadata never permits offline cold start. An unknown/expired
cursor returns 409 `reset_required`; clients first persist a fence before
installing the new position. 401/403/404 deny; malformed metadata and persistence
failure fence reads. Transport errors alone retain only the original bounded
offline permit, provided no newer shared invalidation exists.
