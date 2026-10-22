# Getting started

This is an alpha. Registry commands below become usable after the maintainers publish the release; the source example and local tarball flow work before publication.

```sh
npm install @authzflow/core@0.1.0-alpha.8 @authzflow/server@0.1.0-alpha.8
```

The packages ship ESM JavaScript and declarations. Core also ships compiled Wasm; npm consumers do not need Rust. Node 22 and 24 are initial supported runtimes. Use TypeScript 5.9 or newer. Browser use requires WebAssembly, cryptographic randomness in a secure context, and an application bundler capable of serving the Wasm asset.

## Run the complete example from source

Install the tool versions in `mise.toml`, then:

```sh
mise exec -- pnpm install --frozen-lockfile --ignore-scripts
mise exec -- rustup target add wasm32-unknown-unknown
mise exec -- cargo install wasm-bindgen-cli --version 0.2.129 --locked
mise exec -- pnpm build:wasm
mise exec -- pnpm build:sdk
mise exec -- pnpm build:server
mise exec -- pnpm example
```

Expected output: `PASS: complete check, bounded offline read, exact expiry and durable denial`.

The example calls the real server provider and real Wasm SDK through an in-process Response transport. Its clock advances deterministically, so the one-minute expiry test finishes immediately. Session verification and atomic storage are synthetic. Replace these with your product adapters before deployment; see [adapter contracts](adapters.md).

## Install local release candidates into a clean consumer

```sh
mkdir -p test-results/npm
npm pack ./packages/core --ignore-scripts --pack-destination test-results/npm
npm pack ./packages/server --ignore-scripts --pack-destination test-results/npm
node public-tools/verify-release.mjs test-results/npm
node public-tools/consumer-smoke.mjs test-results/npm
```

The smoke test installs only the two tarballs in an empty directory, then exercises the complete example. No repository source imports or Rust compiler are used by that consumer.

## Node Wasm loading

```js
import { readFile } from 'node:fs/promises';
import { createCheckedReader } from '@authzflow/core';
const wasmBytes = new Uint8Array(await readFile(
  new URL('../wasm/authzflow_wasm_bg.wasm', import.meta.resolve('@authzflow/core'))
));
// Pass wasmBytes plus your host adapters to createCheckedReader.
```

For a bundler, copy the package's Wasm asset to a public static asset location and pass its fetched Uint8Array as `wasmBytes`. Serve it from your trusted application deployment. Do not derive the asset or authority URL from untrusted content. The raw runtime can also use the default generated Wasm module URL when the bundler preserves that relationship.

Read [protocol](protocol.md) and [security limits](../SECURITY.md) before enabling offline reads. Offline permission is retained only in the current reader instance; reopening the app requires a successful server check.
