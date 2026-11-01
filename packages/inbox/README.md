# packages/inbox

Application layer for a hob's backpack: what each hob still has to deal with ([ADR 019](../../docs/decisions/019-hob-backpack-and-continuations.md)). It depends only on `effect` and `@hobbots/domain`. The records, their states and steps are in `@hobbots/domain` (`BackpackItem`).

## Rules

| Function           | What it does                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backpackItemsFor` | Turns a change's journal events into the backpack items they call for, with their recipients and dedupe keys. Pure: the repositories write its result in the change's own transaction. |
| `tasksTouched`     | The Tasks a change's events touch, so a repository knows which trees to read for `backpackItemsFor`.                                                                                   |

## Ports

| Port       | Adapter                                  |
| ---------- | ---------------------------------------- |
| `Backpack` | `BackpackLive` in `@hobbots/persistence` |

`test/` holds the pure rules. The persistence suite `packages/persistence/test/backpack.test.ts` tests the store on SQLite and PostgreSQL. Delivery and the dispatcher are not built yet ([#291](https://github.com/otaviobarros/hobbots/issues/291), [#292](https://github.com/otaviobarros/hobbots/issues/292)).

Read the [backpack contract](../../docs/architecture/inbox.md) before you change this package.
