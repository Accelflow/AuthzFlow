# AuthzFlow contracts

This directory contains consumer-facing, versioned integration contracts. It is
eligible for reviewed public export; internal research and operational evidence
remain in `docs/`. Implementation lives in `crates/` and `packages/`.

| Contract | Source of truth and executable checks |
| --- | --- |
| [Resource Group v2](resource-group/v2/README.md) | Rust wire types and transitions in `crates/authzflow-core/src/group.rs`; shared [fixtures](resource-group/v2/fixtures.json); Rust and SDK conformance tests |
| [Cached batch v1](cached-batch/v1/README.md) | `ResourceAuthority.readCachedManyWithPermit`; SDK authority contracts |
| [Coordination port v1](coordination/v1/README.md) | `GroupCoordinationStorage` and `ResourceGroupCoordinator`; real SQLite/IndexedDB and multi-owner contracts |

Existing complete-check v1 and resource feed remain documented in
[the protocol](../docs-public/protocol.md). They are not silently replaced by
Resource Group v2. Application content CRUD authorization remains the product's
responsibility.

Keep wire field names, limits, errors, fixtures, compatibility and conformance
checks together. Rust validates group transitions; TypeScript exports the host
port types. Do not introduce a second schema validator that grants access.
Contract changes must update implementation and shared fixture tests in the same
change. A new incompatible format needs a new version. Presence in this source
tree does not imply registry publication or deployment.
