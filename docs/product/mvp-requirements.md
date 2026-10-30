# MVP requirements

These are the MVP requirements and their acceptance conditions. Numerical defaults remain open.

## Agent management

| ID | Requirement | Acceptance condition |
|---|---|---|
| AG-001 | Create agents with name, avatar, runtime, supported model, instructions and environment. | Two agents using different installed runtimes can be configured without copying messages between them. |
| AG-002 | Version configuration. | A running attempt retains its original configuration/policy snapshot for audit; current restrictions and revocations still govern new effects. |
| AG-003 | Configure delegation collaborators independently of identity and class. | A disallowed destination is rejected by the server; a role label never grants access. |
| AG-004 | Configure tools, workspace, permissions, and execution limits separately from prompts. | A prompt cannot expand the effective policy. |
| AG-005 | Show runtime installation, authentication and health. | Missing or incompatible runtimes show actionable state rather than a fabricated connected status. |
| AG-006 | Retire hobs while preserving history. | Retire asks whether to hand active work to another hob, let it finish or stop it; new dispatch is then prevented, nothing is deleted and the hob stays inspectable under Archived hobs. |

In the UI agents are called **hobs** ([ADR 008](../decisions/008-design.md)); these documents keep "agent" for the domain model. Agent templates (hob kinds) and optional specialization/default skills support onboarding. Exact template content and portable configuration format are open.

## Conversations

| ID | Requirement | Acceptance condition |
|---|---|---|
| CH-001 | Multiple persistent threads per agent. | Messages and thread metadata remain after server restart. |
| CH-002 | Thread identity links agent, title, session binding and timestamps. | Domain IDs remain stable when runtime sessions change. |
| CH-003 | Switch agents and threads without canceling work. | Each agent restores its last selected thread; work stays visible from the execution panel. |
| CH-004 | Stream assistant output, tool activity and status. | Reconnection reconstructs a snapshot and continues from a durable cursor without duplicated messages. |
| CH-005 | Link threads to Quests, tasks and results. | A Quest can be inspected independent of its initiating thread. |
| CH-006 | Search thread titles and persisted messages. | Results link back to their owning agent/thread. |
| CH-007 | Stop a turn without deleting its thread. | Cancellation request and confirmed outcome are distinguishable. |
| CH-008 | Messages sent while a thread's reply runs, or while its hob is paused, wait in a durable per-thread queue. | Queued messages start one turn at a time in the order sent, also after a restart and once a paused hob wakes; each can be removed before it starts or sent now, which stops the running reply. |

Thread forking with context snapshots is an open extension.

## Quests and delegation

| ID | Requirement | Acceptance condition |
|---|---|---|
| OR-001 | Every agent executes and delegates asynchronously. | A parent continues its own authorized work while children run. |
| OR-002 | Parallel and nested delegation with explicit lineage. | Aldric → Rook → Pip and Aldric → Sage are persisted and visible. |
| OR-003 | Structured requests/results plus conversational questions. | A question and its answer retain sender, recipient, task/delegation correlation. |
| OR-004 | Explicit waits, dependencies and ownership. | The UI shows who owes a response, age, acknowledgement, timeout and intervention options. |
| OR-005 | Enforce concurrency, depth, time and available usage budgets. | Recursive or cyclic requests cannot bypass scheduler limits. Exact values remain configurable/open. |
| OR-006 | Per-task and Quest cancellation with recorded propagation. | Children report confirmed outcomes or an explicit unresolved state; cancellation is not merely optimistic UI. |
| OR-007 | Inspect tasks and request allowed interventions. | Messages, retry, cancellation and reassignment are policy-checked and auditable. |

## Inbox and proactive closure

| ID | Requirement | Acceptance condition |
|---|---|---|
| IN-001 | Durable per-agent inbox for tasks, messages, questions, progress, results, failures and system/approval outcomes. | Persist before attempting delivery; recipient downtime does not lose responsibility. |
| IN-002 | Separate pending, delivered, acknowledged, processing, resolved and failed states. | Transport delivery cannot be reported as consumption. |
| IN-003 | At-least-once delivery with idempotent processing. | Redelivery cannot duplicate a task or an already-recorded effect. |
| IN-004 | Schedule continuations for actionable events. | A result arriving after a parent turn ends triggers authorized continuation without user prompting. |
| IN-005 | Batch and deduplicate updates. | Thirty routine progress updates do not spawn thirty model turns; they still update visibility. |
| IN-006 | Durable responsibility ledger and completion checks. | Required children, questions, deliverables and approvals are reconciled before success. |
| IN-007 | Visible blocked/failure outcomes. | Exhausted retries, missing authority or an unavailable runtime produces a durable blocker and next action, not silent abandonment or endless turns. |

## Execution and recovery

| ID | Requirement | Acceptance condition |
|---|---|---|
| EX-001 | Separate tasks from execution attempts. | Retrying one task produces multiple inspectable attempts with runtime, executor, session and outcome. |
| EX-002 | Validated explicit transitions and typed failures. | An illegal transition or stale state version is rejected without partial status updates. |
| EX-003 | Reconcile after restart/disconnection. | Unknown live outcomes are shown as unverified until reconciled; unsafe side effects are not blindly replayed. |
| EX-004 | Bounded retries and timeout handling. | Failures retain evidence and retry history; irreversible uncertain actions require reconciliation. |
| EX-005 | UI lifecycle independent of execution. | Closing a browser or the desktop window does not stop server work; only quitting the hub's background service does. A user who turns off "Keep running in the menu bar" makes closing the hub's last window a Quit, after a warning when hobs are working. |
| EX-006 | Persist result and notify parent reliably. | A crash between completion and notification cannot permanently lose the result or continuation. |

## Permissions and autonomy

| ID | Requirement | Acceptance condition |
|---|---|---|
| PE-001 | Trusted Workspace default, offered as the Balanced preset. | Onboarding offers Careful, Balanced and Trusting; Balanced is preselected. Under it, reads, scoped edits, tests/builds, authorized local Git work and delegation proceed without repetitive approvals. |
| PE-002 | Evaluate Allow / Ask / Deny under effective scope. | Out-of-scope personal files are denied; desktop control needs separate explicit permission. |
| PE-003 | Scoped exceptional approvals. | Protected pushes/merges or other high-impact actions show exact action, target, constraints and requesting agent. |
| PE-004 | Delegation narrows rather than combines authority. | A sender cannot manufacture resource access for a child. |
| PE-005 | Real runtime/environment enforcement. | Unsupported enforcement is visible and an operation needing that guarantee is blocked rather than falsely labeled safe. |
| PE-006 | Restrict agent-facing Hobbots controls. | Hobbots MCP credentials cannot grant approvals, administer credentials, delete administrative records, or control computer lifecycle; scoped workspace tools remain separately policy-checked. |
| PE-007 | Durable approval decisions with three lifetimes. | Approvals offer just this once, for this Quest, or always for this site; high-risk actions offer once only with a confirmation check box. Duplicate submission does not repeat the action; grants are tied to scope and expire/revoke predictably; expired requests cannot be approved late. |
| PE-008 | Re-evaluate current authority before new effects. | An old attempt snapshot, queued continuation or stale approval cannot bypass a later restriction or revocation. |

The onboarding presets are Careful, Balanced (Trusted Workspace, the default) and Trusting; their policy mapping is in the [permissions contract](../architecture/permissions.md) and [ADR 014](../decisions/014-tool-policy-and-enforcement.md). Resource policy can authorize integrations in advance; all external actions are not automatically subject to a new prompt.

## UI, Workbench and deployment

| ID | Requirement | Acceptance condition |
|---|---|---|
| UX-001 | Home landing page plus the chat workspace: rail, hob and thread panel, chat, and a right panel with Quest, Inbox and Workshop tabs; independent side-panel collapse. | Home shows what needs you and what is running; chat opens on the last thread one click away, and parallel work and messages can be inspected without leaving the parent chat. |
| UX-002 | On-demand Workbench for browser, computer, terminal, files and code. | Task selection opens relevant supported activity; live, screenshot, historical and unavailable states are labeled honestly. |
| UX-003 | Hobbots visual language. | The tokens, type, pixel corners, stepped motion and components of the design specification are used; all text passes WCAG AA, every animation stops with Reduce motion, and there are no decorative left-edge accent borders. |
| UX-004 | Durable execution visibility. | Owners, dependencies, acknowledgement, progress, artifacts, blockers and approvals agree with server records. |
| UX-005 | Supporting screens follow the MVP design. | Welcome, Where Hobbots runs, onboarding, new device approval, Summon, hob profile and Retire, Inbox and approvals, Usage and Settings have the entry points, contents and states listed in the screen inventory. |
| UX-006 | Preserve navigation and inspection context. | Return to the parent conversation, retain a pinned Quest, and switch Workbench views without losing relevant panel state; thread navigation supports a keyboard path. |
| RT-001 | Provider adapters for Claude, ChatGPT (Codex), Gemini, Grok, local models and OpenAI-compatible keys; ACP-compatible foundation. | Different providers participate in the same persisted delegation loop; each provider is offered only once its adapter is verified, and an unverified one shows an honest unavailable state. |
| DP-001 | One hub server with browser and desktop clients. | Every client observes the same durable records; no client is a second state owner, and hobs act only on the hub. |
| DP-002 | Run Hobbots here or connect to another computer. | The first setup step offers both; a connected desktop runs no local server and gets the full experience of the hub. |
| DP-003 | One SQLite database per installation; PostgreSQL-compatible SQL. | Persistence and recovery scenarios pass on SQLite, and the same suites pass on PostgreSQL in CI. |
| DP-004 | Remote access over Tailscale with device approval. | Off by default; when on, only the hub and the tailnet can connect, each new device needs Allow on the hub once, and a revoked device is refused. |

## Release boundaries

P0: persistent hobs (agents) and threads, the provider adapters of RT-001, ACP boundary, durable Quests/inbox/continuations, parallel/nested work, policy and approvals, visibility, terminal/files/diffs and supported browser previews, browser-based server, Electron and self-hosted foundation. Tailscale is the MVP remote route; other routes follow the MVP.

P1 extensions: broader individually validated ACP/CLI agents, generalized computer observation/takeover and rich replay, further connection routes (relay, local network with HTTPS, public HTTPS, server install), the mobile app. The fourth Workbench surface is decided; universal remote desktop functionality is not a P0 promise.

Deferred: organizations/RBAC, marketplace publishing, native mobile app, advanced long-term memory, recurring automations, visual workflow builders, billing, independently writable installation synchronization, fully autonomous multi-computer control. A responsive web view does not commit to a native mobile client.

## Onboarding and release operations

Vendor login methods, telemetry backend, backup format and templates still require technical design.

| ID | Requirement | Acceptance condition |
|---|---|---|
| OP-001 | Guided local installation and runtime setup. | A new user detects installed runtimes, follows supported authentication, selects an environment, creates agents manually/from a template and starts work without manual database edits. |
| OP-002 | Observable operations and actionable troubleshooting. | An execution/delegation can be followed across agents, tasks and runtimes; unavailable runtimes, stalled work and recovery errors expose useful diagnostics without credentials. |
| OP-003 | Data export and backup/restore. | Conversations, work history and referenced artifacts can be exported/backed up and restored consistently; configuration portability format remains open. |

For screen behavior read the [screen and flow inventory](../design/screens-and-flows.md).

## Defining release scenario

Aldric receives a request, works directly, delegates to Rook and Sage using different runtimes, and Rook delegates to Pip. Sage asks a contextual question. Results arrive while recipients are busy or their turns have ended. Inbox persistence, acknowledgement, consumption and continuation complete the work without manual forwarding. An exceptional action is approved or denied with an audit record. The user inspects real supported tool activity. Restart the UI and server at controlled points, inject duplicate delivery and executor disconnection, then verify reconciliation, final artifacts and closure. All unresolved outcomes must be visible.
