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
| Task | One hob's piece of work, end to end: one owner, one result, even when it takes hours. | [ADR 018](../decisions/018-tasks-and-quests.md), [Agent model](../architecture/agent-model.md) |
| Step | A part of a Task that its own hob runs in a fresh session from a short brief. Steps never make a Task a Quest. | [ADR 018](../decisions/018-tasks-and-quests.md) |
| Quest | A Task that brings in other hobs. It keeps the Task's id, card and history, and adds a goal, acceptance criteria and limits. | [ADR 018](../decisions/018-tasks-and-quests.md), [Orchestration](../architecture/orchestration.md) |
| Lead | The hob that owns a Quest: the hob you asked. You talk only to the lead. A member that brings in a hob of its own leads that subtree. | [ADR 018](../decisions/018-tasks-and-quests.md) |
| Party | The other hobs working on a Quest, shown as "Aldric's party: Quill, Ada". Members never talk to each other. | [ADR 018](../decisions/018-tasks-and-quests.md) |
| Checkpoint | A short record of where a Task stands: a planned milestone, a finding, blocker or question, or an automatic state. | [ADR 018](../decisions/018-tasks-and-quests.md) |
| Hand-off | A lead giving one Task's result to another Task as context. The only way results move between party members. | [ADR 018](../decisions/018-tasks-and-quests.md) |
| Delegation | An explicit request/result relationship from a lead to a party member, with a brief and narrowed authority. | [Orchestration](../architecture/orchestration.md) |
| Execution / attempt | One attempt to perform task work; retries create new attempts, not new tasks. | [Execution lifecycle](../architecture/execution-lifecycle.md) |
| Satchel / satchel item | A hob's durable queue of what it still has to act on: Tasks, results, failures, questions, answers, hand-offs, messages, approval outcomes and deadlines, with separate delivery and processing states. Not your Inbox. | [Satchel contract](../architecture/inbox.md), [ADR 019](../decisions/019-hob-satchel-and-continuations.md) |
| Inbox | Your page for what needs you: approval requests and questions no lead could answer. | [Screen inventory](../design/screens-and-flows.md), [ADR 015](../decisions/015-approval-lifetimes-and-grants.md) |
| Continuation | A turn the dispatcher starts for a hob when an actionable satchel item arrives, without a prompt from you. | [ADR 019](../decisions/019-hob-satchel-and-continuations.md) |
| Responsibility | An outstanding promise, reply, deliverable or dependency that must be reconciled before success. | [Agent model](../architecture/agent-model.md), [Execution lifecycle](../architecture/execution-lifecycle.md) |
| Proactive closure | Agents continue and close outstanding work when results arrive, without a user prompt. | [ADR 004](../decisions/004-durable-inbox.md) |
| Approval | A human decision for one bounded action, with a lifetime (once, this Task or Quest, always for this site). | [Permissions](../architecture/permissions.md), [ADR 008](../decisions/008-design.md) |
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
