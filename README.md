# AuthzFlow

AuthzFlow is developed and maintained by [Accelflow Inc.](https://accelflow.jp/) and licensed under MIT.

This beta provides authorization-state checks for application-managed cached reads. The server remains the authorization authority. A Rust/Wasm runtime fences reads until a verified checkpoint is durably committed, and a TypeScript checked reader connects complete checks, identity, content integrity and bounded offline access.

- `@authzflow/core`: prebuilt Wasm, TypeScript SDK and checked reader.
- `@authzflow/server`: Node complete-check provider; no Rust build required on installation.
- `authzflow-server`: native Rust provider for existing Rust APIs, using the same wire contract.

## Start

Read [Getting started](docs-public/getting-started.md), [architecture](docs-public/architecture.md), [protocol](docs-public/protocol.md), and [adapter responsibilities](docs-public/adapters.md).

Build from a public source checkout:

```sh
mise exec -- pnpm install --frozen-lockfile --ignore-scripts
mise exec -- rustup target add wasm32-unknown-unknown
mise exec -- cargo install wasm-bindgen-cli --version 0.2.129 --locked
mise exec -- pnpm build:wasm
mise exec -- pnpm build:sdk
mise exec -- pnpm build:server
mise exec -- pnpm example
```

The example verifies complete checks, one minute of bounded offline access, exact expiry, and persistent denial using synthetic sessions and in-memory storage. It does not implement a production identity provider or database.

## Beta scope

Integration acceptance includes a desktop application in an isolated single-user, single-resource test profile: online checks, bounded offline access, expiry, reconnection and revocation cleanup. This does not establish production-wide or long-duration validation.

Node 22 and 24, ESM, TypeScript 5.9+, and modern browsers with secure contexts and WebAssembly are the initial targets. Rust builds use the pinned toolchain in `mise.toml`. Native Rust APIs can use a pinned public Git revision; crates.io distribution is not part of this beta release.

Only authenticated complete checks are connected by the checked reader. Change-stream recovery, durable server cursors, offline cold start and multi-owner coordination are outside this beta contract. The core batch API is lower-level and requires a host protocol that supplies ordering and recovery.

Offline revocation may take until the original permit expires. The runtime cannot recall plaintext already returned or guard code that bypasses it. See [security](SECURITY.md), [compatibility and release policy](docs-public/releasing.md), [contributing](CONTRIBUTING.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
