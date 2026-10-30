# Glossary

Domain terms used across Hobbots. Each entry points to the document that owns the concept; this list adds no requirements. Where the UI and the domain model use different words, both are given.

| Term | Meaning | Owner |
|---|---|---|
| Agent / hob | A persistent identity with versioned configuration, runtime preference, instructions and policy. The domain model says *agent*; the UI says *hob*. | [Agent model](../architecture/agent-model.md), [ADR 008](../decisions/008-design.md) |
| Retire | Archiving a hob. New dispatch stops and history stays inspectable. | [MVP requirements](mvp-requirements.md) (AG-006) |
| Orchestrator | A role an agent plays when it coordinates others, not a privileged runtime type. | [ADR 005](../decisions/005-agent-parity.md) |
| Thread | A durable user conversation that belongs to one agent. | [Conversations](../architecture/conversations.md) |
| Session | The binding to an underlying runtime conversation or connection. It may change during recovery and never replaces domain identity. | [Conversations](../architecture/conversations.md) |
| Runtime / adapter | An existing agent engine (Claude Code, Codex, ACP-compatible) and the capability-aware adapter that hosts it. | [Runtime adapters](../architecture/runtime-adapters.md), [ADR 002](../decisions/002-existing-runtimes.md) |
| Quest | A durable objective with acceptance criteria, ownership and an aggregate outcome; spans threads and agents. | [Agent model](../architecture/agent-model.md) |
| Task | A unit of responsibility inside a Quest, with owner, dependencies and completion conditions. | [Agent model](../architecture/agent-model.md) |
| Delegation | An explicit request/result relationship between a sender and a recipient agent. | [Orchestration](../architecture/orchestration.md) |
| Execution / attempt | One attempt to perform task work; retries create new attempts, not new tasks. | [Execution lifecycle](../architecture/execution-lifecycle.md) |
| Inbox / inbox item | A durable per-agent queue of tasks, messages, questions, results and outcomes, with separate delivery and processing states. | [Inbox](../architecture/inbox.md), [ADR 004](../decisions/004-durable-inbox.md) |
| Responsibility | An outstanding promise, reply, deliverable or dependency that must be reconciled before success. | [Agent model](../architecture/agent-model.md), [Execution lifecycle](../architecture/execution-lifecycle.md) |
| Proactive closure | Agents continue and close outstanding work when results arrive, without a user prompt. | [ADR 004](../decisions/004-durable-inbox.md) |
| Approval | A human decision for one bounded action, with a lifetime (once, this Quest, always for this site). | [Permissions](../architecture/permissions.md), [ADR 008](../decisions/008-design.md) |
| Trusted Workspace | The default autonomy level; the *Balanced* onboarding preset, between *Careful* and *Trusting*. | [ADR 003](../decisions/003-autonomy.md), [Permissions](../architecture/permissions.md) |
| Folders | Where hobs may work: the shared folders approved in setup, used by every hob, plus each hob's own. Paths are compared after resolving `..` and symlinks. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Sandbox / Unsandboxed | The OS sandbox Hobbots wraps around each runtime process, confining files, commands and network to the hob's policy. On by default; a hob the user runs without it is labeled *Unsandboxed*. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Charm | A connection that gives a hob abilities beyond its runtime's own tools: an integration with another app or service (GitHub, Slack, Google Drive, any MCP server). Connected once on the hub and granted per hob; runs on the hub outside the sandbox, holds its own credentials, and each action is Allow / Ask / Never. The MVP ships GitHub with Push. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Executor | An authorized execution environment with its platform, runtime versions and boundaries. | [Agent model](../architecture/agent-model.md) |
| Hub | The one computer that runs the server, the database and every runtime connection. Hobs act only on the hub. | [ADR 010](../decisions/010-desktop-hub.md) |
| Device / client | Another desktop app or browser connected to the hub, approved once and holding a revocable token. | [ADR 010](../decisions/010-desktop-hub.md), [Deployment](../architecture/deployment.md) |
| Home | The landing page: an animated dashboard of hob activity, what needs you, Quests and usage. | [ADR 008](../decisions/008-design.md), [Design specification](../design/ui-ux.md) |
| Quest / Inbox / Workshop tabs | The three tabs of the chat workspace's right panel. Workshop is a live scene that links to the Workbench. | [ADR 008](../decisions/008-design.md) |
| Workbench | The full view of authorized tool activity, previews, artifacts and diffs, labeled by what the runtime can actually show. | [Design specification](../design/ui-ux.md), [`packages/workbench`](../../packages/workbench/README.md) |
