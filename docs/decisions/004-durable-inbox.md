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

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- A result that arrives after the delegating hob's turn ended activates that hob, which continues from it. Not proven yet: [#11](https://github.com/otaviobarros/hobbots/issues/11).
- A delivery repeated after a crash is consumed once. Not proven yet: [#11](https://github.com/otaviobarros/hobbots/issues/11).
- A promise a hob made is reconciled on completion and never closed by a final sentence alone. Not proven yet: [#11](https://github.com/otaviobarros/hobbots/issues/11).
