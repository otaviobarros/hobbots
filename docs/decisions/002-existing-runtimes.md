# ADR 002 — Host existing agent runtimes

Status: **Accepted.**

## Decision

Integrate Codex App Server, a supported Claude Code CLI/SDK route and an ACP adapter boundary instead of building a new model/agent reasoning engine.

## Rationale

The product value is coordination, persistence, authority and visibility around capable existing engines.

## Consequences

Normalize domain events and capabilities. Verify each runtime/version; ACP compatibility does not imply identical tools or native orchestration.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- A turn streams, completes and stores its session, and the next turn resumes it: `[TC-CH-001]`, with the fake runtime. On the Claude Code installed on the host, hobs replied and resumed their threads in [the multi-hob record](../evidence/2026-10-30-multi-hob.md), a manual run.
- A missing or signed-out Claude Code blocks setup and shows its fix, in a browser against a hub from source: `[TC-AG-009]`, `[TC-AG-010]`. An outdated Claude Code is not proven yet: no test covers it.
- A second runtime (Codex) runs a hob through the same adapter contract, with its own verified capabilities. Not proven yet: [#12](https://github.com/otaviobarros/hobbots/issues/12).
