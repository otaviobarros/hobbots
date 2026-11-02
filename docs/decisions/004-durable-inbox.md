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

- A result that arrives after the delegating hob's turn ended activates that hob, which continues from it: `[TC-IN-160]`, and after a restart between the result and the notification, `[TC-IN-162]` ([#298](https://github.com/otaviobarros/hobbots/issues/298), [evidence](../evidence/2026-11-02-durable-backpack.md)).
- A delivery repeated after a crash is consumed once: a continuation cut off after its effect is delivered again with no second Task or effect, `[TC-IN-163]`, and a claim expired while its turn stalled is reclaimed under a new fencing token, `[TC-IN-164]`. Thirty routine updates cause no turn of their own, `[TC-IN-161]`, and exhausted retries become a blocker, `[TC-IN-165]` ([#298](https://github.com/otaviobarros/hobbots/issues/298)).
- A promise a hob made is reconciled on completion and never closed by a final sentence alone. Not proven yet: [#11](https://github.com/otaviobarros/hobbots/issues/11).
