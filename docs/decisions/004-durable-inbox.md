# ADR 004 — Durable inbox and proactive closure

Status: **Accepted.**

## Decision

Persist messages, responsibilities, results and continuation obligations; separate delivery, acknowledgement and consumption; activate responsible agents on meaningful outcomes.

## Rationale

A model turn may finish before delegated work returns. Results and promises must not disappear or require manual forwarding.

## Consequences

At-least-once delivery requires idempotency, batching, durable scheduling and recovery. Completion reconciles obligations rather than trusting a final sentence.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.
