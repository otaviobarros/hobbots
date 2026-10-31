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

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Any hob, not only a designated orchestrator, can work directly, delegate and continue from the result. Not proven yet: [#10](https://github.com/otaviobarros/hobbots/issues/10).
- A hob's role changes what it is told, never what it may do: `[TC-AG-083]`, and the policy is the same for every role: `[TC-PE-001]`.
