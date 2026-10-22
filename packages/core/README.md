# @authzflow/core

MIT-licensed alpha authorization-state runtime maintained by Accelflow Inc. Ships prebuilt Rust/Wasm, ESM JavaScript, TypeScript declarations and a checked reader. npm consumers need no Rust compiler.

```js
import { createRuntime, createCheckedReader } from '@authzflow/core';
```

The host supplies verified sessions, clocks, an atomic durable checkpoint store, an authenticated complete-check transport, and exact content/hash callbacks. Default diagnostics are disabled. Never treat a local checkpoint or client-provided metadata as authority.

See https://github.com/Accelflow/AuthzFlow/blob/main/docs-public/getting-started.md for installation and the executable example, and https://github.com/Accelflow/AuthzFlow/blob/main/docs-public/adapters.md for the full callback contract. Node 22/24, ESM, TypeScript 5.9+ and modern secure-context WebAssembly browsers are initial targets.

Offline permissions expire at their original bounded deadline and are lost across reader/process restarts. Server-side revocation cannot instantly reach disconnected clients. Already returned plaintext, raw store bypasses, multi-owner coordination and stream recovery are outside alpha guarantees.

LICENSE and THIRD_PARTY_NOTICES.md are included; the latter contains dependency and Rust standard-library attributions and license texts. Security reporting: https://github.com/Accelflow/AuthzFlow/security/advisories/new .

Additional entrypoints: `@authzflow/core/replicas` provides editor-independent purge eligibility and completion types; `@authzflow/core/content-hash` connects explicit client/server projections to SHA-256; `@authzflow/core/testing` is an optional Node external-journal conformance suite. Hosts retain transaction, dirty-state, identity and encryption ownership. A blocked purge preserves denial and unsent changes and is not physical deletion completion.

React Native hosts use `createNativeCheckedReader` from
`@authzflow/core/native-reader` with a synchronous native JSON port. Authorization
and checkpoint transitions execute the same Rust `authzflow-core::OwnedRuntime`
as Wasm. The C ABI lives in `crates/authzflow-native`; it contains no policy engine.
The native and Wasm entries share TypeScript protocol/host orchestration.
Hosts supply prebuilt iOS/Android libraries, a native bridge, durable CAS storage,
trusted session/clock/entropy and JSON-only content. Missing/incompatible native
libraries fail closed; there is no TypeScript authorization fallback.

### Reading an existing offline grant without renewing it

`createCheckedReader(...).readCachedWithPermit()` uses the live Rust authority
from an earlier successful full check. It performs no server request and never
renews a deadline. It requires the same session context, boot, durable revision,
content hash and an unexpired `offline_ttl` grant. Cold start and `online_only`
do not supply that grant. A different cached value is rejected without destroying
the valid grant for the original content. Session/clock/revision failures fence it.
Hosts can use this for secondary cache projections; normal screen revalidation
continues to call `readWithPermit()`. It cannot turn a cached checkpoint into permission.
