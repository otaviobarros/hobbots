# ADR 028 — Memory

Status: **Accepted.** Adds an exception to the journal retention of [ADR 013](013-event-journal.md), a second data store beside the database of [ADR 011](011-sqlite-storage.md), a Memory group to the tool policy of [ADR 014](014-tool-policy-and-enforcement.md), a memory brief beside the briefing of [ADR 017](017-switching-brains.md), and a `memory/` entry to the backups of [ADR 026](026-backup-export-diagnostics.md). Records the design of [#937](https://github.com/otaviobarros/hobbots/issues/937) for the Hobs remember slice ([#951](https://github.com/otaviobarros/hobbots/issues/951)), and refines it in the places listed under Rationale.

## Context

Hobs forget everything between threads. A lesson one hob learns, such as how a repository runs its tests or how you like pull requests written, is gone in its next thread and never reaches the other hobs. Each runtime has its own memory (Claude Code's in `CLAUDE_CONFIG_DIR`, Codex's in `CODEX_HOME`), but it is per runtime, so a thread that switches brain (ADR 017) loses it, and nothing in it can be read, edited or shared from Hobbots.

#937 chose [ai-memory](https://github.com/akitaonrails/ai-memory) (MIT) as the engine: a local server that keeps memory as a git-versioned wiki of markdown pages with a SQLite index, works without a model, searches by full text, entities and links, ages unused pages and flags contradictions. This ADR decides how Hobbots runs it and, above all, where the boundaries sit, so that memory depends neither on a runtime (Claude Code, Codex, the next one) nor on a model provider, and so that ai-memory itself can be replaced.

The evidence for ai-memory's behavior is its documentation for 3.4.0. Every route and setting below is checked against the bundled version by the contract tests of [#953](https://github.com/otaviobarros/hobbots/issues/953) before anything relies on it.

## Decision

### Three boundaries

Memory touches the rest of Hobbots in three places, and only there:

1. **Hub tools.** Hobs reach memory only through hub tools (`HubTools`, ADR 018), the runtime-neutral channel Task tools and Charms already use. Every adapter that serves hub tools serves memory with no change.
2. **The context block.** The memory brief travels inside the context the hub already composes for a turn (below). Adapters deliver it as they deliver the ADR 017 briefing today, with no new field.
3. **The `MemoryStore` port.** Everything else in Hobbots (the tools, capture, the brief, the Memory page, Settings, backups) talks to memory through one Effect service in Hobbots' own words. ai-memory sits behind it.

So memory never runs a turn, never reads a runtime's session or files, and never knows which brain or model a thread used. A new runtime gets memory by serving hub tools and delivering the briefing, which it must do anyway.

### The `MemoryStore` service

`MemoryStore` is a `Context.Service` in `@hobbots/agents`, beside the other ports. Its types live in `@hobbots/domain` (`memory.ts`) and use Hobbots' terms:

- **Scope:** `Hob` (one hob's own memory), `Project` (a repository or folder) or `Everyone`. A thread is not a scope: what happened in a thread is a session page in its hob's scope, tagged with the thread. Quests are tags too.
- **Actor:** who a call is made for: a hob, with the project identities of the folders it works in, or you. The hub builds it from what it knows, never from a tool's input.
- **Page:** a path, its markdown, tags, its version, its author (a hob or you) and whether it is pinned.

It offers what its first callers need, and nothing that mirrors ai-memory's routes, projects or keys. Policy is built on top of it, never inside it:

| Group | Operations | Used by |
| --- | --- | --- |
| Recall | `search` over a set of scopes | `memory_search` |
| Writes | `write` a page as an actor when it is as expected (new, a given version, or anything), `forget` (answering the version that brings the page back), `restore` a version | `memory_save`, approved shares, the Memory page |
| Browse | `page`, `history`, `list` a scope up to a limit (pinned first, then the most recently changed), `changes` since a time, `scopes` that hold pages | The brief, the Memory page, What changed, Export |
| Health | `health` | Diagnostics, the outage banner |

- **The brief is not an operation.** Its rules (Everyone first, then the hob's own pages, then its projects', pinned first, within a budget) are Hobbots policy, so they are a pure function in `@hobbots/agents` over `list` and `page`, and every engine gets them unchanged. `list` takes a limit, so a brief never loads a hob's whole memory.
- **No idempotency key.** ai-memory's page write has none, only "create only" and "expected version". The key a hob gives `memory_save` lives in the hub's record of the tool call, as Task tool calls already keep theirs, so a retried call returns its first answer without reaching `MemoryStore` again.
- **Pinning is a write** with `pinned` set, against the version the caller read.
- **One guard for every engine.** Every `MemoryStore` layer is built through `guardMemoryStore`, which refuses a call before the engine sees it when its actor may not touch a scope it names: a hob reaches its own scope, the projects of its folders and `Everyone`, never another hob's scope or another project, and only you `forget` or `restore`. Its callers only name scopes the hub worked out, so a refusal is a defect.
- **Each later operation arrives with its first caller.** `capture` and `endSession` come with capture ([#956](https://github.com/otaviobarros/hobbots/issues/956)), and `check` (contradictions and stale pages) with Check now ([#960](https://github.com/otaviobarros/hobbots/issues/960)), each one more method on the same service, added to the shared `MemoryStore` tests then.

Two errors: `MemoryUnavailable` (the engine does not answer) and `MemoryConflict` (a write lost to a newer version). Callers treat the first as an outage (below) and show the second.

A later operation, such as `feedback` for the Curator, is one more method on the same service. A second engine, or connecting to an existing ai-memory server, is another `Layer` for the same service.

### The ai-memory adapter

A new adapter package, `@hobbots/memory`, holds the only code that knows ai-memory:

- **The process.** The server starts the bundled `ai-memory serve` as a child process (`effect/process`), on loopback on a random port, with its data in `<data folder>/memory`, waits until it answers, restarts it with a capped exponential backoff (`Schedule`), and stops it with the server's scope. It never runs `ai-memory run`, hooks or the agent installers: the hub owns the lifecycle, and hob runtimes load no hooks or settings from disk (ADR 014), so an ai-memory the user installed for themselves never sees hob sessions.
- **The client.** A small typed client over `effect/http`'s `HttpClient`, with every response decoded by `Schema`. It uses `/hook/batch` for capture, `/api/v1` for reads, `/admin` for your edits and `/mcp` for search and hob writes. No ai-memory SDK until one is published on npm.
- **Scopes to ai-memory projects.** One workspace per installation. `Hob` is the project `hob-<hob id>`, `Project` is `repo-<identity>` and `Everyone` is ai-memory's reserved `_global`. A project's identity is its Git `origin` remote, normalized, so two clones of one repository share it; a folder with no remote uses its folder name.
- **One hub key, acting as each hob.** The hub configures two credentials of its own: ai-memory's root bearer, for setup and your edits, attributed to you through `root_username`, and its separate trusted-proxy bearer, for everything a hob does. A hob's call sends the proxy bearer with `X-Memory-Actor-User: hob-<hob id>`, so every page and audit row says which hob wrote it, and the Memory page shows that hob's current name. Both bearers are random and kept owner-only in `<data folder>/memory-keys`, outside ai-memory's own data folder so its backup never holds them. The hub hands them to the ai-memory process in its environment, never in its config file: the root bearer as `AI_MEMORY_AUTH_TOKEN`, and the proxy bearer as `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN`, which ai-memory 3.4.0's `AI_MEMORY_` environment layer maps to `[auth].actor_proxy_bearer_token`, the setting that has no file form. The config file the hub writes for ai-memory holds neither, and the process gets no other credential. #953 checks both mappings against the bundled version, and that a sandboxed command cannot read the process's environment. They never leave the hub and never reach a sandbox. There are no per-hob ai-memory users or keys.
- **The hub is the boundary.** In proxy mode ai-memory does not enforce restricted projects, so the hub alone decides which scopes a call may touch, as it already decides every tool call. Hobs never hold a key or learn the server's address, so nothing in a sandbox can call ai-memory directly.
- **A fake.** `@hobbots/memory` also exports an in-memory `MemoryStore` for tests, so the tools, capture, the brief and the page can be tested on the fake runtime without the binary.

### The memory tools

Two hub tools, offered on every turn that offers Task tools:

- **`memory_search`** searches the hob's own scope, the projects of the folders it works in and `Everyone`, and nothing else. The hob cannot name another scope.
- **`memory_save`** saves a page with a `scope` of `mine`, `project` or `everyone` and a key. `mine` writes the hob's own scope. A share (`project` or `everyone`) is decided by the hub under the safety preset (below). A retried key returns the first answer.

Hobs get no delete tool. Both tools join a **Memory** group in the tool policy (ADR 014) with Allow, Ask or Never per hob. A refused call never reaches `MemoryStore`.

### Sharing

Hobs never write a shared scope themselves. A share from `memory_save` is handled by the preset (ADR 003):

- **Careful and Balanced:** it becomes a review item, a new Memory kind in the Inbox that counts in its badge and follows When a hob needs me. Approve, edit then approve, or decline.
- **Trusting:** a share to a project goes through and shows in Memory › What changed with Undo.
- **About you** (`Everyone`) asks under every preset.

On approval the hub writes the page as the hob, with you as the approver in its history. Pages that disagree or look stale, from Check now, wait only in Memory › To review, never in the Inbox. The Memory sidebar item never has a badge.

### Capture and summaries

- **Capture is a cursor over the journal.** The event journal is already the outbox (ADR 013). A capture worker reads journal entries after its cursor, sends a thread's messages and tool steps, already redacted when they were stored, to `/hook/batch` under the hob's scope with `thread:<id>` and `quest:<id>` tags, and moves its cursor when ai-memory acknowledges them. Each item's ingest key is derived from its journal entry's id under the producer name `hobbots`, within ai-memory's key rules (1 to 64 letters, digits, `_` or `-`).
- **Replays are deduplicated for 30 days, not forever.** ai-memory skips a key it has seen, but forgets ordinary keys after 30 days, and its own contract calls this bounded retry protection, not exactly-once. The cursor is saved as soon as a batch is acknowledged, so the only resend is the last batch, after a crash between the acknowledgement and the save: on the next start, normally minutes later. A resend more than 30 days after its first send, which needs the hub to have stopped in that gap and stayed down a month, can add a repeated observation to a session, or a second identical version of a saved page. Both are visible and harmless, nothing is lost, and the worker logs that it resent entries older than the window. Hobbots does not reconcile beyond that window.
- **One ai-memory session per Hobbots thread,** not per runtime session, so a brain switch never splits a thread's memory.
- **ai-memory writes the summary.** When a thread has been quiet for 30 minutes, or is archived, the worker ends its session, and ai-memory consolidates it into `sessions/<thread id>.md` with the memory model (below), or into its model-free summary when there is none. A thread that goes on later continues the same session. No runtime turn is spent on summaries, so an expensive brain never pays for them.

### The memory brief

- At the start of a runtime session, the hub builds the hob's brief from `MemoryStore.list` and `page`: `Everyone` rules first, then the hob's own pages, then its projects' facts, within a budget of about 8,000 characters, dropping the lowest-priority pages first. Pinned pages come first within their scope.
- The hub puts it in the turn's context block, beside the ADR 017 briefing, as a labeled section that says it is reference data, not instructions, with each page quoted as the briefing quotes messages.
- It is sent again only when it changed since the session last received it, so a long thread does not pay for it on every turn.
- When memory does not answer, the section says memory is unavailable instead, and the turn goes on.

### The memory model

Memory work that runs outside a chat (summaries, Check now, later the Curator's tidy and answers about memory) uses one model you choose in Settings › Your data › Memory: a provider, a model, an effort, a fallback (plain summaries, another provider, or wait) and optionally a model per task. No AI is a valid choice, and memory still works. Hobbots stores the choice in its own terms and the adapter writes it into ai-memory's provider settings, so the choice does not depend on a hob's brain or runtime. ai-memory reads its provider settings only at start, so a change restarts the ai-memory process, never the app; work in flight is retried by its own queues, and captures wait in the journal meanwhile. The default is a small model at low effort. Usage gets a Memory line from ai-memory's call and token counts.

### When memory is down

Hobs keep working without recall. `memory_search` answers that memory is unavailable, and the brief says so. `memory_save` is journaled first and sent by the same worker that sends capture, so a save made while ai-memory is down answers "kept, saved when memory is back" and arrives once it answers, with the same key. Journal compaction keeps every entry after the capture cursor, however old, as [ADR 013](013-event-journal.md) now allows, so a long outage costs disk, not memory. The Memory page shows the pages it last loaded under a notice banner.

### A second data store

ADR 011's single database stays the store for everything Hobbots decides and journals. Memory pages, their history and their index live in ai-memory's own data folder, `<data folder>/memory`, written only by its process. The database refers to memory only by scope and page path, and never in a transaction with it: the capture cursor and the journaled saves are what keep the two in step.

### Backups

A backup gains a `memory/` entry, made with ai-memory's own backup while the hub runs, and listed in the manifest with the others. The two bearers are managed credentials and never in a backup: they live outside `<data folder>/memory` and reach ai-memory only through its environment, and the backup refuses an ai-memory config that holds a bearer value. A restore writes new bearers, so a restored memory answers only the restored hub. Export includes each scope's pages as markdown.

- **The archive is kept whole.** `memory/ai-memory.tar.gz` is ai-memory's own archive: its wiki with its Git history, a consistent copy of its database, and the config the hub wrote. Before it is kept, the hub reads it through and refuses it when any entry is not a file or folder under those three, when a config in it holds a credential setting, or when either bearer appears anywhere in it.
- **Memory is in every backup.** While the engine starts or restarts, Back up now stops and says memory is not answering, rather than leave memory out. With the engine off, nothing writes its folder, so the hub packs that folder in the same shape, as it also does for the backup it makes before a migration, when no engine runs yet.
- **The hub restores it itself.** A restore checks the archive the same way and unpacks it into `<data folder>/memory`, owner-only, in the same step that copies the rest, so a failure puts everything back. It does not run `ai-memory restore`, which refuses while any other ai-memory process runs on the computer, such as one the user runs for themselves. The engine opens the restored wiki and database at its next start.
- **New bearers.** The old `memory-keys` file is set aside with the rest of the hub's data and a restore writes new keys, which the engine gets in its environment at its next start.
- **Export.** An export of everything holds each scope's pages as `memory/everyone/`, `memory/hobs/<name>/` and `memory/projects/<project>/`, and a hob's export holds its own. Pages are redacted like every other string. Memory that does not answer leaves the rest of the export as it is, and its README says so.

### Out of scope

The Curator routine, skill distillation into `procedures/`, `memory_feedback`, automatic rewrites and the recall test that gates them; using an existing ai-memory server; native Windows, which ai-memory marks experimental.

## Rationale

- **Boundaries over abstractions.** Hub tools and the context block already make runtimes interchangeable, so memory adds no runtime contract. One port with Hobbots' words keeps ai-memory's projects, keys and routes in one package, and keeps the port small enough that another engine (#937 names Hindsight) is one more layer.
- **ai-memory writes summaries, not the thread's brain.** #937 had the thread's current brain write the session page. That spends a turn of the thread's model, often the most expensive one, with the whole conversation in context, on the cheapest job, and it would tie memory to each runtime. ai-memory consolidates from what capture sent, with a small model or none.
- **One `memory_save` instead of `memory_save` and `memory_propose`.** Whether a write goes through or is reviewed is the preset's call, not the hob's, so the hob says where and the hub decides. `memory_feedback` waits for the Curator, which is its only reader.
- **One hub key acting as each hob, instead of a user and key per hob.** Scopes come from projects and tags whichever key is used, so separation is the same. Hobs never hold a key, so per-hob keys would only repeat a boundary the hub already holds, at the cost of provisioning, keychain items and new keys on every restore. Proxy mode keeps what per-hob users gave: history that names the hob.
- **A port of plain reads and writes.** The brief's rules, write retries and Check now's findings are Hobbots policy or belong to later callers, so the port keeps none of them. Each engine then implements less, and each later operation is shaped by the issue that first needs it, not guessed ahead of it.
- **The journal as the queue.** It is already the outbox, so capture and offline saves need one cursor, not a second queue. Its cost is a retention exception in ADR 013 and a deduplication bound of 30 days, which the cursor's prompt save makes practically unreachable.

## Consequences

- A new package, `@hobbots/memory`, in the adapter layer, which `@hobbots/server` composes. `@hobbots/domain` gains the memory types, `@hobbots/agents` the port.
- The ai-memory binary is bundled, checksum-verified, signed and notarized inside Hobbots.app, pinned to an exact release and raised on purpose, with contract tests for every route above ([#953](https://github.com/otaviobarros/hobbots/issues/953)). Upstream releases often, so a failing contract test, not a user, finds a changed route.
- The hub runs a second long-lived child process, reported in Diagnostics.
- The policy engine gains a Memory group; the Inbox gains a Memory kind; the context block gains a memory section; journal compaction learns the capture cursor, an exception to ADR 013's retention.
- ai-memory's sweep hard-deletes expired pages and old tombstones, so it stays conservative and memory is in every backup.
- If proxy mode does not behave as documented on the routes above, #954 falls back to an ai-memory user and key per hob, kept as managed credentials, with no change to `MemoryStore`.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A packaged build starts ai-memory, waits for it, restarts it after a crash with Diagnostics showing it, and stops it with the hub. A wrong checksum refuses memory, not the app. Not proven yet: [#953](https://github.com/otaviobarros/hobbots/issues/953).
- Every ai-memory route Hobbots uses, proxy-asserted hob identity included, is checked against the bundled version, with both bearers given only through the environment and none in ai-memory's config file or backup. Not proven yet: [#953](https://github.com/otaviobarros/hobbots/issues/953).
- A page a hob saves is attributed to that hob, and a hob's call cannot read or write another hob's scope. Two clones of one repository share a project. The fake and ai-memory pass the same `MemoryStore` tests. Not proven yet: [#954](https://github.com/otaviobarros/hobbots/issues/954).
- `memory_search` and `memory_save` work the same on the fake runtime, Claude Code and Codex, and a Memory group answer of Never refuses the call before ai-memory is called. Not proven yet: [#955](https://github.com/otaviobarros/hobbots/issues/955).
- A finished thread leaves one session page whichever brains it used, a replay does not duplicate it, and nothing redacted reaches ai-memory. With ai-memory stopped mid-thread, the hob keeps working and every capture and save arrives once it is back, including after an outage longer than the journal's 7-day retention. A crash between an acknowledged batch and the cursor save resends it once with no duplicate inside the 30-day key window, and a resend past the window is logged. Not proven yet: [#956](https://github.com/otaviobarros/hobbots/issues/956).
- A lesson saved in one thread is in the next thread's brief for the same hob and never in another hob's; the brief stays within its budget, is resent only when it changed, and says memory is unavailable during an outage. Not proven yet: [#957](https://github.com/otaviobarros/hobbots/issues/957).
- A share under each preset behaves as decided, and About you asks under every preset. Not proven yet: [#960](https://github.com/otaviobarros/hobbots/issues/960).
- A changed memory model applies to the next summary after restarting only the ai-memory process, never the app, and No AI makes no model call. Not proven yet: [#962](https://github.com/otaviobarros/hobbots/issues/962).
- A restored backup brings back every page and its history, and the old bearers no longer work. Proven against the bundled ai-memory: `[TC-OP-098]`; and at hub level, with no bearer in the backup: `[TC-OP-095]` to `[TC-OP-097]`, `[TC-OP-099]` ([#963](https://github.com/otaviobarros/hobbots/issues/963)).
- End to end on the fake runtime: a lesson learned in one thread shows up in the next, a share goes through the Inbox, an outage loses nothing, and a restore keeps memory. Not proven yet: [#964](https://github.com/otaviobarros/hobbots/issues/964).
