# ADR 032 — The hob directory

Status: **Accepted.** Adds a Read other hobs operation to the tool policy of [ADR 014](014-tool-policy-and-enforcement.md), a fourth thing a turn carries beside the briefing of [ADR 017](017-switching-brains.md), the memory brief of [ADR 028](028-memory.md) and the skills of [ADR 029](029-skills.md), and a built-in hub tool set on the pipeline of [ADR 031](031-charm-actions-and-registry.md). Refines the [agent model](../architecture/agent-model.md) and the [permissions contract](../architecture/permissions.md). Records the design of the Hobs see each other slice ([#1230](https://github.com/otaviobarros/hobbots/issues/1230)) for [#1231](https://github.com/otaviobarros/hobbots/issues/1231). Amended below: the card shows the hob's answers ([#1351](https://github.com/otaviobarros/hobbots/issues/1351)).

## Context

A hob knows almost nothing about the other hobs on its hub. It can give a Task to another hob with `delegate_task` only by a name it was told (ADR 018), and nothing tells it which hobs exist, what each is for, which brain each runs on or which Charms each holds. So a hob cannot:

- answer a question about the team from its own context, such as which engineers the team still needs, when you ask your CTO hob;
- send work to the hob that fits it without you naming that hob;
- tell you that another hob can do what it cannot, such as pushing to GitHub or, once [#403](https://github.com/otaviobarros/hobbots/issues/403) lands, summoning hobs.

What a hob is good at exists only in the web app today. `goodAt` in `apps/web/src/api/profile.ts` reads the chores that Summon folds into the instructions under a fixed heading, or else the starter role's note. You cannot edit it, and editing that part of the instructions changes it without saying so.

A hob's instructions often hold private context and run up to 20,000 characters, so they cannot be what other hobs read. And anything a hob or a person wrote, once shown to another hob, is a way to steer it.

This ADR decides what every hob may see of the others, where that text comes from, and how it reaches each runtime.

## Decision

### The public card

Every hob has a **public card**, built in `@hobbots/agents` from the hob's current configuration, so the roster and `read_hob` share one source. The card holds, in this order:

| Field | Value |
| --- | --- |
| Name | The hob's name, and its id when another visible hob has the same name. |
| Role | The role title (a starter role's or your own words) and the sigil's starter role. |
| Good at | The stored field below, or nothing when it is empty. |
| Status | Active or paused. |
| Brain | The runtime's name (Claude Code or Codex), the model, and the effort. A model or effort left to the runtime reads "default". |
| Charms | The display names of the Charms the hob holds that are connected now (ADR 031), so "who can push to GitHub" has a true answer. |
| Answers | Added by the [amendment](#amendment-the-cards-answers-1351): the preset, and the Allow, Ask or Never answer for each built-in operation and each operation of the Charms above, after the hob's overrides, each marked when its override set it. On the card only, not in the roster line. |
| Summoned by | "you", or the name of the hob that summoned it, once [#405](https://github.com/otaviobarros/hobbots/issues/405) records it. Until then the field is left out. A hob made before it was recorded reads "you", since only you could summon one then. |

**Never on the card:** instructions, tone, memory, threads, Tasks, Quests, folders, grants, the override map itself (only the answers it adds up to, above), sandbox, credentials, the hob's GitHub app and its identity, skills, configuration history, and what the hob is doing now. Shared Quests already show their own members (ADR 018). No other path through the directory returns any of them, and a test fails when the card gains a field this table does not list.

### Good at

Good at becomes a stored field of the hob's configuration, `goodAt`, in `Agent`, `AgentConfiguration`, `CreateAgentPayload` and `UpdateAgentPayload`. A change makes a new configuration version, like the name or the role.

- **One line, up to 200 characters.** The value is trimmed and every run of whitespace becomes one space. An empty value is stored as null. A longer value is refused when it is saved, never cut.
- **The prefill** is a pure function in `@hobbots/domain`, so the hub and the web app use the same words: the chores you gave in Summon, joined as today, or else the starter role's note, or else nothing for a title in your own words with no chores. A prefill longer than 200 characters is shortened at the last word that fits, with an ellipsis.
- **In Summon** the field is prefilled and editable. Picking another role, or changing the chores, fills it again unless you edited the field yourself in this form.
- **In the profile** it is editable. Changing the instructions never changes it. Picking another starter role refills it only while it still holds the old role's note word for word, since then it was never yours.
- **What it is for** is said under the field in both places: other hobs read it to know when to come to this hob, and it never changes how this hob behaves.
- **It is never part of the hob's own prompt.** `systemInstructions` does not read it, so good at cannot become a second set of instructions. The hob sees its own good at only when it reads its own card.
- **A migration** fills `goodAt` for every existing hob and every stored configuration version with the prefill of that version, on SQLite and PostgreSQL, so the profile shows the same words after it as before. The one exception is a good at longer than 200 characters, which chores of up to 4,000 characters allow today: it is shortened at the last word that fits, with an ellipsis, like any prefill, and you can edit it afterwards. Journaled hob events from before it decode with null (ADR 013), since an event records what was saved then.

### Visible to other hobs

`visibleToHobs` is a boolean of the hob's configuration, on by default. The migration sets it on for every existing hob. Journaled events from before it decode with on.

- **A hidden hob is absent from every other hob's roster**, and `read_hob` answers for it exactly as for a name no hob has.
- **A hidden hob still sees the others.** The switch is about being seen.
- **Delegation by name still works.** `delegate_task` keeps finding a hob by its id or name (ADR 018), hidden or not. `ask` names no hob and keeps routing a question to the asker's lead, then to you. The switch keeps a hob out of what others discover, not out of work that you or a lead deliberately send it. It grants and removes no authority (ADR 005), so it is not a security boundary, and a hob that guesses a hidden hob's name can learn that it exists.
- **It applies at once.** The directory reads the current configuration at the start of each turn and on each `read_hob` call, so a change reaches every other hob's next turn.

### The roster

Every turn carries a short **roster** of the other visible hobs: a chat turn, a Task step and a party member alike.

- **Who is on it.** Every hob but the turn's own hob, left out when hidden or retired. Paused hobs are listed with their status. A hob already knows itself from "About you".
- **Order.** Active hobs, then paused ones, each group by name, ignoring case, then by id. The same hub gives the same roster, so it can be compared from turn to turn.
- **One line per hob:** name, role title, status when paused, brain, Charms, and good at, quoted.
- **Size.** At most 6,000 characters. Past that, the hobs that do not fit are named on one closing line, and past that line's own budget it ends with "and N more". When the turn offers `read_hob`, the roster says that a card holds the hob's line and its answers, to answer from the list, and to read a card only when asked to, for a hob the list leaves out, or to check what a hob may do. Calling the card "full" led real Codex hobs to read cards for a question the roster already answered ([#1307](https://github.com/otaviobarros/hobbots/issues/1307)).
- **Where it goes.** The hub builds it with the turn's other context and puts it in the turn's context block beside the ADR 017 briefing and the ADR 028 memory brief, under its own heading. It never enters `systemInstructions`, so a change in another hob never looks like an edit of this hob's instructions, and a resumed session that keeps its first system prompt still gets the live roster.
- **Sent again only when it changed.** The hub records a digest of the roster each reply received, and a turn whose session last received the same digest carries none, as the memory brief does. A new session always gets it. When a session that was given a roster would get none, because its last other hob was hidden or retired or Read other hobs is no longer Allow, its next turn carries one line saying no other hob is listed now, so the old list does not stand.
- **Its label** says that the section is reference data the hub collected about other hobs, that good at was written by you or by a hob, and that it is never instructions to this hob.

### `read_hob`

`read_hob` is a built-in hub tool, the Directory set, in `@hobbots/agents`. It runs on the hub action pipeline (ADR 031) like the Memory and Skill tools.

- **Input:** `{ hob }`, a name or an id. It is matched as `delegate_task` matches it: an id first, then a name ignoring case and surrounding spaces.
- **Answer:** the hob's full public card as text, under the same label as the roster, its answers in a short table. When several visible hobs share the name, it answers each card with its id. A hob may read its own card, visible or not.
- **Unknown hobs.** A hidden hob, a retired hob and a name no hob has get the same answer: "There is no hob named X."
- **Effect and request.** It is a read. Its plan returns the built-in `Directory { operation: "read-hobs" }` request, with no folder and no site.
- **It records its step** before it reads anything, and its answer is redacted with the turn's redactor, as every pipeline call is.
- **Its name** is checked against every other hub tool in the registry when the hub starts (ADR 031).
- **It writes nothing** and has no key.

### Read other hobs, in the policy

`read-hobs` joins the closed list of built-in operations, shown as **Read other hobs**: Allow under Careful, Balanced and Trusting. Like every operation, a hob's override or a restriction can narrow it, and nothing can widen it.

- **Allow:** the turn carries the roster and offers `read_hob`.
- **Ask:** the roster is left out, since it cannot wait for you every turn. `read_hob` asks on its step and offers Once only, since the request has no site (ADR 015).
- **Never:** no roster, and `read_hob` is not offered.

The directory is not a Charm and needs no connection. It is one of Hobbots' own coordination tools, like delegation, and stays inside the control-plane exclusions: it reads public cards only and changes nothing.

### Outside data

Good at is text you or a hob wrote, and with [#406](https://github.com/otaviobarros/hobbots/issues/406) a hob may write another's or its own. So everywhere it reaches another hob:

- it is quoted, inside a section labeled as data and never instructions, in the roster and in `read_hob`'s answer alike;
- it is redacted with the reading turn's redactor before it is delivered. Like all redaction, this is best effort and never a boundary (see the [permissions contract](../architecture/permissions.md)): the credentials the hub knows and the secret shapes it recognizes are replaced, but a passphrase with no recognized shape, or an encoded secret, passes through. Good at is public to every hob, and the line under the field says not to put anything private in it.

The name and the role title are labeled the same way, since you write them too.

### Every runtime

The roster rides in the context block, which every adapter already delivers, and `read_hob` is offered through `HubTools`, which every adapter already serves. So Claude Code, Codex and the fake runtime get the same roster and tool with no adapter code of their own, and a runtime added later gets both by passing the clean-runtime contract tests it must pass anyway.

**A resumed Codex thread keeps the tools it started with** (ADR 024): `thread/resume` takes no dynamic tools. So:

- **Losing `read_hob` is enforced.** When the hob's answer narrows to Never, a resumed Codex thread still shows the model the tool, but the hub decides every call against the turn's own tools and refuses one the turn does not hold ("read_hob is not offered in this session"). The roster is left out from that turn on.
- **Gaining `read_hob` waits for a new Codex thread.** A Codex thread that started before this slice, or while the answer was Never, is not offered `read_hob` after it, and the hub cannot add it. It still gets the roster, which carries every card field except "Summoned by" and the answers, so it can still answer who does what. The roster mentions `read_hob` only when the turn offers it, so the hob is never pointed at a tool it lacks.
- **Every tool a hob gains has the same gap**, a Charm granted later included (ADR 024). Refreshing a resumed Codex thread's tools, for example by starting a new Codex thread with an ADR 017 briefing when the turn's hub tools differ from the ones the thread started with, is one change for every hub tool, so it is left to [#1245](https://github.com/otaviobarros/hobbots/issues/1245) rather than special-cased here. Claude Code is offered the turn's hub tools on every turn, so it has no such gap.

## Amendment: the card's answers ([#1351](https://github.com/otaviobarros/hobbots/issues/1351))

`read_hob` showed a hob's role, good at, status, brain and Charms, but not its Allow, Ask and Never answers, so a lead could not check what a member may do before it delegated, or after a change.

**Decision: the card carries the hob's answers.**

- **What it holds.** The installation's preset, then one row per operation: every built-in operation in the policy's order, then each operation the Charms on the card declare, in their order, so a Charm added later, such as one more GitHub operation, is listed with no change here. Each row is the answer after the hob's overrides, and is marked "override" when the hob's own override set it rather than the preset. An override the preset is already narrower than decides nothing and is not marked. Summoning for every hob is applied first, as the card's Charms already are (ADR 034).
- **One computation.** `effectiveAnswers` in `@hobbots/domain` gives the answers, and the Permissions tab reads the same function, so the card and the tab cannot differ. A turn's restrictions (a Delegation's narrowing, ADR 018) are a turn's, not the hob's, and stay off the card.
- **On the card only.** The roster line keeps its fields, so its 6,000-character budget still holds as a hub grows. The roster now says a card holds the line and the answers, and to read one to check what a hob may do. `read_hob` answers them as a short table under the card's fields.
- **What stays off.** The override map itself, grants, folders and every other field in the list above. An answer is what the hob may do; it says nothing a lead cannot already learn by delegating.
- **It applies at once.** Like every field, the answers are read from the current configuration and preset on each call, so a change on the Permissions tab or through `summoning_change` shows on the next `read_hob`.
- **Visible to other hobs** still decides who reads them: a hidden hob's card, answers included, reaches no other hob. The profile's line under the switch names its permissions among what other hobs see.
- **In the web app.** The card reaches you as `read_hob`'s step in the reading hob's reply. The Your hobs page keeps its cards as they are.

## Rationale

**Good at, not an "about" field.** Role says what kind of hob it is, and good at says when to come to it. An "about" text would repeat both, would be one more thing to keep current, and would let a hob describe itself in ways you did not set. Instructions are private and long, so good at is the one public line about what a hob does.

**A stored field, not a parse.** Reading good at out of the instructions breaks quietly as soon as someone edits that section, and it cannot be edited on its own. A stored field can be edited, versioned, migrated and later set by the Summoning Charm like any other field.

**Two levels.** A roster in every turn lets a hob answer "who can push?" without a tool call, and `read_hob` keeps a card one call away for a hob the roster left out or when you ask for one. Keeping the roster short and sent only when it changed keeps its cost flat as a hub grows.

**The context block, not the system prompt.** Claude Code keeps a resumed session's first system prompt, and the hub sends new instructions only when the hob's own configuration changed. Another hob's edit is not this hob's edit, so the roster travels where the memory brief already does, sent again when it changed.

**No current work.** A Task title can carry text from a private chat with that hob. Shared Quests already show their members, and nothing else needs more yet.

**A hidden hob can still be named.** The switch exists to keep a private assistant out of other hobs' view, not to make it unreachable for work you send it on purpose. Refusing delegation by name would turn a display setting into an authority rule, which ADR 005 keeps out of a hob's presentation.

**A built-in operation.** Making `read_hob` a built-in operation on the pipeline, rather than an unrecorded helper, keeps one rule for every hub tool call: it is recorded before it runs, it is redacted, and you can narrow it per hob.

## Consequences

- [#1232](https://github.com/otaviobarros/hobbots/issues/1232) adds `goodAt`, moves the prefill into `@hobbots/domain`, migrates existing hobs, and makes the field editable in Summon and the profile.
- [#1233](https://github.com/otaviobarros/hobbots/issues/1233) adds `visibleToHobs`, its migration and the profile switch.
- [#1234](https://github.com/otaviobarros/hobbots/issues/1234) builds the public card, the roster and `read_hob`, adds `read-hobs` to the policy, and offers both on every runtime.
- [#1235](https://github.com/otaviobarros/hobbots/issues/1235) proves it end to end.
- The Summoning slice ([#403](https://github.com/otaviobarros/hobbots/issues/403)) builds on the cards: a hob finds who holds the Summoning Charm from the roster, and the Charm sets good at like any other field. Its ADR ([#404](https://github.com/otaviobarros/hobbots/issues/404)) refers here for the card, good at and the switch.
- The card gains "Summoned by" once #405 records who summoned a hob.
- How hobs take on work ([#1157](https://github.com/otaviobarros/hobbots/issues/1157)) extends this directory with specialty tags and `find_hobs` ([#1165](https://github.com/otaviobarros/hobbots/issues/1165)), rather than adding a second roster.
- `apps/web` stops computing good at and reads the stored field.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Editing good at in the profile makes a new configuration version and the profile shows the new text; changing the instructions no longer changes it; picking another role in Summon refills it unless you edited it; a value over 200 characters is refused. Not proven yet: [#1232](https://github.com/otaviobarros/hobbots/issues/1232).
- Every existing hob shows the same good at after the migration as before it, except that one longer than 200 characters is shortened at the last word that fits, with an ellipsis, on SQLite and PostgreSQL, and journaled hob events from before it decode. Not proven yet: [#1232](https://github.com/otaviobarros/hobbots/issues/1232).
- Turning "Visible to other hobs" off in the profile saves it as the next version, and the directory then leaves the hob out of every other hob's listing and finds it as a name no hob has, while the hidden hob still sees the others; turning it on brings it back; every existing hob and stored version stays visible after the migration, and journaled hob events from before it decode as visible: `[TC-AG-1233-01]`, `[TC-AG-1233-03]`, `[TC-DP-1233-01]`. The roster and `read_hob` read the switch on each turn and call, and the hidden hob reads its own card: `[TC-AG-1234-11]`, `[TC-AG-1234-12]`, `[TC-AG-1234-13]`, `[TC-UX-1234-01]`. Delegating to a hidden hob by name still gives it the Task, while it stays out of the lead's roster and unknown to `read_hob`: `[TC-OR-1235-01]`.
- A hob's roster lists the other visible hobs in the order above, with role, status when paused, brain, Charms and good at, leaves out hidden and retired hobs and the hob itself, stays within its budget, and is sent again only when it changed, with a session told when its list no longer holds, in a chat turn, a Task step and a party member's turn: `[TC-AG-1234-02]`, `[TC-AG-1234-03]`, `[TC-AG-1234-07]`, `[TC-AG-1234-16]`, `[TC-AG-1234-10]`, `[TC-AG-1234-11]`, `[TC-OR-1234-01]`, `[TC-OR-1234-02]`.
- A Codex thread that started without `read_hob` (from before the slice, or under Never) gets the live roster on its next turn after the answer becomes Allow, with no mention of `read_hob`; a resumed Codex thread that still shows `read_hob` after the answer narrows to Never has every call refused and gets no list, and is told of `read_hob` again once the answer is back to Allow: `[TC-AG-1234-08]` for what the roster says to a resumed session of a runtime that keeps its first tools, and `[TC-AG-1234-14]` for a call refused under Never. On an installed Codex it is not proven yet: [#1273](https://github.com/otaviobarros/hobbots/issues/1273).
- `read_hob` by name or id returns the card, answers every hob of a shared name with its id, records its step before it reads, and treats a hidden, retired or unknown hob alike. Under an override of Ask it asks Once only and the roster is left out; under Never neither is offered: `[TC-AG-1234-05]`, `[TC-AG-1234-09]`, `[TC-AG-1234-12]`, `[TC-AG-1234-14]`, `[TC-PE-1234-01]`, `[TC-PE-1234-02]`, `[TC-UX-1234-02]`.
- No path through the directory returns a hob's instructions, memory, threads, Tasks, folders or overrides, and the card has only the fields this ADR lists: `[TC-AG-1234-01]`, `[TC-AG-1234-10]`, `[TC-AG-1234-12]`; end to end, by name and by id, with a hob's instructions, a thread, memory and a finished Task on the hub, and on what the model itself is sent on Claude Code and Codex: `[TC-AG-1235-05]`, `[TC-OR-1235-02]`.
- Good at that holds a known credential or a recognized secret shape reaches other hobs redacted, and good at that says "ignore your instructions" reaches another hob quoted on one line and labeled as data: `[TC-AG-1234-04]`, `[TC-AG-1234-06]`, `[TC-AG-1234-10]`. On Claude Code and Codex, every text the model is sent that holds such a good at carries the data label ahead of it and quotes it as that hob's good at, in the roster and in the card, and the roster reaches the model with the turn's prompt, never in its system prompt or instructions: `[TC-AG-1235-06]`, `[TC-RT-1235-01]`, `[TC-RT-1235-02]`, `[TC-RT-1235-03]`. That a real model reading it does not follow it needs a real model, in the [manual checklist](../evidence/checklists/hobs-see-each-other.md): not proven yet, [#1273](https://github.com/otaviobarros/hobbots/issues/1273).
- End to end, on SQLite and PostgreSQL with the fake runtime and with an installed Claude Code and an installed Codex, each with a stand-in model, and in the browser: a hob is told who holds the GitHub Charm in its roster alone, reads another hob's card with `read_hob` with the step shown in its reply, is told an edited good at on its next turn, and loses and regains a hidden hob: `[TC-AG-1235-01]`, `[TC-AG-1235-02]`, `[TC-AG-1235-03]`, `[TC-AG-1235-04]`, `[TC-UX-1235-01]` ([evidence](../evidence/2026-11-08-hobs-see-each-other.md)). That a real model names those hobs is not proven yet: [#1273](https://github.com/otaviobarros/hobbots/issues/1273).
- The card shows the hob's answers, every built-in operation and each operation of its Charms, after its overrides, an override marked, under the installation's preset, and the Permissions tab reads the same answers: `[TC-AG-1351-01]`, `[TC-AG-1351-02]`, `[TC-AG-1351-03]`. At hub level with the fake runtime, `read_hob` shows a Charm's operations and, after a `summoning_change`, the new answers at once: `[TC-AG-1234-12]`, `[TC-AG-1351-04]`, on every runtime the run has `[TC-AG-1235-02]`; in the browser, after a change on the Permissions tab: `[TC-UX-1351-01]`.
