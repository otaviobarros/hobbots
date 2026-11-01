# Agent and domain model

**Decided concepts; the field contract is a draft.** Agent identity outlives a process, thread, runtime session or attempt. All agents can execute, delegate and coordinate when their configuration and policy permit it. Names, avatars, class and specialization are presentation/instructions, not authority.

| Entity | Owns | Important relationships |
|---|---|---|
| Agent | Stable identity, versioned configuration, runtime/model preference, instructions/personality, optional skills/specialization, tools and policy references | Many threads and assigned tasks. |
| Thread | Durable user conversation and linked work | Belongs to one agent; may start several Tasks, and so several Quests. |
| Session | Binding to an underlying runtime conversation/connection | May change during recovery; never replaces domain identity. |
| Task | One hob's piece of work: owner, parent, root, brief, state, dependencies, result and version | May have child Tasks: steps when they share its owner, members' work in a Quest. Has one or more attempts. |
| Quest | Goal, acceptance criteria, limits, lead, party and aggregate outcome | Added to a Task when it first brings in another hob; the Task keeps its id. Its owner is the lead. A nested Quest sits inside its parent Quest. |
| Delegation | Explicit request/result relationship from a lead to a member | Lead, member, parent Task, child Task, the brief, narrowed authority and timeout. |
| Execution / Attempt | One attempt to perform task work | Runtime, executor, session, configuration/policy version and outcome. A retry is a new attempt. |
| Milestone | A point the lead plans in a brief | Task; title, order and when it was reached. |
| Checkpoint | A short record of where a Task stands | Task and attempt; source (planned, unplanned or automatic), kind and summary. |
| Question | A question from a Task's owner | Asking Task, current recipient, the escalation chain and the answer. |
| Inbox item | Durable delivery/processing responsibility | Recipient, sender, kind, correlations, processing/consumption state. |
| Responsibility | Outstanding promise, reply, deliverable or dependency | Owning agent/task, origin, condition for closure and evidence. |
| Approval | Human decision for a specific bounded action | Requesting identity, executor, action digest, scope and lifetime. |
| Executor | Authorized execution environment | Platform, runtime versions, resource boundaries, capacity and health. |
| Artifact / Tool invocation / Event | Evidence and activity | Correlate to relevant work and attempt; avoid credentials. A hand-off passes an artifact reference to another Task's brief. |

Tasks, steps and Quests are decided in [ADR 018](../decisions/018-tasks-and-quests.md), which lists each record's lineage and the events its changes journal.

## Identity and versioning

Use stable domain identifiers for agents, threads, Quests, tasks, delegations, executions, executors, approvals, messages and events. Runtime session IDs are namespaced by runtime and executor. Persist correlation explicitly rather than parsing prose to discover lineage.

An agent edit, including a change to its own folders or permission overrides ([permissions](permissions.md)), creates a new configuration version. Running work retains its execution snapshot. Archive/disable preserves references and history; handling currently active work must be explicit. Database-managed configuration versus portable JSON/YAML export remains open.

Availability, runtime health, execution status and inbox backlog are different projections. An agent with no active turn may still own unresolved responsibilities. A runtime that is unavailable does not erase its agent or terminate every Quest as failed.

## Invariants

Every Task has an owner hob that exists, and every child Task a parent that exists. A Quest sits on exactly one Task. A step has its parent's owner. Delegations retain the original requester and expected response. Children have bounded scope. A result references the producing attempt and artifacts. Retries create new attempts, not new user-visible task identities. Completion requires the closure contract in [execution lifecycle](execution-lifecycle.md).


## Configuration

Support a persistent identity with name, avatar, instructions/personality, runtime/provider-supported model choice, tools, permissions, working directory or isolated environment, optional specialization/default skills and delegation availability. An agent can be configured manually or from a template. Template/class choices never restrict technical capabilities by themselves. Exact bundled templates, custom-skill representation and provider credential onboarding remain design questions; the model choices are those actually supported by the selected runtime.

On every turn the hub tells the runtime who the hob is, from the configuration version the turn runs with: its name and role (a starter role's title and note, or a title in the user's own words), then the user's instructions, each under its own heading ("About you", "Your instructions, from the user") so the model can tell what Hobbots states from what the user wrote. The role is never written into the instructions, so a role change applies from the next turn. A role describes the work; it grants no authority.

A hob also has a tone: one voice and one length, picked apart so a hob can be both brief and friendly. The domain fixes the line each choice adds, so the wording can be tested and evaluated. When either differs from its default (Default voice, Balanced length), a "How you talk" section sits between "About you" and the user's instructions, holding the voice line, then the length line, then, for a themed voice, a guard that keeps facts, code, commands, links and warnings plain. At the defaults the section is left out. The user's instructions come last, so a voice they describe themselves takes precedence.

Retain the original execution snapshot for audit, while enforcing current applicable authority before new effects; see [permissions](permissions.md). This resolves the difference between reproducible execution provenance and a permission that can expire or be revoked.
