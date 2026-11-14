# packages/supervision

Application layer for the supervisor ([#1447](https://github.com/otaviobarros/hobbots/issues/1447)): deadlines and deterministic recovery for the work under every Task you asked for. It depends only on `effect`, `@hobbots/domain` and `@hobbots/agents`, and never calls a model.

## Rules

| Function       | What it does                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decide`       | The acts the supervisor makes on one Task tree, at most one per Task, by the first rule that applies: deadline, allowance, unknown outcome, bounded retry, refusals, missing input. Pure. |
| `stopOrder`    | The Tasks a deadline stop fails, deepest first, so each ends before its parent.                                                                                                           |
| `nextDeadline` | When the next deadline of work still open falls, so the supervisor looks again then.                                                                                                      |

## Services

| Service      | What it does                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Supervisor` | Looks over the work every 15 seconds and as each deadline falls, and makes each act through the records: the change and the Task's `Supervision` record commit together, journaled, or neither does. |

## Ports

| Port                 | Adapter                                                |
| -------------------- | ------------------------------------------------------ |
| `TaskRepository`     | `TaskRepositoryLive` in `@hobbots/persistence`         |
| `SupervisionRecords` | `SupervisionRecordsLive` in `@hobbots/persistence`     |
| `TaskTurns`          | `StepRunnerLive` in `@hobbots/orchestration`, optional |

`test/rules.test.ts` checks every rule against an independent model over generated trees. `packages/domain/test/supervision.test.ts` checks `SupervisionMachine` against its model, `packages/persistence/test/supervision.test.ts` the records on SQLite and PostgreSQL, and `apps/server/test/supervisor.test.ts` the supervisor in a hub, with members on Claude Code and on Codex.

Read [the supervisor](../../docs/architecture/orchestration.md#scheduling-and-limits) and [its states](../../docs/architecture/machines/supervision.md) before you change this package.
