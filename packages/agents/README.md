# packages/agents

Application layer for hobs and their threads ([STD-ARCH-006](../../docs/standards/architecture.md#std-arch-006-use-cases-live-in-their-feature-package)). It depends only on `effect`, `@hobbots/domain` and `@hobbots/api`.

## Use cases

| Service             | What it does                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HobService`        | Creates and edits hobs, checks their brain and role, and changes their policy.                                                                          |
| `HobLifecycle`      | Pauses, wakes and retires hobs.                                                                                                                         |
| `ChatService`       | Starts threads, sends prompts, queues messages, stops turns and continues replies. It also stops running turns that a narrower policy takes tools from. |
| `PermissionSummary` | Sums up a hob's policy under the installation's preset and shared folders.                                                                              |
| `ApprovalService`   | Stores a tool call the policy answers Ask for as an approval request, holds its turn until the user decides, and expires what a turn leaves pending.    |
| `HobAdmission`      | Holds the per-hob lock that the other services share.                                                                                                   |

## Ports

The use cases reach storage, runtimes and the filesystem only through these ports ([STD-ARCH-003](../../docs/standards/architecture.md#std-arch-003-use-cases-reach-the-outside-world-through-ports)). Adapters implement them as Layers, and `apps/server` composes them.

| Port                   | Adapter                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `HobbotsRepository`    | `HobbotsRepositoryLive` in `@hobbots/persistence`               |
| `InstallationSettings` | `SetupRepository.layer` in `@hobbots/persistence`               |
| `RuntimeAdapter`       | `ClaudeCodeLayer` and `FakeRuntimeLayer` in `@hobbots/runtimes` |
| `EventPublisher`       | `EventBus.layer` in `apps/server`                               |
| `FolderChecks`         | `NodeFolderChecks` in `apps/server`                             |
| `HobTools`             | `HobToolsLive` in `apps/server`, or `HobTools.chatOnly`         |
| `ApprovalRepository`   | `ApprovalRepositoryLive` in `@hobbots/persistence`              |

The server suites test these use cases with the test database and the fake runtime.

Read the [architecture overview](../../docs/architecture/overview.md) before you change this package.
