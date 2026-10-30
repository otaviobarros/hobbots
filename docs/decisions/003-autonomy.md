# ADR 003 — Trusted Workspace autonomy by default

Status: **Accepted.**

## Decision

Use Trusted Workspace as the default with routine autonomous authorized work, scoped authority and exceptional approvals. Careful and Trusting presets sit on either side of it; [ADR 014](014-tool-policy-and-enforcement.md) maps all three onto the MVP operations.

## Rationale

Frequent permission prompts obstruct the intended independent work loop. Enforced narrow authority enables useful autonomy.

## Consequences

Policies must be enforceable through runtime hooks or isolation. Delegation narrows authority; agents cannot grant human approval or user administration access.

## Change control

A deliberate user-directed change should update the relevant specification and supersede this ADR with rationale.
