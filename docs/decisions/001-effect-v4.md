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
