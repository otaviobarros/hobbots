# Chat and camps

**Decided, not built** ([ADR 037](../decisions/037-chat-and-camps.md)). Until the slices in milestone v0.0.5 land, the [conversations contract](conversations.md) describes what runs. This contract is the shape the slices build: records, their states, and the rules each must keep. How state changes and events flow is in the [state and events contract](state-and-events.md).

## Threads

A thread is a chat or a camp. The UI says chat or camp and never thread; the code keeps `Thread`.

| Field | Meaning |
| --- | --- |
| `kind` | `chat` or `camp` |
| `goal` | A camp's goal; null for a chat |
| `private` | A private camp keeps nothing in memory: capture skips what was written while it was private, and any message or Attempt that had an entry then, even once it is public again, and a `memory_save` from it is refused. It still reads the memory brief |
| `origin` | The thread and chapter a camp came from, or null |
| `state` | `ThreadLifecycle`: open, archived, superseded |

- Each hob has exactly one open chat, held by a partial unique index. Built in [#1375](https://github.com/otaviobarros/hobbots/issues/1375), with the fields above and [ThreadLifecycle](machines/thread-lifecycle.md); until the rail lands, a hob whose chat is archived has none until its next thread opens one, and a chat restored while another is open comes back as a camp.
- **Make a camp** (`POST /api/agents/:agentId/camps`) writes a camp with its title, goal and `private`, and journals `CampMade`, in one transaction. Built in [#1376](https://github.com/otaviobarros/hobbots/issues/1376).
- **Start fresh** (`POST /api/threads/:threadId/start-fresh`) moves the chat to superseded and opens a new one whose `origin` is the old chat, in one transaction that journals `ChatStartedFresh`. It moves the chat's open work: the Tasks you asked for there that are not over, with their trees and Quests, and every backpack item held for it that is not resolved, each journaled as `BackpackItemChanged`. Each Task, open question in their trees, reminder and item the chat's turns carry is recorded once as a `CarriedOver` row (the ADR's `CarriedItem`). The new chat's first turn is told what was carried over, and the dispatcher delivers what waited there once. It is refused, as an archive is, while a reply runs or waits, while an approval waits, or for a retired hob, and for a thread that is not its hob's open chat. A superseded chat is read-only for good and listed with the hob's archived threads. Built in [#1376](https://github.com/otaviobarros/hobbots/issues/1376).
- Both take a key that becomes the new thread's id: the same request sent again returns what it did, and a key that names another thread is refused (`ThreadKeyReused`). Make a camp keeps what it was asked under its key (`camp_requests`), so the request still matches after the camp is renamed.
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

- Exactly one chapter per thread is live, its last, held by a partial unique index. Every message has a `chapterId`: a new message joins the live chapter as it is stored, and a queued one again as it starts. The database refuses a message without one. A thread stored for the first time starts its first chapter in the same transaction, journaled as `ChapterStarted`. A read thread carries its `liveChapterId`, worked out when it is read. Built in [#1379](https://github.com/otaviobarros/hobbots/issues/1379), with [ChapterState](machines/chapter-state.md).
- The hob ends a chapter with `start_chapter` on every runtime ([#1381](https://github.com/otaviobarros/hobbots/issues/1381)). You can split or merge ([#1382](https://github.com/otaviobarros/hobbots/issues/1382)). A hub rule may suggest; it never splits.
- The commands are `ChapterService.startChapter`, `splitChapter` and `mergeChapters` in `packages/agents/src/chapters.ts`, each refused on an archived or superseded thread. Their rules are the pure `planStart`, `planSplit` and `planMerge` in `@hobbots/domain`, run in the transaction that writes the result and journals one event: `ChapterStarted`, `ChapterSplit` or `ChapterMerged`. Starting and splitting take the new chapter's id as their idempotency key; a merged chapter's id is remembered, so merging it again changes nothing.
- Start ends the live chapter, which rests, and refuses an empty title or a live chapter with no message yet. Split cuts a chapter at one of its messages, not its first: the messages from there on make a new chapter right after it, live when the one it came from was. Merge brings a chapter's messages into the chapter before it, which keeps its id and title and is live when the merged one was. Both number the chapters again from 1.
- A runtime session belongs to one chapter: `RuntimeSession` is keyed by thread, runtime and chapter, and `liveSession` gives the one a turn resumes. A turn in a new chapter, after a start, a split of the live chapter or a merge into it, starts a new session in place of the old chapter's, which is never resumed, on Claude Code, Codex and every runtime alike. Until the context pack lands ([#1380](https://github.com/otaviobarros/hobbots/issues/1380)), a new chapter's session hears only the memory brief and the roster, and a brain switch is briefed with the live chapter's transcript alone. A merge into the live chapter makes it live again with a new session: each session records how many chapters had been merged into its chapter when it started (`chapterMerges`), and `liveSession` resumes it only while that matches `Thread.liveChapterMerges`. So a session a turn under way records after the merge, from a read before it, is never resumed, with no lock shared between the turn and the merge. The merge also drops the sessions the chapter held. A split or merge also drops the thread's briefing checkpoint, and gives the messages it moves the revision of its event, so a client holding an older version takes the new one; a thread you had read stays read.
- Moving a chapter into a camp re-parents it with its messages, decisions, artifacts, open questions and the quests it started, in one transaction, and leaves a stub. A running quest moves whole.
- Migration (0098): each thread gets one live chapter holding its history, started when the thread was made, with no title; every message joins it, and every session the thread keeps belongs to it and goes on being resumed.
- Slices: [#1363](https://github.com/otaviobarros/hobbots/issues/1363), [#1364](https://github.com/otaviobarros/hobbots/issues/1364).

## Records

Each is written in the same transaction and journal as the message that made it, and carries an explicit `actor`.

| Record | Key fields | States |
| --- | --- | --- |
| Decision | text (at most 500 characters), actor, threadId, chapterId, sourceMessageId, supersededBy | active, superseded; a changed decision is kept, crossed out |
| Artifact | kind (code, page, doc, email, image, PR, file), title, latestVersion, origin | a registry over what Attempts and Quests record; copies nothing |
| Brief | threadId, text, revision, writtenBy, basis cursor | rewritten by a projector at chapter ends and quest steps |
| CampSuggestion | threadId, chapterId, reason codes and counts | open, kept, accepted, expired; at most one per chapter |
| CarriedOver (the ADR's CarriedItem) | fromThreadId, toThreadId, ref (Task, question, reminder or backpack item), label | written once by Start fresh |
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
