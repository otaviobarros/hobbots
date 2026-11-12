# ADR 037 — Chat and camps

Status: **Accepted.** Amends the threads of the [conversations contract](../architecture/conversations.md) (a thread has a kind, and its transcript is split into chapters), the screens of [ADR 027](027-quest-room.md) (the lanes layout of the Quest room goes; a quest opens as a thread in its camp's sheet, and ADR 027's records stand), the starting context of a runtime session in [ADR 017](017-switching-brains.md) and [ADR 028](028-memory.md) (a session starts from records, not from the transcript), and the memory model of ADR 028 (it becomes the hub's brain). Builds on the event journal of [ADR 013](013-event-journal.md), the client stores of [ADR 016](016-client-stores-outside-react.md), the Task tree of [ADR 018](018-tasks-and-quests.md) and the backpack of [ADR 019](019-hob-backpack-and-continuations.md). Records the architecture for the chat and camps work ([#1359](https://github.com/otaviobarros/hobbots/issues/1359)).

## Context

A hob's thread grows without end. Every turn of a long thread carries more of its past, so it costs more and drifts more. What was decided, what the hob made and what is still open are buried in the transcript, and finding them means scrolling. Threads also pile up with no shape: each new topic starts a thread, and none of them says what it is for.

The design for this is **chat and camps**:

- Each hob has **one chat**, which never ends. Its transcript is split into **chapters**, one per topic.
- A topic that grows gets a **camp**: a thread with a goal of its own. A chapter can move from the chat into a camp.
- **Decisions**, **artifacts** (what a hob makes or changes: a doc, page, email, image, code file, PR or link) and a short **brief** ("Where we are") are kept as records. A turn reads them instead of the whole transcript, and the right sheet shows them.
- A **quest** sets out from a camp. Its updates and questions land there.

Most of what this needs already exists: threads, the event journal, the backpack, the dispatcher, the Task tree, the memory brief and full-text search. The risk is not missing parts. It is state that is spread over flags and sets and worked out again in several places:

- **The thread run loop.** `packages/agents/src/chat.ts` decides what a thread may do next from five collections: `busy`, `holdBack`, `rewake`, `chosen` and `replies`. A guard reads several of them at once, such as `busy.has(t) || holdBack.has(t)`, and nothing lists the legal combinations. Chapters and Start fresh would each add a path that must remember all five.
- **The thread lifecycle.** `archivedAt`, `pinnedAt` and `skillTrial` are nullable fields, and archive refusals are worked out ad hoc. Camps add states, such as moved out and made into a camp, that nullable timestamps cannot keep apart.
- **Activity in the web client.** `apps/web/src/api/activity.ts` works out thinking, working or waiting from each `MessageUpserted`, and `apps/web/src/lib/hob-state.ts` folds it with hob status. The hub already knows these states. Two devices can disagree while events arrive.
- **Quest rollups.** `apps/web/src/lib/quest-work.ts` and `apps/web/src/lib/led-quests.ts` each fold Task states their own way. The camp's quest pill would be one more copy.

Message, hob, Task and Attempt states are already explicit: pure transitions that refuse an illegal move. That is the pattern to spread.

## Decision

### A camp is a thread with a kind

- `Thread` gains `kind` (`chat` or `camp`), `goal`, `private`, `origin` (the thread and chapter it came from) and `state`. The code keeps `Thread` as the noun; the UI says chat or camp and never thread.
- **One open chat per hob**, held by a partial unique index on the hob where `kind = 'chat'` and the thread is open.
- `ThreadLifecycle` has three states: open, archived and superseded (a chat replaced by Start fresh). The timestamps stay as facts. Guards read the state.
- **Migration.** Each hob's most recent open thread becomes its chat. Its other threads become camps and keep their titles.
- **A private camp** keeps nothing in memory. Capture skips every entry written while the camp was private, its Quest's work outside any chat included, even after the camp is public again; capture follows each camp's privacy along the journal from its cursor. A message, Attempt or other item with any entry written while private stays out for good, so a later entry that carries it again, such as a reply that ends or an Attempt's steps, adds nothing of it. A `memory_save` or share from the camp, or from a Task in it, is refused. The camp keeps the memory brief, and what memory had from before it was made private stays.
- The generic New thread entry goes. A hob's chat always exists, and a camp starts from Make a camp.

### Chapters

- A `Chapter` has `threadId`, `number`, `title`, a one-line `summary`, `startedAt`, `endedAt` and `movedTo`. `ChapterState` is live, resting or moved. Exactly one chapter per thread is live.
- Every message belongs to one chapter (`Message.chapterId`). The migration gives each thread one chapter holding its history.
- **The hob ends a chapter.** It calls `start_chapter` with a title when the topic changes. The tool is a hub tool on every runtime: Claude Code, Codex and the fake runtime. You can split or merge chapters in the UI. A hub rule may suggest a split; it never splits on its own.
- **A runtime session belongs to one chapter.** `RuntimeSession` is keyed by thread, runtime and chapter. A new chapter starts a new session, seeded from records. Resuming stays inside a chapter. Replaying the transcript stays only for a brain switch inside a live chapter (ADR 017).
- **Moving a chapter into a camp moves it.** One command changes the chapter's `threadId`, with its decisions, artifacts, open questions and the quests started in it, in one transaction. The chat keeps a stub that links to the camp. Nothing is copied, so nothing is ever in two places. A running quest moves whole.

### Records

Records are written once, in the same transaction and journal as the message that made them, and read by everything: the context pack, the sheet and find.

| Record | Key fields | Lifecycle |
| --- | --- | --- |
| Decision | text, actor, threadId, chapterId, sourceMessageId, supersededBy | active, superseded. A changed decision is kept and crossed out, never edited. |
| Artifact | kind (code, page, doc, email, image, PR, file), title, latestVersion, origin (Attempt, Quest artifact or message) | A registry over what Attempts and Quests already record. It indexes them and copies nothing. |
| Brief | threadId, text, revision, writtenBy, basis (journal cursor) | Rewritten by a hub projector at quest steps and chapter ends. |
| CampSuggestion | threadId, chapterId, reason (codes and counts) | open, kept, accepted, expired. At most one per chapter. |
| CarriedItem | fromThreadId, toThreadId, ref (question, reminder or backpack item) | Written once by Start fresh. |
| Claim | scope (migration number, ADR number, path, branch), key, holder (Task), state | held, released, contested. Unique on scope and key. |

- **Every author is an actor**: `{ kind: user | hob | hub, id }` on decisions, notes, claims and messages. There is no implied "you". Shared camps later need this, and adding it now saves a migration of meaning.
- **A note to self** is a new message role. A note never wakes the dispatcher.
- **The brief is written by the hub**, not by a hob turn. It costs no turn and keeps working while a hob is paused.

### The context pack

- `ContextPack` is a service, not a table. `buildPack(records, budget)` is pure and deterministic. It reads the memory brief, the camp brief, active decisions, the artifacts index, the live chapter's transcript, one line per resting chapter and carried items.
- **Every part has a share of the budget**, and the shares add up to the budget. The memory brief keeps its own budget (ADR 028), and the camp brief is cut at its share by the projector that writes it. A decision is at most 500 characters; `record_decision` refuses a longer one.
- **Over budget**, the builder trims in this order: resting chapter lines, then the oldest artifacts, then the live chapter's oldest turns, each replaced by one line that says what was left out. The live chapter's last turn is kept whole when it fits the live chapter's share.
- **A turn too large for its share is cut, never refused.** The message is stored whole, as today. The pack carries its start and its end up to the live chapter's share, with one line saying how much it left out and the message to read. The hob reads the rest in parts with `read_message`, a hub tool on every runtime, which pages a message as `web_fetch` pages a long page (ADR 036).
- **Active decisions never drop silently.** When they need more than their share, the newest are kept in full up to the share, and the rest are listed by title only, newest first. If even the titles do not fit, the pack says how many older decisions it left out, and the hob reads them with `find`. The pack never goes over its budget.
- **Overflow is shown.** The `PackReport` marks each part it trimmed and by how much. When active decisions overflow, the Focus chip says so, and the hub suggests crossing out the decisions that no longer hold, or moving a topic into a camp.
- Each turn logs a `PackReport`: each part and its size in tokens. The Focus chip shows it, and a dev-only endpoint and a snapshot test show it in review.
- `agents/chat.ts` builds a session's starting context from the pack instead of the transcript.

### Quests in camps

- The quest engine stays as it is: the Task tree, Attempts, delegation, the responsibility ledger, steer receipts, the quiet-lead rule, the backpack and the dispatcher.
- A quest belongs to the thread that started it, which `Quest.threadId` and `Task.threadId` already record. Its updates and questions land in that chat or camp.
- **The lanes layout of the Quest room (ADR 027) is retired.** A quest opens as a thread in the camp's right sheet, with a link back to the camp. ADR 027's records stand.
- **One `QuestSummary` projection** on the hub (counts by tone, needs you, ready for review) feeds the quest pill, the rail and Home. It replaces the client rollups.
- The word quest stays for work a hob leads with a team. A camp is the place; a quest is a job that sets out from it.

### The hub coordinates across every chat and camp

- **The hub hands out migration and ADR numbers.** A hob asks with `claim`, and the hub gives the next free number for that scope, unique across every hob, chat and camp.
- **The hub watches paths and branches.** A Task's claims on paths and branches are checked against every other open claim. On a clash, the hub settles what it can (a number) and tells each lead involved through the backpack. The UI shows it as a Heads-up.
- The clash check is a pure rule run in the transaction that writes the claim, with named thresholds and tests. It calls no model.

### The hub's brain

- **One model for the hub's own judgments.** The memory model of ADR 028 becomes the hub's brain: one choice in Settings, a model from one list of every connected runtime's models (grouped by provider, each one's smallest recommended) or No AI, at low effort, with a fallback and an optional model per task. Setup offers it once a runtime connects, on that runtime's smallest model. It runs the same way, through the hub's model endpoint on your connected sign-ins, with no API key. No AI stays a valid choice.
- **Onboarding** shows it with the smallest model of the runtime you just connected already picked, so it is one tap, not a new question.
- **It judges; rules decide facts.** The brain writes the brief and chapter summaries, judges whether a chapter is drifting into its own topic, and whether two quests clash in meaning. Numbers, path and branch clashes, and every status stay pure rules, so they are exact, free and work under No AI.
- **Only in projectors.** The brain is called by cursor projectors, never in a command's request path. With No AI, a summary falls back to a plain one and a judgment to its rule.
- **A decision port.** Judgments go through `HubDecider`: a schema of choices and an input in, a choice and a confidence out, decoded by `Schema`. The first implementation asks the hub's brain for an answer in that shape. Another provider can implement it later.

### Every lifecycle is an explicit machine

- **`defineMachine`** in `@hobbots/domain` declares a machine as states, events, guards and next states. Its `transition(state, event)` is pure and returns the next state or `IllegalTransition`. A guard reads only the machine's state and the event. The compiler checks every state and event is handled. The table is exported, so tests and docs read it.
- **Machines:** `ThreadRun`, `ThreadLifecycle`, `ChapterState`, `DecisionState`, `SuggestionState` and `ClaimState`. Message, hob, Task and Attempt keep their transitions and move onto `defineMachine` when next touched.
- **`ThreadRun`** replaces the run loop's five collections. Its states are idle, starting, running, stopping and held, with a `wakePending` flag on the state. One `Ref<HashMap<ThreadId, ThreadRun>>` holds it, changed only through `ThreadRun.transition`, and each change is published as `ThreadRunChanged`. At start every run is idle; queued messages and pending backpack items start it again. Behavior does not change.
- **Other code asks the machine.** A machine exports helpers such as `isLive`, `canArchive` and `canMoveChapter`. Code outside the machine's module never compares its state field.

### One pattern per part

| Part | Pattern | Rule |
| --- | --- | --- |
| Changing durable state | Command handler with an expected revision | One Effect service per aggregate loads, transitions and writes state, journal entries and backpack items in one transaction, with an idempotency key. Nothing external happens before commit. |
| Telling the world | Domain events in the journal | Past tense, one per transition, in the same transaction: `ChapterStarted`, `ChapterMoved`, `DecisionRecorded`, `CampMade`, `ChatStartedFresh`. The journal is the only order. |
| Work for a hob | The backpack | Carried items, suggestions for the hob to raise and claim clashes are backpack items, with the same claims, leases and dispatcher. There is no second queue for hobs. |
| Derived work for the hub (chapter summary, brief, search index, camp suggestion check) | Cursor projectors | Each reads the journal after its saved cursor, as memory capture does, is idempotent by entry id, saves its cursor per batch in `projector_cursors`, and writes a record with the cursor it used. A slow model call never blocks a turn. |
| Read models (rail, quest pill, catch-up, Focus chip, hob presence) | Projections | What a client must see at once (`QuestSummary`, `ThreadRun`) is computed in the writing transaction or published by its machine. What can lag (brief, chapter summary) comes from a projector. Clients never compute them. |
| Waking things up | Observer on the in-process bus, after commit | The bus only announces. The receiver re-reads durable state, as `WakeOnArrival` does. A lost announcement never loses work. |
| Live, non-durable state (thread run, streaming text) | Effect `Ref` or `SubscriptionRef` per machine | Changed only through its machine, and rebuilt at start from durable records. |
| Rules (suggest a camp, detect a clash) | Pure functions in the transaction | Events in, items out, like `backpackItemsFor`. Thresholds are named constants with tests, not prompts. |
| UI flows (Make a camp, Start fresh, find and ask, sheet tabs) | Discriminated-union reducers | One reducer per flow, one type per state, no sets of booleans. Server state comes from TanStack Query projections; drafts stay in stores outside React (ADR 016). |

A change that needs a second pattern for the same part comes back to review.

### Patterns we avoid

- **A state spread over booleans, sets or nullable timestamps.** Use one state field read through its machine.
- **Replaying the transcript as context.** Use the context pack.
- **External work before commit, or inside a reducer.** Commit first; observers and the dispatcher act after.
- **An in-memory `Queue` or `PubSub` as the only holder of work.** It is lost on restart. Use the backpack or a projector. In-memory queues are only a wake-up signal.
- **An event handler that writes to another aggregate.** It hides the order. Use a rule in the same transaction, or a projector with its own cursor.
- **A model call in a command's request path.** Commands write records; projectors call models later.
- **Copying records between chat and camp.** Move by re-parenting, with a stub.
- **Clients deriving server state.** Render hub projections; only view state is local.
- **A generic workflow engine.** Machines and the backpack cover this feature. Revisit Effect Workflow only for waits of days.

### Tools

- **`fast-check`**, added as a dev dependency, pinned (STD-DOCS-006). Model-based tests run random sequences of commands against the real service and a small model, and check they agree. This is how the `ThreadRun` rewrite proves it keeps today's behavior, races between stop, wake and send included.
- **`scripts/machines.mjs`** writes a Mermaid diagram per machine into `docs/architecture/machines/`. `pnpm check` fails when a diagram is out of date.
- **An implicit-state check** on `oxc-parser`, in `scripts/check-*.mjs`. It fails on a `Set` or `Map` keyed by an id that a service holds as state, and on a comparison of a machine's state field outside its module. Today's cases go into a baseline that only shrinks, as `frontend-baseline.json` does.
- **A glossary check** in `pnpm check`: a term the UI shows matches the code name the glossary gives it. `Agent` stays in code and hob in the UI; `Thread` in code, chat and camp in the UI; artifact in both; Attempt only, never Execution.
- The rules for machines and these patterns go into the standards ([#1360](https://github.com/otaviobarros/hobbots/issues/1360)).

### Not chosen

- **XState on the hub.** Its actors keep state in memory, which competes with durable records and Effect's own concurrency. On the web, reducers are enough for flows this size.
- **Effect Workflow or Cluster.** Nothing here waits for days, and the backpack covers durable waits.
- **A vector store for find.** SQLite FTS5 over records answers "where did we decide X". Semantic recall can come later through memory (ADR 028).

### Rollout

Five slices, in order. Each leaves the app working.

1. **Status you can trust on every device** ([#1361](https://github.com/otaviobarros/hobbots/issues/1361)): `defineMachine`, `fast-check`, the diagram script and the implicit-state check; `ThreadRun` with no change in behavior; `ThreadRunChanged`, `HobPresence` and `QuestSummary`; the client derivations removed.
2. **Chat and camps** ([#1362](https://github.com/otaviobarros/hobbots/issues/1362)): thread kind, goal, private and state with the migration; the rail; Make a camp; Start fresh with carried items.
3. **Chapters and the Focus chip** ([#1363](https://github.com/otaviobarros/hobbots/issues/1363)): chapters, `start_chapter`, sessions per chapter, the pack builder and the Focus chip. Token cost is measured before and after.
4. **Decisions, artifacts and find** ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)): decisions, artifacts, the brief, the sheet tabs, find with ask, and the camp suggestion with Make a camp from a chapter.
5. **Quests in camps** ([#1365](https://github.com/otaviobarros/hobbots/issues/1365)): the quest pill, the quest thread in the sheet, and the claims register with the Heads-up.

Shared camps, with more than one person, come after. They need users as actors (accounts, membership, who sees what), which is a separate design. Nothing here blocks them.

## Rationale

- **Records over transcripts.** A transcript's cost grows with every turn, and what matters in it is a few decisions and artifacts. Reading those records keeps a turn's cost tied to the live topic, and the same records feed the sheet and find, so nothing is worked out twice.
- **A camp is a thread.** Threads already have titles, pins, archive, unread markers, brains and sessions. A `kind` reuses all of it, where a new Camp table would copy it.
- **Chapters start sessions.** A runtime session cannot forget part of itself. Starting one per chapter is the only way, on both Claude Code and Codex, to stop old topics riding along.
- **Moving, not copying.** Two copies of a decision drift apart. Re-parenting in one transaction keeps one truth, and the stub keeps the chat readable.
- **The hub decides status.** It already knows every state. Publishing it once removes the rules each screen copies, and two devices cannot disagree.
- **Explicit machines.** The run loop shows the cost of state spread over sets: every new path has to remember them all. A table with one owner and one event per change can be tested by model, diagrammed and read.
- **Rules before models.** Numbers, clashes and status must be exact, free and work under No AI. A model only judges, and only in projectors, so a slow or failed call never blocks you.
- **Small tools.** `fast-check` and three checks of our own cover what XState or a workflow engine would add, without a second home for state.

## Consequences

- Turn cost stops growing with a thread's length. A turn reads records and the live chapter only.
- Every lifecycle has one table to read, one place that changes it and one event per change. A new path, such as Start fresh, is a new event in a table, not a new set.
- Every device shows the same status, because the hub decides it.
- The migration rewrites every thread's kind and gives every message a chapter. It must run in one pass, on SQLite and PostgreSQL, with a test for each.
- `agents/chat.ts` is rewritten at its core. The existing chat, stop, continue and dispatcher tests must pass unchanged before anything else builds on it.
- The quest room's lanes screen and its tests go.

## Amendment: defineMachine ([#1370](https://github.com/otaviobarros/hobbots/issues/1370))

Building `defineMachine` settled these details.

- **Each machine keeps its own error.** A refused event returns the machine's own typed error, built by its `illegal` function, such as `IllegalTaskTransition`, rather than one shared `IllegalTransition`. Callers keep the error they already handle.
- **States carry their meaning.** A machine declares its states as an object keyed by its state union, each with what it means, so a state left out does not compile, and the diagrams show each meaning.
- **An event can have several rules.** One event may lead to different states, each rule with its own guard, tried in order. A turn's end that leads to idle or to the next turn is one event with two rules, so callers never read the state to pick the event.
- **A rule lands where its row says.** If a rule's `apply` leaves the record in a state other than its `to`, the transition throws `MachineDefect`, a bug in the declaration, so the exported table is always true. So does a declaration whose rules contradict themselves, and an event of no known kind.
- **The field is typed.** The state field must be a field of the record that holds a state, and the machine reads its state from it.

## Amendment: ThreadRun's states ([#1371](https://github.com/otaviobarros/hobbots/issues/1371))

Building `ThreadRun` changed its states from idle, starting, running, stopping and held.

- **The states say who frees the thread.** They are `idle`, `dispatching` (the dispatcher is putting backpack work into the next turn), `running` (a turn whose own drain frees the thread), `carrying` (a turn the dispatcher started, carrying that work) and `draining` (the turn has ended and its drain has yet to free the thread). A turn's end leads to `draining` or back to `dispatching`, so the dispatcher, not the turn, frees a thread it started a turn in.
- **Stopping stays on the reply.** Whether a running reply is stopping is the reply message's own status, `stopping`, so the run does not hold it a second time.
- **Held and the wake are flags.** `held` (you stopped a turn that carried work, so the work waits for your next message) and `wakePending` (work arrived while the thread was busy) both outlive a turn and hold while the run is `idle`, so they are fields of the record, not states. The record also holds the running reply and the message Send now picked.
- **Proven through the chat.** Besides the machine's own model test, `[TC-CH-293]` plays random sends, Send now, stops, arrivals of backpack work, stops racing arrivals, finished turns and restarts against one thread with the real dispatcher, and checks after every step that the chat started exactly the turns a model of the run predicts, carrying work or not, with the queue it predicts.

## Amendment: Make a camp and Start fresh ([#1376](https://github.com/otaviobarros/hobbots/issues/1376))

Building the two commands settled these details.

- **The record is `CarriedOver`.** `CarriedItem` already names the backpack items a turn carries under its claims, so Start fresh's record is `CarriedOver` in code, in the `carried_over` table. Its ref is a Task, a question, a reminder (a deadline item) or another backpack item, with a one-line label of what it was about when it moved.
- **Open work moves whole.** Start fresh moves the Tasks you asked for in the chat that are not over, with their trees and Quests, and every backpack item held for the chat that is not resolved, so what arrives later still lands in the new chat. It records as carried over the Tasks, their open questions and the items the chat's turns carry. An item a step's own session carries moves with its tree unnamed.
- **It is refused as an archive is.** A reply running or waiting, an approval waiting or a retired hob stops it, and so does a thread that is not its hob's open chat. A superseded chat is read-only for good, kept with the hob's archived threads, and has the new chat as its successor through the new chat's `origin`.
- **The key is the new thread's id.** Both commands take a key that becomes the new thread's id, as a note's key does, so the same request sent again returns what it did, and a key that names another thread is refused.

## Amendment: the claims register ([#1388](https://github.com/otaviobarros/hobbots/issues/1388))

Building the claims register settled these details.

- **A released number is never handed out again.** Reusing it would keep numbers dense, but a number seen in a closed branch would then mean two things. So a number is unique in its folder of a repository for good, and the next number is one past every number `main` and the register have held.
- **Uniqueness.** A number is unique on its repository, the folder its numbers count and the number. An open path or branch claim is unique per Task, since two Tasks may claim the same one and each contests the other, and a retried Task may claim again what its failure released; "unique on scope and key" holds for numbers only.
- **A repository is known across clones.** A claim names a folder in a Git repository, and the hub keys it by the repository's `origin` remote, as memory keys a project (ADR 028), so a checkout and a worktree share their claims. Paths are relative to the repository's top. The folder a hob names is resolved, links and `..` taken as the kernel walks them, and must be one of its folders or inside one; a hob given part of a repository claims paths and numbered folders only inside that part.
- **Main is read, never fetched.** The hub reads the numbers on the repository's default branch as the clone last fetched it, without running Git. It makes no network call in the claim's transaction.
- **The machine is `ClaimMachine`.** It is named after its record, like the other machines. A number is never contested. A Task's claims are released in the transaction that ends it.
- **`claim` is a Task tool.** It needs a Task to hold the claim, so in a chat with no Task yet it starts one, as `plan_steps` does.
- **One sequence scope.** Numbers are not only for migrations and ADRs: any folder whose files start with a number counts the same way. So the scopes are `sequence`, `path` and `branch`, and the hob names the folder. No scope names a kind of file.

## Amendment: claims beyond the repository ([#1413](https://github.com/otaviobarros/hobbots/issues/1413))

**Direction, not decided.** The register of #1388 serves a coding team. Hobbots is for every team, and a marketing, finance or support hob shares things that clash the same way: a post, a campaign's audience, a calendar slot, a budget tab, an invoice, a month being closed, a customer several teams write to. What can be claimed must not be a fixed list in the code. The direction, to be decided in #1413 before it is built:

- **A claim is what, where and how.** *Where* is a space: a Git repository as today, a connector's space such as a Drive, a CRM or a Slack workspace, or the hub itself. *What* is a key in that space. *How* is the shape of its clash rule. A connector says what can be claimed in its space, so claims grow with connectors, not with the hub's code.
- **Four shapes.** Same name (branches today), inside, by whole segments (paths today), sequence (numbers today, never contested) and overlapping time (a send window, an accounting period). Each is a pure rule in the claim's transaction, as today.
- **Read or write.** Two readers never clash.
- **How hard a clash bites.** A heads-up through the backpack, as today; wait until the other Task ends; or ask the person first. Paying an invoice twice asks; two drafts of a post only hear of each other.
- **Claims the hub makes.** When a hob edits a doc, sends an email or opens a branch through a tool the hub knows, the hub claims it for the Task, so a person never has to say "claim". Clients show who holds what in plain words.
- **Expiry and hand-off.** A claim can lapse after a time, and a waiting Task can take it once it is released.

`ClaimMachine`, the register, clash items in the backpack and release when a Task ends stay as they are; the space and the shape replace the fixed scope list.

## Validation

The scenarios that would show this decision holds. None is proven yet; each names the slice that will prove it.

- Every existing chat, stop, Stop waiting, continue and dispatcher test passes unchanged against `ThreadRun`, and model-based tests of random send, wake, stop, turn end and restart agree with the machine's model. Proven for `ThreadRun` by `[TC-CH-293]` and its machine's model test ([#1371](https://github.com/otaviobarros/hobbots/issues/1371)).
- Two clients following the same hub show the same hob, thread and quest status through every transition, on SQLite and PostgreSQL, with no status worked out in the client. Proven at the hub for thread runs and hob presence: a client that connects mid-turn shows what one connected throughout shows through a turn and a pause, each transition of its run published once (`[TC-CH-294]`), a retired hob leaves every client (`[TC-CH-295]`), and a presence the hub could not read is read again with no later change (`[TC-CH-296]`) ([#1372](https://github.com/otaviobarros/hobbots/issues/1372)). Quest status and the web client are not proven yet ([#1373](https://github.com/otaviobarros/hobbots/issues/1373), [#1374](https://github.com/otaviobarros/hobbots/issues/1374)).
- `pnpm check` fails on an out-of-date machine diagram, on a new id-keyed `Set` or `Map` held as service state, and on a state comparison outside its machine. Not proven yet ([#1360](https://github.com/otaviobarros/hobbots/issues/1360), [#1361](https://github.com/otaviobarros/hobbots/issues/1361)).
- After the migration each hob has exactly one open chat, its other threads are camps with their titles, and every message belongs to a chapter; a second open chat for a hob is refused by the database. Proven for kinds and the index, on SQLite and PostgreSQL, by `[TC-DP-1269]` and `[TC-DP-1270]` ([#1375](https://github.com/otaviobarros/hobbots/issues/1375)), and for chapters by `[TC-DP-1379-01]` and `[TC-DP-1379-02]`: every message and session gets its thread's one live chapter, and the database refuses a second live chapter or a message without one ([#1379](https://github.com/otaviobarros/hobbots/issues/1379)).
- Make a camp and Start fresh each commit state, journal and backpack items in one transaction; a crash between them leaves neither half. Carried items arrive in the new chat once. Proven at the hub on SQLite and PostgreSQL: a write that fails midway leaves neither half (`[TC-CH-1376-04]`), every open thing moves once and none stays on the old chat (`[TC-CH-1376-02]`), what waited is delivered once in the new chat, whose first turn names what was carried over (`[TC-CH-1376-05]`), a repeated request changes nothing, even after the camp is renamed (`[TC-CH-1376-01]`, `[TC-CH-1376-07]`), and a chat's Task list read before the move is dropped (`[TC-CH-1376-08]`) ([#1376](https://github.com/otaviobarros/hobbots/issues/1376)). The web commands are not proven yet ([#1378](https://github.com/otaviobarros/hobbots/issues/1378)).
- A hob on Claude Code, Codex and the fake runtime calls `start_chapter`, and the next turn starts a new session seeded from the pack, not the transcript. Proven on the fake Claude Code and Codex runtimes that a new chapter starts a new session and never resumes the old chapter's, with nothing of the old chapter replayed, by `[TC-CH-1379-01]`; that merging a chapter back into the live one starts a new session too, even for a turn under way, by `[TC-CH-1379-04]` and `[TC-CH-1379-05]`; that a brain switch replays the live chapter alone, with no summary kept from the old boundaries, by `[TC-CH-1379-02]` and `[TC-CH-1379-06]`; and that starts, splits and merges keep every message in exactly one chapter, each journaling one event, by the model-based `[TC-DP-1379-04]` ([#1379](https://github.com/otaviobarros/hobbots/issues/1379)). That the next session starts from the pack, on both runtimes, with the open Task, its question, the active decisions and the previous chapter's summary and nothing of the old transcript, is proven by `[TC-CH-1380-10]` ([#1380](https://github.com/otaviobarros/hobbots/issues/1380)). The tool is proven on the fake Claude Code and Codex runtimes. `[TC-CH-1381-01]` and `[TC-CH-1381-08]` show the hob's own `start_chapter` ends the live chapter, and its next turn runs in a new session that starts from the pack, never the old transcript. A turn starts at most one chapter, by `[TC-CH-1381-02]`. A Task step's session is refused with a reason it can read, by `[TC-CH-1381-04]`. On signed-in Claude Code and Codex too, a hand-run check showed the new session and the paging ([#1381](https://github.com/otaviobarros/hobbots/issues/1381)).
- The pack is the same for the same records and never goes over its budget, even when the memory brief, the camp brief and the active decisions alone would; then every active decision still appears in full, by title or in the count of those left out, a last turn larger than the whole budget is carried as its start and end with a pointer that `read_message` follows, the `PackReport` marks the trim, and the Focus chip shows it. A long thread's turn costs no more than a short one's plus its live chapter, measured before and after. Proven for the pack itself: the same records give the same pack, `[TC-CH-1380-01]`; it stays within its budget and lists every active decision in full, by title or in the count, `[TC-CH-1380-03]` and, on random records, `[TC-CH-1380-06]`, also under any split of the budget, where a part with no share says nothing, `[TC-CH-1380-09]`; it trims in the order above, `[TC-CH-1380-04]`; a last turn larger than the budget is cut to its start and end with a pointer for `read_message`, `[TC-CH-1380-05]`; on the last topic of a 200-message, 4-topic chat every turn starts with fewer tokens, 86% fewer in all, `[TC-CH-1380-08]` ([evidence](../evidence/2026-11-12-context-pack-tokens.md)); the chapter summary projector writes each summary once and resumes from its cursor, `[TC-CH-1380-11]`, and never keeps a summary made before a split or merge changed its chapter, `[TC-CH-1380-13]`; and a private camp's summaries stay in that camp, `[TC-CH-1380-12]` ([#1380](https://github.com/otaviobarros/hobbots/issues/1380)). `read_message` pages the hob's own messages, with each message redacted whole before it is cut, and never another hob's, by `[TC-CH-1381-05]`, `[TC-CH-1381-06]` and `[TC-CH-1381-07]` ([#1381](https://github.com/otaviobarros/hobbots/issues/1381)). The Focus chip is not proven yet ([#1382](https://github.com/otaviobarros/hobbots/issues/1382)).
- Moving a chapter into a camp moves its messages, decisions, artifacts, open questions and quests in one transaction and leaves a stub; nothing appears in both. Not proven yet ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)).
- A changed decision is kept and crossed out; find answers "where did we decide X" from records and cites them; a private camp's entries never reach memory. Not proven yet ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)).
- The brief and chapter summaries are written by projectors that resume from their cursor after a restart and write nothing twice. Not proven yet ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)).
- With No AI chosen for the hub's brain, briefs, chapter summaries and camp suggestions still appear from their rules, and no model is called; with a brain chosen, a `HubDecider` answer that does not decode falls back to the rule. Not proven yet ([#1364](https://github.com/otaviobarros/hobbots/issues/1364)).
- Two quests in different camps that ask for a migration number get different numbers, `[TC-OR-1388-01]`; two that claim the same path each tell their lead through the backpack and neither stops, `[TC-OR-1388-02]`; a released number is never handed out again, `[TC-OR-1388-03]`; the register agrees with a model, claims at once included, `[TC-OR-1388-04]`; a retried Task claims again what its failure released, `[TC-OR-1388-05]`; and no spelling of a folder reaches a repository outside the hob's folders, `[TC-OR-1388-06]` (all in `apps/server/test/claims.test.ts`). A quest's updates land in its camp, and the camp shows the clash as a Heads-up: not proven yet ([#1389](https://github.com/otaviobarros/hobbots/issues/1389), [#1390](https://github.com/otaviobarros/hobbots/issues/1390)).
