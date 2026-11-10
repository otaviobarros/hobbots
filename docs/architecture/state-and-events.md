# State and events

**Decided** in [ADR 037](../decisions/037-chat-and-camps.md), building on the journal of [ADR 013](../decisions/013-event-journal.md) and the backpack of [ADR 019](../decisions/019-hob-backpack-and-continuations.md). This contract says how state changes and how the hub tells the world, so every part of Hobbots does it the same way. The rules are STD-ARCH-013 to STD-ARCH-019 and STD-REACT-028 and 029 in the [standards](../standards/README.md). Each section names what exists today to copy from, and what is decided but not built yet.

## One pattern per part

| Part | Pattern | Rule |
| --- | --- | --- |
| A lifecycle | An explicit machine | STD-ARCH-013 |
| Changing durable state | A command handler | STD-ARCH-014 |
| Telling the world | One journal event per transition | STD-ARCH-015 |
| Work for a hob | The backpack | STD-ARCH-017, ADR 019 |
| Derived work for the hub | A cursor projector | STD-ARCH-016 |
| What clients show | A projection the hub publishes | STD-REACT-028 |
| Waking a service | An announcement on the bus, after commit | STD-ARCH-017 |
| Live state that is not stored | An Effect `Ref` per machine | STD-ARCH-013 |
| A rule that must hold at once | A pure function in the transaction | STD-ARCH-016 |
| What a turn reads | The context pack | STD-ARCH-018 |
| A multi-step UI flow | A reducer with one type per state | STD-REACT-029 |

A change that needs a second pattern for the same part comes back to review.

## Machines

A machine is a table of states, events, guards and next states, with a pure `transition(state, event)` that returns the next state or a typed error. Effects run around a transition, never inside it (STD-EFFECT-004).

- **Today.** `defineMachine` in `packages/domain/src/machine.ts` declares a machine: its states with what each means, the field that holds the state, and for each event one rule or several: the states a rule starts from, the state it leads to, an optional guard and how the record changes. Several rules let one event lead to different states, such as a turn's end leading to idle or to the next turn; the first whose state and guard hold is taken. Pass the type arguments, `defineMachine<State, Event, Record, Error>`, so a missing or extra state or event does not compile; the scripts refuse a machine without them. Name the machine after the record it governs. It exports `transition`, `can` and its table, one row per rule. A refused event returns the machine's own typed error. A declaration whose rules contradict themselves, a rule that leaves the record in a state other than its row's, or an event of no known kind throws `MachineDefect`, so the table is always true. `TaskMachine` in `task.ts` is the example to copy. Messages (`MessageTransitions` in `message.ts`), hobs (`InvalidAgentTransition` in `agent.ts`) and backpack items (`IllegalBackpackTransition` in `backpack.ts`) are still written by hand, and move onto `defineMachine` when next changed.
- **Decided, not built.** New machines use `defineMachine` from the start: `ThreadRun`, `ThreadLifecycle`, `ChapterState`, `DecisionState`, `SuggestionState` and `ClaimState`.
- **Diagrams.** `pnpm docs:machines` writes a Mermaid diagram of each machine into `docs/architecture/machines/`, such as [Task](machines/task.md), from its exported table, and `pnpm lint:machines` fails when one is out of date. The scripts find every exported machine in the packages and the server, and fail on one that is not exported or shares its name with another. They load it with Node's type stripping, so a machine's module uses only erasable TypeScript.
- **One field, read through helpers.** A machine's state is one field. Code outside the machine's module asks the machine's `can` or its helpers, such as `canArchive`, and never compares the field. `pnpm lint:state` fails on a new comparison in any file that imports the machine or its record; the ones on `main` today are in its baseline.
- **No hidden machines.** A `Set` or `Map` keyed by an id that a service holds for its whole life is a machine nobody declared. `pnpm lint:state` fails on a new one. The ones on `main` today are listed in `scripts/implicit-state-baseline.json`; the run loop's five in `packages/agents/src/chat.ts` go with `ThreadRun` ([#1371](https://github.com/otaviobarros/hobbots/issues/1371)). A collection that is truly not lifecycle state, such as a cache of open sockets, says so with `// standards-allow STD-ARCH-013: <reason>`.
- **Live state.** A machine whose state need not survive a restart, such as a thread's run, lives in one `Ref` changed only through its transition, and is rebuilt at start from durable records.
- **Tests.** Each machine has unit tests of its table and a model-based test with `fast-check`: random runs of events against the machine and a small model kept apart from it, which must agree after every event. `agreesWithModel` from `@hobbots/domain/machine-testing` runs it, and `packages/domain/test/task-machine.test.ts` shows how: the model tracks every field a rule writes, and the events carry generated values, such as their times. A machine held by a service, such as ThreadRun, is also tested through the service, against the same model.

## Commands

A command is the only way durable state changes.

1. Load the aggregate at its revision.
2. Run the machine's transition. An illegal one fails with its typed error, and nothing is written.
3. In one transaction: write the new state at the expected revision, its journal entries, and any backpack items a pure rule derives from them. Use an idempotency key, so a retried request changes nothing twice.
4. After commit, announce the entries on the bus.

Nothing external happens before the commit: no runtime call, no model call, no HTTP request.

- **Today.** Repositories return `Committed<A>`, the value with its journal entries, and services announce them after commit, as `saveThread` and `saveMessage` do in `packages/agents/src/chat.ts`. The journal is written in the same transaction (ADR 013, `packages/persistence/src/journal.ts`).

## Journal events

Each transition writes exactly one event, named in the past tense for what happened: `ChapterStarted`, `ChapterMoved`, `DecisionRecorded`, `CampMade`, `ChatStartedFresh`. Events are declared in `packages/domain/src/events.ts` and listed in the [API and events contract](api-events.md). The journal is the only order. Clients sync from it (ADR 013), and projectors read it.

## The backpack

Work a hob must deal with is a backpack item, with its claims, leases and deliveries, and the dispatcher starts the turn (ADR 019, [backpack contract](inbox.md)). There is no second queue for hobs. A rule that turns changes into items is a pure function run in the command's transaction: `backpackItemsFor` in `packages/inbox/src/items.ts` is the model.

## Projectors

A projector does work derived from the journal: a chapter summary, a brief, a search index.

- It reads the journal after its saved cursor, and saves the cursor per batch.
- It is idempotent by journal entry, so a replay writes nothing twice.
- It writes its result as a record, with the cursor it used.
- A slow or failed call, a model's included, never blocks a turn: the last record stays until the next one is written.
- **Today.** Memory capture is the model: `packages/agents/src/memory-capture.ts` reads the journal after its cursor and moves the cursor only once memory has taken a batch.
- **Decided, not built.** A shared `projector_cursors` table, and the chapter summary, brief, search and camp suggestion projectors ([#1380](https://github.com/otaviobarros/hobbots/issues/1380), [#1384](https://github.com/otaviobarros/hobbots/issues/1384), [#1386](https://github.com/otaviobarros/hobbots/issues/1386)).

An event handler never writes to another aggregate. Either a pure rule does it in the same transaction, or a projector does it with its own cursor.

## Projections

What a client shows about a hob, a thread or a quest is a projection the hub publishes, never a rule each screen copies.

- What a client must see at once is computed in the writing transaction or published by its machine: `ThreadRunChanged`, `QuestSummary`.
- What can lag comes from a projector: the brief, chapter summaries.
- Projections reach clients through the same sync as everything else, snapshot and journal (ADR 013), read with TanStack Query (STD-REACT-001).
- **Today.** The web client still works out thread activity in `apps/web/src/api/activity.ts`, hob state in `apps/web/src/lib/hob-state.ts`, and quest tones and counts in `quest-work.ts` and `led-quests.ts`. They go when the hub publishes `ThreadRunChanged`, `HobPresence` and `QuestSummary` ([#1372](https://github.com/otaviobarros/hobbots/issues/1372) to [#1374](https://github.com/otaviobarros/hobbots/issues/1374)).

## The bus

The in-process `EventBus` (`apps/server/src/event-bus.ts`) carries two kinds of events: committed journal entries, and transient events such as streamed reply chunks, which are never stored (ADR 013). Neither holds work. A receiver re-reads durable state to decide what to do, as `WakeOnArrival` does in `apps/server/src/continuations.ts`, so losing an announcement never loses work (STD-DATA-001). Publishing a transient event is not a breach of these rules; keeping work only in one is.

## The hub's brain

Judgments, such as whether a chapter has drifted into its own topic, go through `HubDecider`: a schema of choices and an input in, a choice and a confidence out. It runs only in projectors, never in a command. Every judgment has a rule to fall back to, so No AI works ([#1367](https://github.com/otaviobarros/hobbots/issues/1367)). Facts, such as numbers, clashes and status, are always rules.

## Patterns we avoid

- A state spread over booleans, sets or nullable timestamps.
- A machine's state compared outside its module.
- The transcript replayed as context.
- External work before commit, or inside a reducer or transition.
- An in-memory `Queue` or `PubSub` as the only holder of work.
- An event handler that writes to another aggregate.
- A model call in a command.
- A record copied between places instead of moved.
- A client working out server state.
- A generic workflow engine. Machines and the backpack cover Hobbots' waits.
- An authored record with no explicit actor.
