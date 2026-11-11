# Chat and camps

**Decided, not built** ([ADR 037](../decisions/037-chat-and-camps.md)). Until the slices in milestone v0.0.5 land, the [conversations contract](conversations.md) describes what runs. This contract is the shape the slices build: records, their states, and the rules each must keep. How state changes and events flow is in the [state and events contract](state-and-events.md).

## Threads

A thread is a chat or a camp. The UI says chat or camp and never thread; the code keeps `Thread`.

| Field | Meaning |
| --- | --- |
| `kind` | `chat` or `camp` |
| `goal` | A camp's goal; null for a chat |
| `private` | A private camp is never captured into memory; it still reads the memory brief |
| `origin` | The thread and chapter a camp came from, or null |
| `state` | `ThreadLifecycle`: open, archived, superseded |

- Each hob has exactly one open chat, held by a partial unique index. Built in [#1375](https://github.com/otaviobarros/hobbots/issues/1375), with the fields above and [ThreadLifecycle](machines/thread-lifecycle.md); until the rail and Start fresh land, a hob whose chat is archived has none until its next thread opens one, and a chat restored while another is open comes back as a camp.
- Start fresh moves the chat to superseded and opens a new one. What it still owes you is recorded as `CarriedItem` rows and appears in the new chat once.
- Migration (0095): each hob's most recent open thread becomes its chat; its others become camps with their titles. A skill trial stays a camp.
- Slice: [#1362](https://github.com/otaviobarros/hobbots/issues/1362).

## Chapters

| Field | Meaning |
| --- | --- |
| `threadId`, `number`, `title` | Where it is and what it is about |
| `summary` | One line, written by a projector when the chapter rests |
| `startedAt`, `endedAt` | When it ran |
| `movedTo` | The camp it moved to, or null |
| state | `ChapterState`: live, resting, moved |

- Exactly one chapter per thread is live. Every message has a `chapterId`.
- The hob ends a chapter with `start_chapter` on every runtime. You can split or merge. A hub rule may suggest; it never splits.
- A runtime session belongs to one chapter. A new chapter starts a new session from the context pack.
- Moving a chapter into a camp re-parents it with its messages, decisions, artifacts, open questions and the quests it started, in one transaction, and leaves a stub. A running quest moves whole.
- Slices: [#1363](https://github.com/otaviobarros/hobbots/issues/1363), [#1364](https://github.com/otaviobarros/hobbots/issues/1364).

## Records

Each is written in the same transaction and journal as the message that made it, and carries an explicit `actor`.

| Record | Key fields | States |
| --- | --- | --- |
| Decision | text (at most 500 characters), actor, threadId, chapterId, sourceMessageId, supersededBy | active, superseded; a changed decision is kept, crossed out |
| Artifact | kind (code, page, doc, email, image, PR, file), title, latestVersion, origin | a registry over what Attempts and Quests record; copies nothing |
| Brief | threadId, text, revision, writtenBy, basis cursor | rewritten by a projector at chapter ends and quest steps |
| CampSuggestion | threadId, chapterId, reason codes and counts | open, kept, accepted, expired; at most one per chapter |
| CarriedItem | fromThreadId, toThreadId, ref | written once by Start fresh |
| Claim | scope (migration number, ADR number, path, branch), key, holder Task | held, released, contested; unique on scope and key |

A note to self is a message role that never wakes the dispatcher.

## The context pack

`buildPack(records, budget)` is pure and deterministic. It makes a session's starting context from:

1. the memory brief (its own budget, ADR 028),
2. the camp brief,
3. active decisions,
4. the artifacts index,
5. the live chapter's turns,
6. one line per resting chapter,
7. carried items.

Every part has a share of the budget, and the shares add up to it. The pack never goes over its budget.

- **Over budget**, it trims in this order: resting chapter lines, the oldest artifacts, the live chapter's oldest turns. Each trim leaves one line saying what was left out.
- **Active decisions never drop silently.** Over their share, the newest stay in full and the rest are listed by title; past that, a count, and the hob reads them with find.
- **A last turn too large for its share** is carried as its start and end with a pointer. The hob reads the rest with `read_message`, which pages a message as `web_fetch` pages a page (ADR 036).
- **`PackReport`** records each part, its size in tokens and what was trimmed. The Focus chip shows it.
- Transcript replay remains only for a brain switch inside a live chapter (ADR 017).
- Slice: [#1363](https://github.com/otaviobarros/hobbots/issues/1363).

## Quests in camps

- A quest belongs to the thread that started it (`Quest.threadId`, `Task.threadId`). Its updates and questions land there.
- A quest opens as a thread in its camp's sheet. ADR 027's records stand; its lanes layout is retired.
- `QuestSummary` on the hub feeds the quest pill, the sidebar and Home.
- Slice: [#1365](https://github.com/otaviobarros/hobbots/issues/1365).

## The claims register

- `claim` hands out the next free migration or ADR number across every hob, chat and camp, and records path and branch claims.
- A pure rule in the claim's transaction finds clashes with every open claim. The hub settles what it can and tells each lead through the backpack; the camp shows a Heads-up. It calls no model.
- Claims are released when their Task ends. Whether a released number may be handed out again is not decided yet; [#1388](https://github.com/otaviobarros/hobbots/issues/1388) settles it.
- Slice: [#1365](https://github.com/otaviobarros/hobbots/issues/1365).

## The hub's brain

One model for the hub's own judgments, chosen in Settings and onboarding, extending ADR 028's memory model. It writes briefs and summaries and judges topic drift and quest clashes in meaning, only in projectors, through `HubDecider`. Under No AI every judgment falls back to its rule ([#1367](https://github.com/otaviobarros/hobbots/issues/1367)).

- **Settings.** `MemorySettings` in `@hobbots/domain` is the brain: provider, model, effort and fallback, with a model per task. The hub's own tasks are `brief`, `chapters` and `judgments`, beside the memory tasks; a settings file saved before them reads each as `same`. `hubTaskModel` says which model a task asks for, or `none` under No AI.
- **The port.** `HubDecider` in `@hobbots/agents` takes a `Judgment`: the task, the question, the input, a `Schema` of the choices and the caller's rule. It returns a `Decided`: the choice, a confidence from 0 to 1, and whether the brain or the rule made it. `HubDecider.rules` answers every judgment with its rule.
- **The brain.** `HubBrainDecider` in `@hobbots/memory` runs each judgment as one turn through the hub's model endpoint, on Claude Code or Codex, with no tools and no session. It reads the settings on every judgment, so a change applies to the next one. A runtime that cannot run it passes it to the `other` fallback; a reply that does not decode leaves the rule. The endpoint counts these turns for Usage, since the memory engine never sees them.

## Words

| UI | Code |
| --- | --- |
| hob | `Agent` |
| chat, camp | `Thread` with `kind` |
| chapter | `Chapter` |
| decision | `Decision` |
| artifact | `Artifact` |
| brief | `Brief` |
| quest | `Quest` |
| (not shown) | `Attempt`; never "execution" |

The [glossary](../product/glossary.md) holds these terms.
