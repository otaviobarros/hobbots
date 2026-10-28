# ADR 005 — Uniform agent capabilities

Status: **Accepted.**

## Decision

Every agent may execute, delegate, communicate, receive and coordinate under policy. Orchestrator is a usage role rather than a special runtime class.

## Rationale

The user expects Rook to work directly, delegate a test and continue from its result just as Aldric can.

## Consequences

Apply the same contracts and limits to all agents. Role labels and avatars do not grant privileges.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.
