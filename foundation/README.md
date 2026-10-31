# Synthetic foundation prototype

Original dependency-free Node.js contract proof. Run `npm test` with Node 22 or later. No services, deployment, existing state-schema changes, or real data are involved.

`createFoundation` accepts a trusted, already verified owner claim and synthetic scoped project projections. It checks claims on every operation; callers must never construct those claims from untrusted request bodies. This prototype has no authentication provider, persistence, cross-process concurrency control, encrypted storage, or production authorization. Approval records a decision only and executes nothing. In-memory operation retry and receipt immutability last only for the process lifetime.

`verifyImport` checks a bounded versioned JSON export, scope, structure, receipt sequence and SHA-256 checksum and returns a detached copy for independent inspection. This is not a stateful restore and does not restore retry identifiers. An unkeyed checksum detects accidental changes, not malicious replacement: signatures or authenticated encryption and trusted key management are necessary for authenticity. Export includes action summaries and source metadata; receipts intentionally omit them. This prototype is synthetic-only, not a real-data backup.

Historical recovery code, archives and graphics were not incorporated. Existing project license and inherited source rights remain unresolved; no license selection is implied by this prototype.
