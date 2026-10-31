# ADR 001 — Effect TS v4 application foundation

Status: **Accepted.**

## Decision

Adopt Effect v4 for HTTP/API, Schema, typed errors, services/Layers, concurrency, streams, resource management and SQL integration. Model domain lifecycles with explicit pure transition functions and transactional services. Exclude XState, Hono and Fastify.

## Rationale

A single coherent backend foundation reduces competing lifecycle and infrastructure abstractions while retaining explicit state guarantees.

## Consequences

Isolate unstable HttpApi/Workflow APIs behind internal modules, pin compatible versions at implementation time, and retain persistent recovery. Effect concurrency alone does not make jobs durable.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Every migration applies in order through the Effect migrator on an empty database: `[TC-DP-003]`.
- A reply that a process exit interrupts is recovered as interrupted on the next start, not left running: `[TC-CH-004]`.
- Invalid input to the API returns a typed error and changes nothing: `[TC-AG-003]`.
