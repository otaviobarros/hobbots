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

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- Under Balanced, a hob edits files and runs tests in its folders without asking: `[TC-PE-012]`.
- A call outside the hob's folders is refused whatever the prompt says: `[TC-PE-013]`, `[TC-PE-020]`.
- An Ask operation waits for the user's decision in chat. Not proven yet: [#133](https://github.com/otaviobarros/hobbots/issues/133), [#137](https://github.com/otaviobarros/hobbots/issues/137).
- Delegation narrows authority and a hob cannot approve on the user's behalf. Not proven yet: [#10](https://github.com/otaviobarros/hobbots/issues/10).
