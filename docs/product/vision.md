# Product vision

Hobbots is a personal workspace around existing AI-agent engines. Users work in focused conversations while agents execute directly, delegate independent work, exchange messages, and finish responsibilities without manual message forwarding.

The primary user is an individual operating multiple specialized agents on user-controlled infrastructure. The MVP is single-user; optional network access does not introduce organizations or multi-user RBAC. Agents have persistent identities, instructions, runtime/model choices, tools, workspaces, and independent permissions. In the UI agents are called hobs; their names and pixel avatars express identity without determining capabilities.

## Defining experience

A user asks Aldric to investigate a problem. Aldric works directly while Rook and Sage investigate in parallel. Rook can ask Pip for tests. Sage can ask another agent a question. The execution panel shows owners, progress, unanswered messages, and exactly who is waiting for whom. Tool activity opens in the Workbench while the central conversation stays accessible. Results activate the responsible agent, which reconciles its commitments, continues authorized work, verifies the outcome, and reports back.

The durable objective is a Quest. A thread organizes discussion; a Quest organizes responsibility and execution. A completed runtime turn does not by itself complete a Quest or consume a delegated result.

## Product principles

1. Focused chat with clear navigation and contextual execution visibility.
2. Every agent can execute, delegate, receive, communicate, and coordinate.
3. Autonomous ordinary work inside explicit, enforceable trusted scopes.
4. Durable inbox and proactive closure as platform behavior.
5. Existing runtimes behind capability-aware adapters rather than a new LLM engine.
6. One local-first, self-hostable server and consistent browser/Electron experience.
7. Modern productivity UX with a night-palette, pixel-art identity that keeps tool and permission names plain.

## Non-goals

The MVP does not build a custom model inference or agent reasoning engine, require a separate orchestrator agent class, or promise transparent recovery at an arbitrary interrupted tool instruction. Broad runtime interoperability is validated per adapter, not assumed. Later-feature boundaries are recorded in the MVP specification.
