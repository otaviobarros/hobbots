# Glossary

Domain terms used across Hobbots. Each entry points to the document that owns the concept; this list adds no requirements. Where the UI and the domain model use different words, both are given.

| Term | Meaning | Owner |
|---|---|---|
| Agent / hob | A persistent identity with versioned configuration, runtime preference, instructions and policy. The domain model says *agent*; the UI says *hob*. | [Agent model](../architecture/agent-model.md), [ADR 008](../decisions/008-design.md) |
| Retire | Archiving a hob. New dispatch stops and history stays inspectable. Bring back makes it active again. | [MVP requirements](mvp-requirements.md) (AG-006) |
| Orchestrator | A role an agent plays when it coordinates others, not a privileged runtime type. | [ADR 005](../decisions/005-agent-parity.md) |
| Thread | A durable conversation that belongs to one agent. Its `kind` is *chat* or *camp*; the UI never says thread. | [Conversations](../architecture/conversations.md), [ADR 037](../decisions/037-chat-and-camps.md) |
| Chat | A hob's one open thread, always there, for quick questions and small jobs on any topic. Start fresh replaces it and carries its open items over. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Camp | A thread with a goal of its own, made when a topic grows. Quests started there belong to it. A private camp is never captured into memory. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Chapter | One topic's run of messages in a chat or camp. Exactly one is live; a new chapter starts a new runtime session. A chapter can move into a camp and leave a stub. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Decision | A choice recorded once in a chat or camp, with who made it. A changed decision is kept, crossed out. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Artifact | What a hob makes or changes: a doc, page, email, image, code file, PR or link. The registry indexes what Attempts and Quests record and copies nothing. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Brief | A chat's or camp's "Where we are" text, written by the hub. Not the memory brief. | [ADR 037](../decisions/037-chat-and-camps.md) |
| Context pack | What a turn reads: briefs, active decisions, the artifacts index, the live chapter and one line per resting chapter, within a budget. | [ADR 037](../decisions/037-chat-and-camps.md) |
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
| Attempt | One attempt to perform task work; retries create new attempts, not new tasks. The docs no longer say *execution* ([ADR 037](../decisions/037-chat-and-camps.md)). | [Attempt lifecycle](../architecture/attempt-lifecycle.md) |
| Backpack / backpack item | A hob's durable queue of what it still has to deal with: Tasks, results, failures, questions, answers, hand-offs, messages, approval outcomes and deadlines, with separate delivery and processing states. Not your Inbox. | [Backpack contract](../architecture/inbox.md), [ADR 019](../decisions/019-hob-backpack-and-continuations.md) |
| Inbox | Your page for what needs you: approval requests and questions no lead could answer. | [Screen inventory](../design/screens-and-flows.md), [ADR 015](../decisions/015-approval-lifetimes-and-grants.md) |
| Continuation | A turn the dispatcher starts for a hob when an actionable backpack item arrives, without a prompt from you. | [ADR 019](../decisions/019-hob-backpack-and-continuations.md) |
| Responsibility | An outstanding promise, reply, deliverable or dependency that must be reconciled before success. | [Agent model](../architecture/agent-model.md), [Attempt lifecycle](../architecture/attempt-lifecycle.md) |
| Proactive closure | Agents continue and close outstanding work when results arrive, without a user prompt. | [ADR 004](../decisions/004-durable-inbox.md) |
| Approval | A human decision for one bounded action, with a lifetime (once, this Task or Quest, always for this site). | [Permissions](../architecture/permissions.md), [ADR 008](../decisions/008-design.md) |
| Trusted Workspace | The default autonomy level; the *Balanced* onboarding preset, between *Careful* and *Trusting*. | [ADR 003](../decisions/003-autonomy.md), [Permissions](../architecture/permissions.md) |
| Folders | Where hobs may work: the shared folders approved in setup, used by every hob, plus each hob's own. Paths are compared after resolving `..` and symlinks. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Sandbox / Unsandboxed | The OS sandbox Hobbots wraps around each runtime process, confining files, commands and network to the hob's policy. On by default; a hob the user runs without it is labeled *Unsandboxed*. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Charm | A connection that gives a hob abilities beyond its runtime's own tools: an integration with another app or service (GitHub, Slack, Google Drive, any MCP server). Connected once on the hub and granted per hob; runs on the hub outside the sandbox, holds its own credentials, and each action is Allow / Ask / Never. The MVP ships GitHub with Push. | [Permissions](../architecture/permissions.md), [ADR 014](../decisions/014-tool-policy-and-enforcement.md) |
| Hub action | One tool a hub tool set offers a hob (a Charm's, Local Git's, Memory's or Skills'), declared by its input, its effect (read or write) and its plan. The hub action pipeline decides, asks, records, sends and redacts every call. | [ADR 031](../decisions/031-charm-actions-and-registry.md) |
| Charm action | A hub action a Charm declares, such as `github_comment`. It plans its Charm's own request, or a built-in one the Charm declares it takes over. | [ADR 031](../decisions/031-charm-actions-and-registry.md), [Permissions](../architecture/permissions.md) |
| Charm call | One call of a Charm action. A write is recorded with a key before it is sent, so it is never sent twice by mistake. | [ADR 020](../decisions/020-github-charm.md), [ADR 031](../decisions/031-charm-actions-and-registry.md) |
| Charm site | What a grant for a Charm action names: the Charm, the operation, the folder and only the site fields the operation declares, such as a repository. Never free text such as a title or body. | [ADR 031](../decisions/031-charm-actions-and-registry.md), [ADR 015](../decisions/015-approval-lifetimes-and-grants.md) |
| Built-in Charm | A Charm written as reviewed Hobbots code, such as GitHub. Used only where the hub must hold a rule a server cannot. | [ADR 031](../decisions/031-charm-actions-and-registry.md) |
| MCP Charm | A Charm made from an MCP server you add, running outside the hub's process. Its tools are named `mcp_<server>_<tool>`. | [ADR 031](../decisions/031-charm-actions-and-registry.md) |
| Hob directory | What every hob may see of the others: a public card per hob, the roster each turn carries, and `read_hob`. | [ADR 032](../decisions/032-hob-directory.md) |
| Public card | A hob's name, role, good at, status, brain, connected Charms and who summoned it, as other hobs see them. Never its instructions, memory, threads or Tasks. | [ADR 032](../decisions/032-hob-directory.md) |
| Good at | One line, up to 200 characters, that tells other hobs when to come to a hob. Prefilled from the chores or the starter role, editable, and never part of the hob's own prompt. | [ADR 032](../decisions/032-hob-directory.md), [Agent model](../architecture/agent-model.md) |
| Roster | The short list of the other visible hobs in a turn's context block, sent again only when it changed. | [ADR 032](../decisions/032-hob-directory.md) |
| Executor | An authorized execution environment with its platform, runtime versions and boundaries. | [Agent model](../architecture/agent-model.md) |
| Hub | The one computer that runs the server, the database and every runtime connection. Hobs act only on the hub. | [ADR 010](../decisions/010-desktop-hub.md) |
| Device / client | Another desktop app or browser connected to the hub, approved once and holding a revocable token. | [ADR 010](../decisions/010-desktop-hub.md), [Deployment](../architecture/deployment.md) |
| Home | The landing page: an animated dashboard of hob activity, what needs you, Quests and usage. | [ADR 008](../decisions/008-design.md), [Design specification](../design/ui-ux.md) |
| Workbench | One Task's full view: Summary, Changes, Files, Terminal and (later) Browser, labeled by what the hub recorded. | [ADR 023](../decisions/023-workbench.md), [design specification](../design/ui-ux.md), [`packages/workbench`](../../packages/workbench/README.md) |

## Words and code names

What the UI calls a thing, and the name the code gives it. `pnpm lint:glossary` (`scripts/check-glossary.mjs`, STD-DOCS-011) reads this table and fails when they drift apart:

- a code name that no package or the server exports any more,
- a UI word that no message module of the web or desktop app uses any more,
- a word the UI never shows in a message module's copy, or a word the docs no longer use in a doc. ADRs and evidence records stay as written, and the phrases after "except" in a cell may still use it.

Change a row here in the same pull request that renames the word or the code.

| UI | Code | Never in the UI | Never in the docs |
| --- | --- | --- | --- |
| hob | `Agent` | | |
| chat, camp | `Thread` | `thread` | |
| chapter | `Chapter` | | |
| decision | `Decision` | | |
| artifact | `Artifact` | | |
| brief | `Brief` | | |
| quest | `Quest` | | |
| (not shown) | `Attempt` | `execution` | `execution` except "execution environment", "execution rules" |
