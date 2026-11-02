# packages/inbox

Application layer for a hob's backpack: what each hob still has to deal with ([ADR 019](../../docs/decisions/019-hob-backpack-and-continuations.md)). It depends only on `effect` and `@hobbots/domain`. The records, their states and steps are in `@hobbots/domain` (`BackpackItem`).

## Rules

| Function           | What it does                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backpackItemsFor` | Turns a change's journal events into the backpack items they call for, with their recipients and dedupe keys. Pure: the repositories write its result in the change's own transaction. |
| `tasksTouched`     | The Tasks a change's events touch, so a repository knows which trees to read for `backpackItemsFor`.                                                                                   |
| `lateness`         | Whether an item is late: the Task it is checked against has ended, or its recipient no longer owns any Task from the item's own up.                                                    |

## Services

| Service      | What it does                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dispatcher` | Delivers an item into a turn at least once and has it processed once: claim, late check, delivery, acknowledgement on the runtime's evidence, consumed, or retried with backoff. |

## Ports

| Port             | Adapter                                   |
| ---------------- | ----------------------------------------- |
| `Backpack`       | `BackpackLive` in `@hobbots/persistence`  |
| `DispatcherHost` | `DispatcherHostLive` in `@hobbots/server` |

`test/` holds the pure rules. The persistence suite `packages/persistence/test/backpack.test.ts` tests the store, and `dispatcher.test.ts` the dispatcher, on SQLite and PostgreSQL. Nothing calls the dispatcher to wake a hob yet ([#292](https://github.com/otaviobarros/hobbots/issues/292)).

Read the [backpack contract](../../docs/architecture/inbox.md) before you change this package.
