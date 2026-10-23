# Changelog

## 0.1.0-beta.1

- Promote the reviewed alpha.8 implementation to beta without changing runtime behavior.
- Align npm and Rust workspace versions and publish paired packages under the beta dist-tag.
- Preserve the tested integration scope and existing security limitations.
- Include consolidated Markdown third-party notices in both npm packages; no HTML notices.

## 0.1.0-alpha.8

- Add immutable, bounded resource state snapshots and subscriptions with expiry and failure reasons.
- Add strict `revalidate()` for change catch-up plus a fresh online permit; existing read APIs remain compatible.
- Fence late grant results and serialize granted/denied host effects so a delayed grant cannot overtake revocation cleanup. Failed grant effects cannot leave a usable secondary permit.
- Connect opt-in, bounded coordinator and Rust runtime diagnostics without content, identifiers, credentials, cursors or raw errors.
- Expand the shared Wasm/native contract for ACK/disconnect, delayed responses, expiry, session switches, observers and durable revoke races.
- Keep pending checks active through asynchronous denial cleanup, preventing strict retries from starving host storage on an already-rejected inner promise.
- Add a native-only coordinator entry with no Wasm loader/import.meta dependency for Hermes.
- Align the server version; no server behavior change. Published as paired npm packages with provenance.

## 0.1.0-alpha.7 (unpublished)

- Generic resource authority combines real Rust readers and durable change recovery with isolated CAS namespaces.
- Explicit host-owned projection proof retains original offline leases through ACK/disconnect races; cached reads cannot join a pending full check.
- Dirty purge does not block other resources; fresh authenticated snapshots precede regrant.
- Native runtime/reader, clone and entropy ports support JSON-only hosts without browser globals.
- Public resource-authority and content-hash conformance suites; Wasm/native parity and existing replica suite retained.
- Server version aligned for coordinated candidate packaging; no npm publication or public synchronization implied.

## 0.1.0-alpha.4 (unpublished)

- Use the same Rust OwnedRuntime through a thin native C ABI for iOS/Android.
- Share runtime host orchestration between native and Wasm; add native checked reader.
- Remove the separate TypeScript lease engine introduced in unpublished alpha.3.

## 0.1.0-alpha.3 (unpublished)

- Add a Hermes-compatible, server complete-check lease reader without Wasm/browser globals.
- Share checked-reader validation and persist initial denial before any successful grant.
- Keep cold restart, session, expiry, hash and CAS fences identical across reader entries.

## Core 0.1.0-alpha.2 — candidate

- Editor-independent replica purge eligibility and an external-journal contract.
- Explicit blocked purge outcomes with durable-denial retry in the change consumer.
- Optional Node conformance suite covering real journal isolation, dirty states, rollback and reopen.
- Shared content hash adapter with explicit projection, UTF-8 and browser/Node SHA-256 parity.

The server package version is aligned to 0.1.0-alpha.2 for the coordinated release guard; its implementation is unchanged. These candidate artifacts are not a publication claim.

## 0.1.0-alpha.1 — candidate

- MIT-licensed Rust authorization-state core, prebuilt Wasm and TypeScript SDK.
- Framework-neutral Node and native Rust complete-check providers with shared wire fixtures.
- Checked reader connecting nonce/identity/content checks, durable CAS and bounded offline policy.
- Fail-closed commit acknowledgements, expiry/session fences and optional diagnostic events.
- Reproducible source build, executable example, exact archive checks and clean consumer smoke tests.

This is a release candidate until public source synchronization, protected publication and registry readback have completed. See SECURITY.md and docs-public/releasing.md for limits and compatibility.
