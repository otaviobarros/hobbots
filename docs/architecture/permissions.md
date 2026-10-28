# Permissions and autonomy

**Decided:** autonomy-first Trusted Workspace default, enforced boundaries, exceptional approvals, narrowing delegation, separate computer permission and human approval authority.

Autonomy is how often an agent proceeds without interruption. Authority is which resources/actions it may use. High autonomy inside a narrow workspace is the default objective. Repeated confirmation for routine authorized edits/tests would violate the product direction.

## Policy presets and their decision status

Trusted Workspace is the default. The [design](../decisions/008-design.md) names the onboarding presets **Careful**, **Balanced** (Trusted Workspace, the default) and **Trusting**. Their exact policy mapping is still open.

| Mode | Intended behavior |
|---|---|
| Balanced: Trusted Workspace (default) | Autonomous work in approved directories/environments and authorized integrations; exceptional/high-impact operations require additional authority. |
| Careful | Automatic permitted investigation; modifications and consequential work request approval according to policy. |
| Trusting | Deliberately selected broad access within an explicitly chosen environment, with clear disclosure of actual runtime privileges. It never grants self-approval or Hobbots administration. |

## Effective policy

Evaluate the applicable user, executor/environment, receiving agent, thread/Quest/task and specific-action constraints as an intersection. Delegation adds task restrictions; it never unions unrelated privileges. Permission to invoke an agent is distinct from permission to access that agent's resources. Thread overrides normally narrow scope; an expansion requires a separately recorded user grant.

Resource categories include filesystem, terminal, network, Git, GitHub/external apps, browser, computer, delegation and Hobbots APIs. Keep concurrency/cost/time budgets distinct from security permissions. Evaluate Allow / Ask / Deny for a normalized operation and concrete resource, not for the model's description of intent.

## Trusted engineering example

Automatically allow authorized repository reads/searches/edits, tests/builds, local branches/commits and permitted delegation. Dependency installation is automatic only when covered by environment policy. Protected pushes/merges require additional approval under the reference policy. Personal/out-of-scope files are denied. Host desktop control requires separate explicit permission. Integrations can have standing scoped authorization, so “external” does not universally mean “ask every time”.

## Approval contract

Show the requesting agent, operation, target system/resource, concrete arguments/constraints, expected changes and impact. Bind a decision to identity, executor, action digest, resource scope, policy version, expiration and revocation. Retain durable request/decision/execution evidence.

The approval lifetimes are **just this once**, **for this Quest** and **always for this site** (a bounded standing permission, removable from Inbox history). High-risk actions offer once only and need a confirmation check box. Deny takes an optional reason that goes back to the hob. Expired or stale requests cannot be approved late; the hob asks again with fresh facts. These replace the six proposed choices (Allow once/for task/for thread, Always allow, Deny, Always deny). Exact matching and expiry mechanics must be designed before implementation. An approval for a test command is not approval for arbitrary shell commands or a changed target. Revalidate immediately before execution, and deduplicate decision/application operations.

Agents may request authority but cannot manufacture human approval, access user credentials, or call administrative grant routes. Agent MCP credentials are distinct from user sessions and limited to authorized orchestration operations. Approval denial is enforced even if the runtime continues requesting the action.

## Enforcement honesty

Hobbots-managed tools pass through the permission broker. Native runtime tools use verified provider approval/sandbox hooks or an isolated environment. Arbitrary unsandboxed shell execution can escape a nominal workspace; a system prompt is not a filesystem boundary. Each adapter declares what it can enforce, observe or cannot guarantee. Block operations requiring unavailable enforcement rather than showing a reassuring but false Trusted badge.

Credentials remain scoped to the executor or secrets provider and are excluded from messages/events. Remote routing never silently grants access to the local host. Remote user authentication, executor grants and agent tool credentials are separate boundaries.

Verify denial, grant scoping/expiry, policy changes during waits, child privilege escalation attempts, duplicate decisions, changed arguments after approval, unsupported enforcement and separate computer opt-in. Full Access does not remove application-level authentication or create administrative agent APIs.


## Agent control-plane exclusions

The agent-facing MCP control interface excludes **approval grants, credentials, deletion, and computer lifecycle operations**. Keep this boundary for agent-facing Hobbots controls: no administrative record deletion, credential administration, or creating/destroying computer environments through agent MCP credentials. Human-authorized management uses a separate user control path.

This is a control-plane restriction, not a blanket prohibition on ordinary authorized workspace edits/removals. Workspace operations still follow the concrete resource/tool policy. The optional computer viewing/control capability and its separate permission do not grant agents authority to administer host computers or their lifecycle.

## Snapshots and changing authority

Keep the original configuration/policy snapshot for provenance. A historical snapshot is not a permanent authorization grant: re-evaluate applicable current restrictions, revocations, grant expiry and action-specific approval immediately before the next effect or continuation. A newly narrowed policy cannot be bypassed by continuing an older attempt or replaying an earlier approval. Exact interruption of an already-running native tool is adapter-dependent and must be recorded honestly; new disallowed effects must be prevented.
