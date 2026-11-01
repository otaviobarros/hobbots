# packages/orchestration

Application layer for Tasks, Quests and delegation ([ADR 018](../../docs/decisions/018-tasks-and-quests.md), [STD-ARCH-006](../../docs/standards/architecture.md#std-arch-006-use-cases-live-in-their-feature-package)). It depends only on `effect`, `@hobbots/domain` and `@hobbots/agents`, whose ports it uses.

## Use cases

| Service     | What it does                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskTools` | The hob tools for Tasks and Quests. Checks every call (who may make it, depth, open-Task limits, cycles, authority that only narrows), makes it once per key, and gives a turn the tools to offer its runtime. |

## Ports

| Port                | Adapter                                           |
| ------------------- | ------------------------------------------------- |
| `TaskRepository`    | `TaskRepositoryLive` in `@hobbots/persistence`    |
| `TaskToolCalls`     | `TaskToolCallsLive` in `@hobbots/persistence`     |
| `HobbotsRepository` | `HobbotsRepositoryLive` in `@hobbots/persistence` |
| `HobTools`          | `HobToolsLive` in `apps/server`                   |
| `FolderChecks`      | `NodeFolderChecks` in `apps/server`               |
| `EventPublisher`    | `EventBus.layer` in `apps/server`                 |

The server suite `apps/server/test/task-tools.test.ts` tests the tools with the test database and the fake runtime; `test/` holds the pure rules.

Read the [orchestration contract](../../docs/architecture/orchestration.md) before you change this package.
