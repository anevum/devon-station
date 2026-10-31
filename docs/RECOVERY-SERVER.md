# Server source recovery checkpoint

This draft recovers server and synchronization modules from the DevonStation
V048R3 private development archive, along with synthetic tests. It is an
incomplete recovery: the application interface, build, release tooling,
deployment configuration and historical source lineage are not included.
It is not a verified match for the currently deployed Worker and is not a
release or deployment candidate.

The selected files exclude the archive's private snapshots, generated bundles,
deployment evidence, credentials and backups. A source identifier in a test
was replaced with a synthetic value. Test keys and data are synthetic. The
archive declared itself UNLICENSED; no license or third-party rights conclusion
is asserted by this checkpoint.

With Node.js 22 or later, run `npm test`. Tests run locally using synthetic
identities and SQLite databases; they do not contact production. These tests do
not establish live authentication, backup restoration, version parity or
production readiness. Further privacy and provenance review is required before
expanding or merging this recovery.
