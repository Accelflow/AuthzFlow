# Security policy

AuthzFlow is an alpha authorization-state runtime maintained by Accelflow Inc. The current supported security-update line is the newest `0.1.0-alpha.N`; older prereleases are not maintained independently.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting for this repository: https://github.com/Accelflow/AuthzFlow/security/advisories/new . Do not file a public issue containing exploit details, credentials, cached content or customer data. The private reporting feature must be enabled by maintainers before the first public release. If the form is unavailable, request a private reporting channel through a content-free public issue; do not disclose details there.

Include affected exact version and runtime, a minimal synthetic reproduction, expected and observed behavior, and whether the problem crosses an identity, scope, expiry, persistence or publication boundary. Maintainers acknowledge and investigate as capacity allows; this alpha has no response-time or production-support SLA.

## Supported security boundary

The server remains authoritative and must authenticate and authorize content APIs. The host must verify its session, isolate checkpoint stores, implement durable atomic CAS, provide reliable clocks, hash the actual returned content and route every protected read through the runtime. A browser or malicious client can bypass local application code; this is not DRM or protection against a user controlling their device.

Offline access can continue until the originally granted deadline after a server-side revocation. Already returned plaintext and external copies cannot be recalled. Offline cold starts, multiple uncoordinated owners, and reliable recovery of a server event stream are outside this alpha contract. Do not infer those guarantees from the lower-level batch API.

Diagnostic events are disabled by default. Opt-in events contain fixed codes and numeric measurements, but applications must independently protect their HTTP logs and their own adapter errors. Report a possible bypass privately rather than relying on a passing test suite as a security audit.
