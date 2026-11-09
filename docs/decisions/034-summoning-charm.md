# ADR 034 — The Summoning Charm

Status: **Accepted.** A scoped exception to the agent control-plane exclusions of the [permissions contract](../architecture/permissions.md): a hob may summon, change, pause, wake and retire hobs, within limits you set and never wider than itself. Amends the hub action pipeline of [ADR 031](031-charm-actions-and-registry.md) (an action's Ask can be a proposal). Builds on the hob directory of [ADR 032](032-hob-directory.md) and the tool answer parts of ADR 030 ([#1112](https://github.com/otaviobarros/hobbots/issues/1112)). Refines the [agent model](../architecture/agent-model.md). Records the design of the hobs managing hobs slice ([#403](https://github.com/otaviobarros/hobbots/issues/403)) for [#404](https://github.com/otaviobarros/hobbots/issues/404).

## Context

Today only you create and change hobs, through Summon and the hob profile. The permissions contract says only a user session changes what a hob may do, so a refused approval cannot be sidestepped by widening a policy.

That leaves a gap in the way people want to work with a team of hobs. For example, you and your CTO hob agree on three engineers the team needs. You ask the CTO to have the Chief of Staff hire them. The Chief of Staff should collect what each engineer needs, ask the CTO about whatever is unclear, and show you one card with the three hobs to confirm. Once you confirm, a card per new hob opens it.

The building blocks exist:

- The hub action pipeline and the Charm registry of ADR 031 decide, ask, record and send every hub tool call. A new Charm is one declaration.
- Delegation already refuses a member authority wider than its lead's, as `authority-wider` (ADR 018).
- `delegate_task` and `ask` already carry work and questions between hobs, and questions climb to the nearest lead before they reach you (ADR 018).
- The hob directory (ADR 032) gives every hob the roster and `read_hob`, so a hob can see which hobs hold which Charms.
- Chat views (ADR 030) let a tool's answer carry parts that the chat shows as cards.

Five things were open. A field answer of Ask set by an override can never be widened to Allow, since overrides only narrow. One card for several hobs does not fit "one plan, one decision". A narrow manager could steer a wider hob by rewriting its instructions (a confused deputy). A hob rewriting its own instructions could keep a prompt injection alive across sessions. And grants need a site, which a summon does not have. This ADR settles each.

## Decision

### The Charm

The Summoning Charm is a built-in Charm with the id `summoning`, declared on the registry like any other (ADR 031). Roles grant nothing, so any hob you give it to can manage hobs (ADR 005).

- **Per hob.** You grant and remove it from a hob's Charms tab.
- **Every hob.** Settings › Charms has "Summoning for every hob", off by default, with one scope and one set of field answers. It reaches every hob you made, and never a hob that a hob summoned. A hob's own Charms tab can still remove it from that hob, or grant it with its own scope and answers.
- **Only you grant it.** No hob grants, passes on or removes the Summoning Charm, its own included. It is never a field a hob can set (below).

### Tools

Every supported runtime (Claude Code and Codex today, and every runtime added later) is offered the same tools through `HubTools`, as for every other Charm. No adapter imports the Charm, and the clean-runtime contract tests check that each adapter offers them.

| Tool | Effect | What it does |
| --- | --- | --- |
| `summoning_check` | Read | Takes drafts of new hobs or changes, and answers per hob what is missing or invalid and which fields would ask. It writes nothing. |
| `summoning_summon` | Write | Takes a list of new hobs and summons them. |
| `summoning_change` | Write | Takes a list of changes, each naming a target hob and the fields it changes. |
| `summoning_pause` | Write | Pauses one hob. |
| `summoning_wake` | Write | Wakes one paused hob. |
| `summoning_retire` | Write | Retires one hob, with today's choice for its running replies: let them finish or stop them. |

- **The same use cases as the screens.** Each write calls the use case behind the matching HTTP route, so a hob can never pass input that Summon or the profile would refuse. A change's profile and permissions are one configuration version, and a permissions change revokes the grants it took authority from and stops what running turns kept of it, as the Charms tab's does (PE-008).
- **The check tool finds the gaps first.** It names a missing name or role title, a brain this hub does not serve (a runtime that is not installed, a model the runtime does not offer, an effort the model does not take), a folder or Charm wider than the manager's, a field at Never, a target outside the scope, and the fields that would ask. The manager asks about real gaps, not guesses.
- **Questions go through `ask`.** A manager working on a Task that another hob gave it asks that hob first, as its lead. A manager working on your own request asks you. This is how `ask` routes today (ADR 018), so nothing new is built.
- **Never twice.** Every write takes the required `key` of ADR 031, and is a keyed Charm call like any other: unique per hob, scope and key ([persistence](../architecture/persistence.md)), so the same key from two managers, or from one manager in two Tasks, is two calls. A summon mints a fresh id for each new hob the first time the call is sent, and stores the ids on its keyed call record. A retry finds that record and returns the same hobs, also after the call's record moves into its Task's scope. A key reused with other drafts is refused as `key-reused`. The keyed record is written before the use case runs and settled after it, as for every Charm call. A summon, pause, wake or retire that ends uncertain is settled by a read-back: the minted hobs exist, or the hob has the status the call set. A change that ends uncertain is settled by a read-back too: each hob it changed holds a configuration version that the call made.

### Finding who can summon

The roster of ADR 032 lists the Charms each hob holds. Every hob's briefing adds one rule: to summon or change hobs, hand the work to a hob that holds the Summoning Charm.

- A hob without the Charm hands the work over with `delegate_task`, as any other work. The roster says so whenever it lists a hob that holds the Charm.
- The hob handed the work summons and changes hobs on that Task. The Summoning Charm offers its writes to a session working a Task outside any chat, a party member's or a step's, which other Charms do not (below), since every Summoning write acts on the hub's own records and reads back from them. A call that asks there becomes a proposal in the Inbox, as from a chat.
- When several visible hobs hold it, the hob asks who should be responsible with `ask` and the candidates as options. You see a pick card when the question reaches you.
- A hob hidden from the directory is not offered as a candidate. You or a lead can still hand it work by name, since `delegate_task` finds hidden hobs ([ADR 032](032-hob-directory.md)).

### Scope

The Charm's grant holds its scope. The scope lives in the hob's policy beside its Charm overrides, so changing it makes a new configuration version, and only a user session changes it.

- **Hobs it summoned**, on by default.
- **A list of hobs you pick**, empty by default.
- **Can manage itself**, off by default.

A call that names a hob outside the scope is refused as `outside-scope`, naming the hob. A retired hob is outside every scope.

### Field answers

The Charm declares one operation per field, mirroring Summon and the profile. Every operation is declared Allow under every preset. When you grant the Charm, the hub writes the defaults below as narrowing overrides in the hob's policy, so the Charms tab sets them like any other Charm's operations (ADR 014), and nothing new is needed to move one between Allow, Ask and Never.

| Operation | Covers | Default |
| --- | --- | --- |
| `summoning.summon` | Summoning new hobs | Ask |
| `summoning.name` | Name | Allow |
| `summoning.role` | Starter role or role title | Ask |
| `summoning.good-at` | Good at (ADR 032) | Ask |
| `summoning.look` | Look seed and colour | Allow |
| `summoning.sigil` | Sigil | Allow |
| `summoning.hat` | Hat | Allow |
| `summoning.tool` | Tool the sprite holds | Allow |
| `summoning.voice` | Voice | Allow |
| `summoning.length` | Reply length | Allow |
| `summoning.instructions` | Instructions | Ask |
| `summoning.brain` | Runtime and model | Ask |
| `summoning.effort` | Effort | Ask |
| `summoning.folders` | The hob's own folders and hidden shared folders | Ask |
| `summoning.charms` | Charms granted, and their operation answers | Ask |
| `summoning.pause` | Pause and wake | Allow |
| `summoning.retire` | Retire | Once only, high risk |

- **A summon is decided on `summoning.summon`.** Its drafts' fields are not decided one by one, except that a draft setting a field at Never is refused, naming the field. A field left out of a draft takes Summon's default.
- **A change is decided per target hob and field.** A row asks when any of its fields asks, and is refused when any is at Never.
- **Pause, wake and retire** are decided on their own operation per target hob.
- **Retire is high risk.** It is once only and needs the confirmation check box (ADR 015), under every answer but Never.
- **A delegation's restriction** still narrows these operations, as it narrows any Charm operation (ADR 018).

### Asking is a proposal

A Summoning call that asks becomes a **proposal**: an Inbox item the hub creates on the manager's call, and that only you decide and apply, through use cases that require a `UserSession` (PE-006). This is ADR 031's route for changes a hob may not apply itself, and it is the only route here. What is created or changed is made by you on the manager's proposal.

- **One card per call**, with a row per hob. A summon row shows the hob as Summon's Ready step shows it: sprite, name, role and sigil, good at, brain and effort, folders, Charms, and the instructions folded. A change row shows a before and after of the fields that change. A retire card shows the hob, what it owns, the choice for its running replies and the confirmation check box.
- **A decision per row.** Each row offers Allow and Deny, and a summon row also offers **Edit**, which opens Summon prefilled; you approve your version. Allow all and Deny all act on every row. The proposal settles once every row is decided.
- **The pipeline runs no `send` for a proposal.** The plan becomes the proposal's rows, and the apply use cases do the work. A row is applied only if its target has not changed since the row was made; otherwise it shows as changed since, and you deny it or the manager proposes again.
- **The call waits on its step** while its turn runs, as an approval does, and its answer tells the manager what was created, changed or denied, row by row. If the turn ends first, the proposal stays open in the Inbox, and its outcome reaches the manager as a backpack item when you decide (ADR 019).
- **Created hobs come back as parts.** Each hob created, by a proposal or under an Allow, comes back in the tool's answer as a part the chat shows as a card: sprite, name and role. Clicking it opens the hob's profile. Parts are ADR 030's, so the card ships with chat views, and until then the answer carries the hob's name and a link. A proposal's own card already shows a created card for each hob it made, which opens the hob's profile.
- **The same card in both places.** While it waits, the proposal's card shows in the chat's Needs-you tray above the composer, as every decision in a chat does (one place asks for you), and in the Inbox; a decision in one shows in the other. The call's step says to decide it there, and once it is decided the step shows the card with what came of each row. Edit opens Summon on the row, and Summon's last step allows your version. A summon row's look is drawn when the proposal is made, so the card shows the hob that allowing it makes.
- **Applying re-checks.** What you allow, as proposed or as you edited it, is checked again against the manager's scope, its answers and its authority as they are when you decide, so an operation set to Never or a hob that left the scope meanwhile is refused with its reason and nothing made.
- **A decision is yours while your device is.** Each decision is saved in the transaction that checks your device is still approved, so one that raced a Revoke is refused. A row is saved as applying before the hub makes it; a row left applying when the hub stopped is settled from its hob's history, as made or as waiting again, when the hub starts, when its card is read, and before anything else decides the proposal, so Deny never tells the manager nothing was done when something was. "Always allow" saves the manager's change and the proposal together, and a row on the manager itself stays yours to allow after it.
- **Grants do not apply.** Every Summoning Ask comes from an override or a safety check, never from the preset, so no grant answers it (ADR 015 precedence, step 6), and no card offers This Task or Always.
- **Always allow.** A card for a field at Ask offers "Always allow" for each field that asked, and "Always allow all of these" when more than one did, which sets them all in one change. Pressing it sets that field to Allow on the manager's Summoning Charm, as a policy change made by you that shows in the manager's History, and the card says so. For a summon, it sets `summoning.summon`, so the next summon runs without a card until the caps below. A manager that has the Charm from "Summoning for every hob" gets its own grant first, from that setting's scope and answers, as a change on its Charms tab gives it. It is never offered for a safety Ask or a high-risk operation.

### Changes to ADR 031

- **An action may declare that its Ask is a proposal.** The pipeline then decodes, reads the hob's access again, plans, decides and records the step as before. On Ask it writes the proposal instead of an approval request, and never runs `send`. The pipeline creates the proposal on the manager's call, as it creates an approval request today, so creating one needs no `UserSession` and grants nothing. Deciding a row, editing it, pressing "Always allow" and applying go through use cases that require a `UserSession` (PE-006), so no hob, the manager included, can decide or apply its own proposal.
- **A proposal's outcome is the call's answer** when it settles while the call waits, with the parts its apply use cases return.
- **A Charm may offer its writes outside chats.** A session working a Task outside any chat is offered no Charm writes, since a write whose answer is lost is settled on the reply step it showed as, and such a session has none. A Charm whose every write reads back from the hub's own records may declare `writesOutsideChats`, and the hub refuses to start when one of its writes has no read-back. The Summoning Charm is the only one that does.

### No escalation

A summoned or changed hob gets the intersection of what the manager has and what it asks for. The hub checks it against the manager's authority at the time of the call, in the same transaction as the write.

- **Folders.** Each of the hob's own folders must be one of the manager's own or inside one, compared canonically as delegation does (ADR 018). Hiding shared folders only narrows, so it is always within.
- **Charms.** The hob may hold only Charms the manager holds, never the Summoning Charm.
- **Operation answers.** Each answer, built-in or Charm, is the narrower of what the draft asks and the manager's effective answer. A summoned hob gets the manager's narrower answers written as its own overrides, so it is never wider than its manager even where the draft leaves an answer out.
- **What a hob never sets.** A summoned hob always runs in the sandbox, even with "Let new hobs run without the sandbox" on (ADR 014), signs no commits, and acts on GitHub as your account, never through its own app (ADR 022).
- **Refused, not trimmed.** A draft or change that asks for more than the manager has is refused as `authority-wider`, naming the field, with nothing written. No grant and no Allow covers a widening change (ADR 031).

**The confused deputy.** A manager may change a hob only if that hob's authority is within its own: its folders, Charms and operation answers, and its sandbox switch, signing and GitHub identity. A target that holds the Summoning Charm is always wider, since only you grant it. For a target wider than the manager, every field of the change asks, whatever its answer says, as a safety Ask that "Always allow" does not remove. A hob the manager summoned is within its authority by construction.

### Managing itself

With "Can manage itself", a hob changes its own configuration from the chat. You ask your hob to sound friendlier or move to another model, and it does.

- **What it may change:** its own name, good at, look (look seed and colour, sigil, hat and tool), voice and length, brain (runtime, model and effort) and instructions.
- **How it is decided.** These are their own operations, `summoning.self-name`, `summoning.self-good-at`, `summoning.self-look`, `summoning.self-voice`, `summoning.self-brain` and `summoning.self-instructions`, declared Allow and written as Ask overrides when you turn "Can manage itself" on. Each change asks with a before and after, and offers "Always allow" for its field, so once you allow it, the hob just does it when you ask.
- **What it may never do:** widen its own folders, Charms or operation answers, change its scope, pause or retire itself. There is no self operation for any of them, so the call is refused as `outside-scope`.
- **It applies from the next turn.** A change is a new configuration version, and a running turn keeps the version it started with.
- **Every change is recorded** with its diff in the hob's History, with Revert, so an instruction a prompt injection planted is visible and can be undone.

### What stays yours alone

No Summoning call reaches any of these, for any hob, the manager included. They are not fields, so a call that tries is refused before the policy decides it:

- the sandbox switch, commit signing, credentials, and a hob's own GitHub app (ADR 022);
- deciding approvals and proposals, and saving or revoking grants;
- granting, scoping or removing the Summoning Charm, and its field answers, except "Always allow" pressed by you;
- the setup's preset and shared folders;
- bringing a retired hob back, and deleting a hob.

### Limits for unattended summons

A summon you approve on a card is never capped, and the hub has no cap on its number of hobs. Summons that run without asking you are capped:

- **4 live hobs per manager** summoned without a card, and **3 per Task tree**, counted under the manager's lock.
- `HOBBOTS_MAX_UNATTENDED_SUMMONS_PER_HOB` and `HOBBOTS_MAX_UNATTENDED_SUMMONS_PER_TREE` change them, like ADR 018's limits.
- **At a cap, the next summon asks** as a proposal instead of being refused, so work goes on with you in the loop.
- **Retiring a hob frees its place.** Each summoned hob records whether it was summoned unattended, so the count needs no history.
- **What counts.** A hob takes a place while it is not retired, a paused one included. The tree cap counts every manager's unattended summons for any Task of the tree. A summon of several hobs that would pass either cap asks for all of them, and the cap's reason is on the card, which offers no "Always allow". The tree is the whole tree from its root, its siblings included. The count is read again under the manager's lock and the tree's before the hobs are stored, so a summon that lost the last place to another, by the same manager or another one in the tree, is refused and asks when called again. The check tool says when a summon would ask at a cap.
- **Where it shows.** `GET /api/agents/:agentId/summon-caps` answers `{ live, perHob, perTree }`: the hob's live hobs summoned without a card, and the two caps, for the Charms tab ([#410](https://github.com/otaviobarros/hobbots/issues/410)).

### Retiring

Retiring through the Charm uses today's retire, with its two choices for running replies (`finish` or `stop`). It is once only with the confirmation check box. A hob never retires itself. Retiring a hob with open work by handing it over or letting it finish first is [#408](https://github.com/otaviobarros/hobbots/issues/408), outside this slice. The retire use case offers both beside the two choices: a hand-over names the hob that takes the open Tasks, which for the Charm is the manager that asked, and "finish first" leaves the hob retiring, taking no new work, until its last open Task ends.

### Records and events

- **The actor of every configuration version.** `AgentConfiguration` records who made it: you; you, applying a hob's proposal, with the proposal and the call behind it; or a hob, under an Allow, with its call. A migration records you as the actor of every existing version.
- **Who summoned a hob.** `Agent` gains `summonedBy` (a hob, or null for you), the Task it was summoned for, and whether it was summoned unattended. A migration leaves existing hobs as summoned by you.
- **Journal events.** The events that record a hob's creation, change, pause, wake and retire carry the actor, so open screens update live. Events journaled before this decode with you as the actor (ADR 013). Proposals journal their creation, each row's decision and their settling.
- **Where it shows.** "Summoned by" on the hob's profile, a History tab with each version's actor, diff, the request behind it and Revert, and a Changes log in Settings across every hob ([#411](https://github.com/otaviobarros/hobbots/issues/411)).

## Rationale

**Every field declared Allow.** Overrides only narrow (#130), so a field declared Ask could never be set to Allow. Declaring Allow and writing the defaults as overrides keeps one mechanism: the Charms tab, "Always allow" and revocation all work on overrides as they do for every Charm.

**A proposal instead of an approval.** One call for three hobs does not fit "one plan, one decision, and what you approve is exactly what send does". A proposal with a row per hob does, and Edit falls out of it: you apply your own version. The cost is that a version's actor reads "you, proposed by the Chief of Staff" rather than "the Chief of Staff under your approval", which is the more honest record anyway.

**"Always allow" as a field change, not a grant.** ADR 015 lets a grant answer only the preset's Ask, never one from an override, because you narrowed that scope on purpose. The defaults are overrides, so a grant could never answer them. Setting the field to Allow is the change you meant, made by you and visible in History. It also drops the per-target "Always" that #404 first asked for: per-target grants would need a new rule kind and could never answer these asks.

**The confused deputy rule.** Field and folder checks stop a manager from giving a hob more than it has. They do not stop a narrow manager from rewriting the instructions or brain of a wider hob and steering its authority. Asking on every field for a wider target closes that, and costs nothing for the hobs a manager summoned.

**Self-management with asks.** Changing yourself from the chat is a feature you asked for. A prompt injection that rewrites a hob's instructions could outlive its session, so each self field asks with a diff until you allow it, and every change can be reverted.

**Caps only when you are not asked.** A summon you approve is your decision, and a cap would only get in your way. Summons without a card are where a loop could run away, and asking at the cap keeps work going.

## Consequences

- [#405](https://github.com/otaviobarros/hobbots/issues/405) records the actor on every configuration version and `summonedBy` on the hob, and wires Rename.
- [#406](https://github.com/otaviobarros/hobbots/issues/406) declares the Charm on the registry, its tools on every runtime, its scope, field answers, no escalation and the confused deputy rule.
- [#407](https://github.com/otaviobarros/hobbots/issues/407) caps unattended summons.
- [#409](https://github.com/otaviobarros/hobbots/issues/409) builds the proposal, its cards, "Always allow" and the created card, and designs them.
- [#410](https://github.com/otaviobarros/hobbots/issues/410) adds the Charm's section to the Charms tab and "Summoning for every hob" to Settings.
- [#411](https://github.com/otaviobarros/hobbots/issues/411) builds History, Revert and the Changes log.
- [#412](https://github.com/otaviobarros/hobbots/issues/412) proves it end to end.
- The created card in the tool's answer waits for chat views (ADR 030, [#1112](https://github.com/otaviobarros/hobbots/issues/1112)); the proposal's card shows it until then. Finding who can summon waits for the directory ([ADR 032](032-hob-directory.md)).
- Out of scope: retiring with open work (#408), creating or removing a hob's own GitHub app, connecting Charms, deleting hobs, and hobs passing the Summoning Charm on.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- A hob without the Charm is told who holds it, hands a summon to that hob, which summons and changes the hob on the Task it was handed, and asks who should be responsible when two hold it, where you pick one: `[TC-AG-412-01]`, `[TC-AG-412-02]`, `[TC-AG-412-08]`. A Charm offers its writes outside chats only when each reads back: `[TC-PE-501]`, `[TC-PE-502]`.
- A manager checks three drafts, asks its lead about the unclear one, and summons the three from one card after you edit one. All three are created, the edited one as you edited it, and each shows who summoned it, and a version wider than the manager is refused: `[TC-AG-409-01]`. On a Task its lead gave it, the manager checks the three drafts, asks its lead about the unclear one, and summons the three from one card after you edit one, each shown as summoned by it for that Task, with the hob each row made: `[TC-AG-412-03]`. Once you allow a summon in the chat, each hob it made opens from its card on the call's step and shows who summoned it: `[TC-UX-412-01]`.
- The check tool names what a draft lacks or gets wrong and writes nothing: `[TC-AG-406-02]`.
- A retried summon of three hobs returns the same three hobs, a reused key with other drafts is refused, and the same key in another reply summons distinct hobs: `[TC-AG-406-03]`. A retry after the call moved into the Task its reply started returns the same hob, and the same key from another manager summons its own: `[TC-AG-412-04]`. Under the default Ask a summon asks once and creates the hob as summoned: `[TC-AG-406-04]`.
- "Always allow" on a summon card sets `summoning.summon` to Allow as a change made by you, shows as Allow in the hob's permissions, and lets the next summons run without a card until the manager's cap, where the next one asks: `[TC-AG-409-03]`. A manager with the Charm from "Summoning for every hob" gets its own grant from that setting: `[TC-AG-409-05]`. At a cap a summon asks as a proposal with the cap's reason and no "Always allow": `[TC-AG-407-01]`. On a hob managing itself, "Always allow" leaves its change yours to allow, and an edit of yours since still makes it stale: `[TC-AG-409-10]`. "Always allow" for several fields sets them all in one change, and refuses the call when one did not ask: `[TC-AG-409-13]`.
- The Charms tab grants and takes away the Charm, saves its scope and each field answer at once, and shows a field set to Allow outside the tab as Allow. Summoning for every hob in Settings reaches a hob you made, a change on that hob's tab gives it its own grant from the setting's answers, and taking it away there withholds it: `[TC-AG-410-01]`, `[TC-AG-410-02]`, and a hob list that cannot be read says so with Try again: `[TC-AG-410-03]`. The tab's counts against the unattended-summon caps are not shown yet ([#407](https://github.com/otaviobarros/hobbots/issues/407), [#410](https://github.com/otaviobarros/hobbots/issues/410)).
- A manager changes three hobs in one call, you allow two and deny one, the manager hears which, and History and the Changes log show each change with its actor and diff, live. Every version and status change is kept with its actor, the version before it and the request behind a hob's change, past the journal, and Revert restores the version before the latest as a new version made by you and refuses an older one: `[TC-AG-411-01]`, `[TC-AG-411-02]`, `[TC-AG-411-03]`. The manager's call and its proposal, with a row whose hob changed since only deniable: `[TC-AG-409-02]`.
- An out-of-scope call, a field at Never and a draft wider than the manager are refused with their reason and nothing written. A hob cannot grant the Summoning Charm or touch the sandbox switch: `[TC-AG-406-05]`. A change is checked by the policy it leaves, so an answer map that drops an override, a shared folder shown again, or a Charm newly granted with answers wider than the manager's never widens a hob, and a name or role title the profile refuses is refused: `[TC-AG-406-11]`. A change either part of which is refused stores nothing: `[TC-AG-406-13]`, and one that takes authority away revokes the grants that relied on it: `[TC-AG-406-12]`. Granting the Charm writes its default answers and offers its tools: `[TC-AG-406-01]`, and Summoning for every hob reaches the hobs you made, never a summoned one, unless a hob's own tab removes it: `[TC-AG-406-09]`.
- A manager changing a hob wider than itself is asked on every field, with no "Always allow": `[TC-AG-406-06]`.
- A hob managing itself changes its own instructions after you allow it, and cannot widen its permissions, pause or retire itself: `[TC-AG-406-07]`. A manager pauses and wakes a hob it summoned, and retiring one asks once only: `[TC-AG-406-08]`.
- Unattended summons stop at their cap and ask, a summon you approve at the cap is not counted, and retiring a summoned hob frees its place: `[TC-AG-407-01]`; a Task tree stops at its own cap, a summon that would pass a cap asks for all its hobs, and another tree has room of its own up to the manager's cap, counting real Tasks at the root, a child and a sibling: `[TC-AG-407-02]`; two managers deciding at once in one tree never both take its last place: `[TC-AG-407-03]`, at hub level with the fake runtime on SQLite and PostgreSQL ([#407](https://github.com/otaviobarros/hobbots/issues/407)). The caps are decided in the Charm on the hub, outside every runtime adapter, and each runtime's Summoning calls reach the Charm as `[TC-AG-406-10]` shows. A live Claude Code or Codex summon at a cap is not verified yet.
- Retire through the Charm is once only with the check box and never "Always allow", and a running reply finishes under `finish` and is stopped under `stop`: `[TC-AG-412-05]`.
- A manager's call that asks creates its proposal without a user session, and no hob can decide, edit or apply a proposal, since those use cases require one. A proposal decided after its turn stopped stays in the Inbox and reaches the manager as a backpack item: `[TC-AG-409-04]`. The Inbox lists an open proposal under its Task's quest, and keeps a settled one only while you look at it: `[TC-AG-409-06]`. Allowing a row after its operation went to Never or its hob left the scope is refused with nothing changed: `[TC-AG-409-07]`. A decision from a device revoked before it was saved is refused, and a row the hub stopped while making is settled from its hob before anything else decides it: `[TC-AG-409-08]`, `[TC-AG-409-09]`. Reading the card, or starting the hub, settles such a row with no decision offered, from any version or status change the proposal made in the hob's history, even after a later edit: `[TC-AG-409-11]`, `[TC-AG-409-12]`. In the browser, a summon card is decided in the chat and the Inbox alike, Edit allows your version from Summon, and a created card opens its hob; a retire card reads what the hob has running and open first, says so when it cannot, and allows it only with the check box: `[TC-UX-409-01]`, `[TC-UX-409-02]`. The whole summon flow, from the Inbox through Edit in Summon to a created hob, works by keyboard alone: `[TC-UX-409-03]`. In the chat the card waits in the Needs-you tray, with each field's name on one line, and "Always allow all of these" sets every field that asked: `[TC-UX-409-01]`, `[TC-UX-409-04]`.
- Renaming a hob makes a new version, every version names its actor, and existing hobs migrate as made and summoned by you, on SQLite and PostgreSQL: `[TC-AG-405-01]`, `[TC-AG-405-02]`, `[TC-AG-405-03]`, `[TC-AG-405-05]`, and the profile names a retired summoner, with Try again when it cannot read it: `[TC-AG-405-06]`. A hob that summons a hob, or whose proposal you apply, is recorded as its summoner, and its changes, pauses, wakes and retirements carry it in their versions and events: `[TC-AG-405-04]`. The Charm's tools pass the manager on as the actor of what they create and change: `[TC-AG-406-03]`, `[TC-AG-406-05]`.
- The #406 scenarios run at hub level with the fake runtime on SQLite and PostgreSQL, and each runtime records a Summoning call's step before it changes a hob: `[TC-AG-406-10]`, run against an installed Claude Code 2.1.319 and Codex 0.167.0 with their stand-in models, which CI skips, and each runtime checks, summons, changes, pauses and wakes a hob through the Charm, each write recorded before it acts: `[TC-AG-412-07]`, against the same versions. The #412 scenarios run at hub level with the fake runtime, the Task tools and questions on SQLite and PostgreSQL. A live Claude Code or Codex model handing a summon over is not verified yet ([#1314](https://github.com/otaviobarros/hobbots/issues/1314)).
