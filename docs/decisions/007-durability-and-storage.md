# ADR 007 — SQL persistence and capability-aware recovery

Status: **Accepted**; the storage choice is superseded by [ADR 011](011-sqlite-storage.md).

## Decision

Use SQLite locally and PostgreSQL remotely. Preserve attempts, events, inbox, approvals and responsibility state. Implement durable workflows/persistent execution behind domain interfaces.

## Rationale

Work must survive UI changes and process interruption while exposing actual runtime recovery limits.

## Consequences

Transactional delivery obligations, expected versions, leases and reconciliation are required. No universal exactly-once external effects or transparent arbitrary-tool resume guarantee.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Hobs, threads and messages round-trip on SQLite and PostgreSQL: `[TC-DP-004]`, run on both in CI.
- A reply interrupted by a process exit is shown as interrupted after a restart, and nothing is duplicated after reconnecting. Not proven yet: [#118](https://github.com/otaviobarros/hobbots/issues/118).
- Messages queued before a restart start in order afterwards: `[TC-CH-007]`, `[TC-CH-013]`.
