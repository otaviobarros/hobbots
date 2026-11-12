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
- Migration (0099): each thread gets one live chapter holding its history, started when the thread was made, with no title; every message joins it, and every session the thread keeps belongs to it and goes on being resumed.
- Slices: [#1363](https://github.com/otaviobarros/hobbots/issues/1363), [#1364](https://github.com/otaviobarros/hobbots/issues/1364).

## Records

Each is written in the same transaction and journal as the message that made it, and carries an explicit `actor`.

| Record | Key fields | States |
| --- | --- | --- |
| Decision | text (at most 500 characters), actor, threadId, chapterId, sourceMessageId, supersededBy | [DecisionState](machines/decision-state.md): active, superseded; a changed decision is kept, crossed out |
| Artifact | kind (code, page, doc, email, image, PR, file), title, latestVersion, origin | a registry over what Attempts and Quests record; copies nothing |
| Brief | threadId, text, revision, writtenBy, basis cursor | rewritten by a projector at chapter ends and quest steps |
| CampSuggestion | threadId, chapterId, reason codes and counts | open, kept, accepted, expired; at most one per chapter |
| CarriedOver (the ADR's CarriedItem) | fromThreadId, toThreadId, ref (Task, question, reminder or backpack item), label | written once by Start fresh |
| Claim | scope (sequence, path, branch), repository, key, holder Task, actor | [Claim](machines/claim.md): held, contested, released. A number is unique in its folder of a repository for good; an open path or branch once per Task |

A note to self is a message role that never wakes the dispatcher.

### Decisions and artifacts

Built in [#1383](https://github.com/otaviobarros/hobbots/issues/1383): `Decision` and its [DecisionState](machines/decision-state.md) machine in `packages/domain/src/decision.ts`, `Artifact` and the registry's rules in `artifact.ts`, the store in `packages/persistence/src/records.ts` and `artifact-rows.ts` (migration 0100), and `Records` and `record_decision` in `packages/agents/src/records.ts`.

- **`record_decision`** is a hub tool on every runtime that serves hub tools, Claude Code, Codex and the fake one alike, offered to a turn that writes a reply in a chat or camp. It takes the decision's `text`, a `key` and, for a decision that changes an earlier one, `replaces` with its id. The decision is recorded by the hob, from the reply, in the reply's chapter, redacted as everything the journal holds is. A text over 500 characters, an empty one, or a closed chat or camp is refused, and nothing is written. The same key with the same input returns the first decision; with another input it is refused.
- **Replace and cross out.** A decision is never edited. A new one that replaces an earlier one crosses the old one out in the same transaction, which points at the new one. You can record a decision in the app, replacing one or not, and cross one out with nothing in its place. The routes are `GET` and `POST /api/threads/:threadId/decisions` and `POST /api/threads/:threadId/decisions/:decisionId/cross-out`. A crossed-out decision is kept and listed, and never comes back.
- **Artifacts.** The registry is filled in the transaction that journals what it indexes, by a pure rule as backpack items are: a Task's results as it completes (a file by its path, a link by its URL, a text by its id), an Attempt's settled changes that left a file, and the files a finished reply's tool steps wrote. Each artifact is one row in its chat or camp, by where it is, at its latest version: every record that made or changed it counts once, and the same record again changes nothing. Its kind comes from its name or URL: code, page, doc, email, image, a pull request, or another file. `GET /api/threads/:threadId/artifacts` lists them, the most recently changed first.
- **Events.** `DecisionRecorded`, `DecisionSuperseded` and `ArtifactRegistered`, version 1, each with the whole record.
- **Authors.** Every message names its author: you (`{ kind: "user", id: "owner" }`, the hub's one person until shared camps) or the thread's hob, set as the hub stores it. Migration 0100 gave every stored message and every journaled `MessageUpserted` and `MessageQueued` one, and the database refuses a message without one. Decisions, artifacts and claims carry theirs.
- **The pack.** `Records.activeDecisions` and `Records.artifactsOf` are what the context pack reads ([#1380](https://github.com/otaviobarros/hobbots/issues/1380)).
- **Not built yet.** The camp sheet's Decisions and Artifacts tabs ([#1387](https://github.com/otaviobarros/hobbots/issues/1387)), find over them ([#1386](https://github.com/otaviobarros/hobbots/issues/1386)) and moving them with a chapter ([#1385](https://github.com/otaviobarros/hobbots/issues/1385)).

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

Built in [#1388](https://github.com/otaviobarros/hobbots/issues/1388): `Claim` and its machine in `packages/domain/src/claim.ts`, the register in `packages/persistence/src/claims.ts` (migration 0098), and `claim` with the Task tools on every runtime.

- **`claim`** is a Task tool. It records a claim for the Task the hob works on, and in a chat with no Task yet it starts one, as `plan_steps` does. A claim names a folder of the hob's, inside a Git repository. The repository is known by its `origin` remote, so two clones or worktrees share their claims. The named folder is resolved, links and `..` taken as the kernel walks them, before it is checked against the hob's folders, and a hob given part of a repository claims paths and numbered folders only inside that part.
- **Sequences.** A `sequence` claim is the next number in a folder whose files start with one: migrations, ADRs, or any other numbered files. The hob names the folder whose files the numbers count, such as `docs/decisions`. The hub reads that folder on the repository's default branch as the clone has it (`origin`'s HEAD, else `origin/main`, else `main`), without running Git, and hands out one past every number `main` and the register hold. A number the hob already uses is kept when it is free; otherwise the hub settles on the next free one and says so. Concurrent claims take the journal's head in turn, so each gets its own number.
- **A released number is never handed out again** (decided in #1388). Reusing it would keep numbers dense, but a number seen in a closed branch would then mean two things. A number is unique in its folder of a repository for good, released or not.
- **Paths and branches.** A pure rule in the claim's transaction finds clashes with every other Task's open claim in the same repository: the same branch, or a path that is the other or inside it, comparing whole names. The new claim and each held claim it clashes with become contested. Each lead involved gets a `claim-clash` backpack item: the nearest lead still at work above the Task, or its owner when nobody leads it. Neither Task is stopped. A claim of the same path or branch by the same Task again changes nothing. It calls no model.
- **Release.** A Task's claims are released in the transaction that ends it, completed, failed or cancelled, at any depth; a contested claim that clashes with nothing left goes back to held. A retry that reopens a failed Task does not bring its claims back, and the retried Task may claim the same paths and branches again.
- **Not built yet.** The camp's Heads-up for a clash ([#1390](https://github.com/otaviobarros/hobbots/issues/1390)).
- **Next.** Claims beyond the repository: spaces from connectors, four clash shapes, read or write, how hard a clash bites, and claims the hub makes on its own ([#1413](https://github.com/otaviobarros/hobbots/issues/1413), ADR 037 amendment).
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
