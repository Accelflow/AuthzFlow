# Cached batch v1

`ResourceAuthority.readCachedManyWithPermit(inputs)` checks existing in-memory
Resource permits only. It performs no HTTP check, renews no deadline, and creates
no missing reader. Inputs are snapshotted before asynchronous work. Results keep
input order and discriminate `allowed`, `denied` and `unavailable`.

Limits: 64 items, 4 MiB total UTF-8 content, 1 MiB per item, at most 8 concurrent
Resource checks. Duplicate Resource inputs are serialized. Invalid envelopes
reject the entire call before work. Missing permits, expiry, changed content,
pending checks, revalidation and storage failure are not server denials.

Context changes invalidate all corresponding results. Each successful item is
checked again before delivery; elapsed monotonic/wall time, original expiry,
session expiry, shared Group fence and Resource revision still apply. A consumer
must not mutate/refetch content after verification and reuse the old result.
Already delivered plaintext is outside this guarantee.
