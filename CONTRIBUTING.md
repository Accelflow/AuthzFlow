# Contributing

AuthzFlow is maintained by Accelflow Inc. Contributions to original project code are offered under the MIT license. Keep changes small and provide a failing regression before a behavior fix, followed by focused and integration checks.

Use the versions in mise.toml. Build Wasm before SDK tests. Run `cargo test --locked --workspace`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `pnpm test:sdk`, `pnpm test:server`, `pnpm example`, and `pnpm test:release`. Browser parity uses `node scripts/browser-parity.mjs` after installing the browser.

Never place credentials, private endpoints, personal data, environment files or private dependencies in source, examples, tests, logs or reports. Use synthetic principals and session contexts. Keep security-sensitive reports private using SECURITY.md. Changes to authorization semantics, clock handling, persistence acknowledgements, identity separation or publication gates require regression coverage and an explanation of the trust boundary.

Public GitHub Issues are for ordinary bugs and feature discussions. Do not include cached article content, tokens or private logs. Maintainers review contributions as capacity allows; there is no promised response or support SLA for this beta.
