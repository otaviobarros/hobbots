# Security standards

Rules for permissions, authority and untrusted input. Read the [permissions contract](../architecture/permissions.md) and [ADR 014](../decisions/014-tool-policy-and-enforcement.md) before you change them.

### STD-SEC-001 Hobs default to Trusted Workspace autonomy

A new hob works with Trusted Workspace autonomy unless its policy says otherwise.

- **Why:** hobs do useful work without constant approvals, inside limits the user set. See [ADR 003](../decisions/003-autonomy.md).
- **Enforced by:** review.
- **Applies to:** `packages/permissions`, `packages/agents`.

### STD-SEC-002 Permissions are enforced at real boundaries

Enforce each permission with a real runtime or environment boundary: the sandbox, the runtime's own permission mode or the tool policy engine. Text in a prompt is guidance for the model, never enforcement.

- **Why:** a model can ignore a prompt, but it cannot cross a sandbox.
- **Enforced by:** permission-enforcement tests (STD-TEST-002) and review.
- **Applies to:** `packages/permissions`, `packages/runtimes`.

### STD-SEC-003 Delegation never widens authority

A hob that delegates work gives the receiver at most its own authority. Delegation can narrow a policy and never widen it.

- **Why:** otherwise a chain of delegations escalates privileges.
- **Enforced by:** permission-enforcement tests and review.
- **Applies to:** `packages/orchestration`, `packages/permissions`.

### STD-SEC-004 Hobbots MCP controls exclude administrative powers

The Hobbots MCP tools never grant approvals, manage credentials, delete records administratively or start, stop or remove computers.

- **Why:** a hob must not approve its own requests or raise its own authority. The [permissions contract](../architecture/permissions.md) lists the exclusions.
- **Enforced by:** deciding approvals and revoking grants require a user session that only the hub's user-session middleware provides, and a test fails when other code names it (`[TC-PE-112]`); review.
- **Applies to:** the Hobbots MCP server.

### STD-SEC-005 Patterns on untrusted text run in linear time

A regular expression that reads text from outside the code, such as a hob's tool input, a model's output, a Git remote, a file or an HTTP answer, must not backtrack. Two repeated parts that can match the same characters next to each other, such as `/\/+$/`, `/\s*x?\s*$/` or `(a+)+`, take polynomial or exponential time on a long run of those characters. Cut ends with string methods (`endsWith`, `slice`, `trim`, a loop) instead, and test a pattern on a trimmed value so no two runs of spaces meet.

```ts
// ❌ quadratic on a remote ending in many slashes
const trimmed = remote.replace(/\/+$/, "");
// ✅ linear
const trimmed = trimTrailingSlashes(remote);
```

- **Why:** one crafted string can stall the hub or the browser for every hob and person on it.
- **Enforced by:** CodeQL code scanning on every pull request (`js/polynomial-redos`, `js/redos`) and review.
- **Applies to:** all code.
