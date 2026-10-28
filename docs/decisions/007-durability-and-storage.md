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
