# Persistence package

The persistence package holds the repositories, the journal, the projectors' rows and the migrations. Every installation runs on SQLite, and CI runs the same code on PostgreSQL. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- Every query and migration runs on both SQLite and PostgreSQL (STD-DATA-002). Flag SQL only one engine accepts, such as an engine-specific function, or type and collation behavior that differs between them.
- A new migration is a file from `pnpm migration:new`, named by its UTC second ([ADR 040](../../docs/decisions/040-parallel-pull-requests.md)). Nothing lists migrations by hand. A migration already on main is never edited or renumbered: a fix is a new migration.
- A migration that rewrites stored rows or journal entries keeps existing data readable, and works on a database that already holds rows of every older shape. Losing or corrupting stored data is P0.
- A command writes its state, its journal entries and its backpack items in one transaction (STD-ARCH-014). A check that guards a write, such as an owner's status or a capacity limit, reads inside that transaction, and on PostgreSQL locks the row it depends on (`FOR UPDATE`), as `TaskRepository` does.
- A rewritten event takes the next free event schema version, so a later migration does not skip it.
- Database tests take `TestDatabase` from `@hobbots/persistence/testing`, so both CI jobs run them (STD-TEST-006). Tests that run older migrations and then seed through a repository keep every migration that repository now needs.
- Durable coordination and recovery state lives here, never only in a service's memory (STD-DATA-001).
