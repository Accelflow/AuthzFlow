# @authzflow/server

MIT-licensed alpha complete-check provider maintained by Accelflow Inc. Ships ESM JavaScript and TypeScript declarations, with no runtime dependencies or Rust build required.

```js
import { createCheckProvider } from '@authzflow/server';
```

Connect existing authentication and authorization with the async `authenticate` and `authorize` callbacks. The provider creates metadata-only request-bound responses, cryptographic epochs, no-store headers and server-selected offline policy. It never replaces product ACLs or logs credentials. Default read policy is online-only; offline configuration uses minutes.

See https://github.com/Accelflow/AuthzFlow/blob/main/docs-public/adapters.md and https://github.com/Accelflow/AuthzFlow/blob/main/docs-public/protocol.md for callback and wire contracts. Node 22/24 and TypeScript 5.9+ are initial targets. Native Rust servers can use the companion authzflow-server source crate with the same wire fixtures.

The checked reader in @authzflow/core validates these responses before returning content. Always keep authorization on ordinary product content APIs. Reliable event streams and cursor recovery are outside this complete-check alpha.

LICENSE and THIRD_PARTY_NOTICES.md are included. Security reporting: https://github.com/Accelflow/AuthzFlow/security/advisories/new .
