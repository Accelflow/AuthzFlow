# Compatibility and release policy

The initial line is `0.1.0-beta.N`. Beta APIs and checkpoint formats can change between prereleases; pin an exact version and read CHANGELOG.md before upgrading. Core and server npm packages are released together at the same version. ABI compatibility is checked at runtime; mismatch fails initialization. Do not silently downgrade or reuse a checkpoint under a different identity/authority.

Supported validation targets are Node 22/24, TypeScript 5.9+, the pinned Rust toolchain and current Chromium WebAssembly. CommonJS, edge runtimes, offline cold starts, multiple owners, and resumable server streams are outside the initial tested contract. Electron consumers must preserve the native trust boundary of their host integration; renderer checks alone are insufficient.

## Source and candidate verification

The public source checkout must pass Rust tests/Clippy, SDK/server tests, shared wire fixtures, the deterministic example, browser Wasm parity and exact archive tests. Build both archives, verify license/notices and absence of extra dependencies, scan the source and exact archives with pinned gitleaks, and install those archives in a clean consumer on Node 22 and 24.

The root LICENSE applies to AuthzFlow original source. npm archives include LICENSE, README and THIRD_PARTY_NOTICES.md. The consolidated THIRD_PARTY_NOTICES.md also contains the Rust standard-library notices in text form. Notice contents and the lockfile must be reviewed together whenever dependencies/toolchains change. Native crates remain source dependencies with explicit Git revisions for this beta.

## Public source updates

Source snapshots are proposed through a pull request to the protected main branch after source verification. Public CI must pass before a maintainer merges the proposal. Internal development history is never imported. A source update does not publish npm packages.

## Publication gates

The release workflow only publishes from the public repository, on a manually selected `v<package version>` tag, after verification, and through the protected `npm-release` Environment. It uses npm Trusted Publishing/OIDC with provenance; do not add long-lived npm tokens. Configure a trusted publisher for both package names with the exact repository, workflow filename and Environment, and verify npm account requirements before the first release. Environment and registry settings require live account readback; a successful build does not prove those settings exist.

The publisher fields are organization `Accelflow`, repository `AuthzFlow`, workflow filename `release.yml`, and Environment `npm-release`. Explicitly allow direct `npm publish` for this workflow; newly configured connections can otherwise be stage-only. Use npm CLI 11.21.1+ and Node 22.14+. A new trusted-publisher configuration must complete its first successful publish within two days, so configure it just before the authorized release. See https://docs.npmjs.com/trusted-publishers/ . The release workflow publishes with the `beta` dist-tag and also points `latest` to the same reviewed beta version. Unqualified installs therefore select the beta. Explicitly allow npm dist-tag operations for both trusted publisher configurations; direct-publish permission alone does not allow tag updates.

The protected Environment accepts `v*-beta.*` tags while retaining required maintainer approval and disallowing admin bypass. Previous alpha tags remain separate historical releases.

## First registry registration

The first release has an additional registry gate: a package must exist before a trusted publisher can be configured. See https://docs.npmjs.com/cli/v11/commands/npm-trust/ . The initial source/CI preparation does not claim those package identities or trust settings already exist.

npm supports creating a new package through non-public staging: https://docs.npmjs.com/cli/v11/commands/npm-stage/ . For initial registration, an authorized maintainer can stage a separately reviewed, distinct bootstrap version under the organization using an authenticated session, then confirm package ownership and trusted-publisher settings in the live registry before dispatching the beta workflow. Do not stage `0.1.0-alpha.1` for this purpose: staged versions reserve their semver and cannot be published again by the direct-publish workflow. Keep any bootstrap version non-public; verify what remains registered before rejecting or deleting a stage. Package creation, staging and trust configuration require explicit release authorization and are not a dry run.

The bootstrap path and npm account permissions must be confirmed live; until then the first publication is not operationally verified. Do not work around that gate by adding a long-lived CI token, publishing an unreviewed placeholder, or disabling provenance. The prepared workflow is the protected OIDC path once both package identities and trust settings are confirmed. Trust CLI setup requires npm 11.15.0+ and account 2FA, separately from the minimum CLI version for OIDC publication.

Before publication, confirm that the release tag identifies the reviewed public source and the two manifests, archives and tag have the same version. Reverify both exact archives before publishing either one. Registry writes are not atomic across two packages: on partial failure inspect the registry and verify the published integrity before resuming; never blindly overwrite or bump versions to hide a partial release.

After publication, install the exact registry versions in an empty consumer and run the same example, compare registry integrity/provenance with the verified artifacts, and create release notes listing supported scope and known limits. Until that registry readback passes, describe the result as a candidate rather than a published/accepted release.
