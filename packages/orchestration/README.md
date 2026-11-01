# packages/orchestration

Application layer for Tasks, Quests and delegation ([ADR 018](../../docs/decisions/018-tasks-and-quests.md), [STD-ARCH-006](../../docs/standards/architecture.md#std-arch-006-use-cases-live-in-their-feature-package)). It depends only on `effect`, `@hobbots/domain` and `@hobbots/agents`, whose ports it uses.

## Use cases

| Service          | What it does                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskTools`      | The hob tools for Tasks and Quests. Checks every call (who may make it, depth, open-Task limits, cycles, authority that only narrows), makes it once per key, and gives a turn the tools to offer its runtime. A chat turn's calls work on the open Task its hob owns in the thread, started from the turn's prompt when a call starts work. |
| `StepRunnerLive` | Provides `TaskTurns` from `@hobbots/agents`: runs each ready step in a fresh runtime session within the step limits, records how it ended, stops steps that are cancelled or whose hob is stopped or narrowed, and serves chat turns their Task tools.                                                                                       |
| `TaskSignal`     | Wakes the step runner when Task tools or steps change the records.                                                                                                                                                                                                                                                                           |

## Ports

| Port                | Adapter                                              |
| ------------------- | ---------------------------------------------------- |
| `TaskRepository`    | `TaskRepositoryLive` in `@hobbots/persistence`       |
| `TaskToolCalls`     | `TaskToolCallsLive` in `@hobbots/persistence`        |
| `HobbotsRepository` | `HobbotsRepositoryLive` in `@hobbots/persistence`    |
| `HobTools`          | `HobToolsLive` in `apps/server`                      |
| `FolderChecks`      | `NodeFolderChecks` in `apps/server`                  |
| `EventPublisher`    | `EventBus.layer` in `apps/server`                    |
| `RuntimeAdapter`    | `ClaudeCodeLayer` or the fake in `@hobbots/runtimes` |
| `HobAdmission`      | `HobAdmission.layer` in `@hobbots/agents`            |

The server suites `apps/server/test/task-tools.test.ts` and `apps/server/test/task-steps.test.ts` test the tools and the steps with the test database and the fake runtime; `test/` holds the pure rules.

Read the [orchestration contract](../../docs/architecture/orchestration.md) before you change this package.
