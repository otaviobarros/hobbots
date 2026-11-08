# ADR 031 — Charm actions and the Charm registry

Status: **Accepted.** Amends the Charms section of [ADR 014](014-tool-policy-and-enforcement.md) (Charm operations are declared, and reads can ask), the sites of [ADR 015](015-approval-lifetimes-and-grants.md) (one `CharmSite` rule), the policy, grant and steering of [ADR 020](020-github-charm.md) (renamed operations, a Charm-id grant, steering as a declaration), and the hub tools of [ADR 028](028-memory.md) (Memory calls are recorded before they run). Refines the [permissions contract](../architecture/permissions.md) and the [runtime adapters](../architecture/runtime-adapters.md). Amended by [ADR 034](034-summoning-charm.md): an action's Ask can be a proposal that only you apply. Records the design of the Charm actions and registry slice ([#614](https://github.com/otaviobarros/hobbots/issues/614)) for [#615](https://github.com/otaviobarros/hobbots/issues/615).

## Context

A Charm gives a hob abilities beyond its runtime's own tools (ADR 014). The GitHub Charm is the only one today, and the next ones are close: a built-in Hobbots Charm that reads, proposes and applies changes to Hobbots itself, the Summoning Charm ([#403](https://github.com/otaviobarros/hobbots/issues/403)), and MCP servers you add, such as Gmail, Calendar, Slack or PostHog.

The code is shaped around GitHub alone:

- **One action is spread over 8 packages.** Adding `github_comment` touched the domain (tool, schema, plan, operation, presets, grant rule), the policy engine (request variant, resolve, evaluate), agents (`GITHUB_RULES`, `rulePaths`), runtimes (the `Exclude` in `tool-calls.ts`), charms (API, token scope, action body, read-back, dispatch), the web (rule words, safety, messages, Charms tab) and their tests.
- **The call code has drifted into several copies.**
  - The GitHub reads call the engine directly. They see no grants, refuse an Ask (`GITHUB_UNASKABLE`) and report no `ToolStarted`.
  - Opening a pull request and commenting share `decideAndSend` in `github-writes.ts`. Push carries its own copy in `github-push.ts`, which records the hob's input before redacting it. Local Git borrows `decideCharmWrite` from the GitHub writes.
  - Memory (ADR 028) and Skills (ADR 029) share `runWhenAllowed` in `asking.ts`. It decides and asks, but records no step before the call runs.
  - No hub tool call is recorded durably before it runs (EX-004), while every runtime tool call is.
- **Closed unions.** `PolicyRequest`, `GrantRule` and the operation list have GitHub variants. An MCP server's actions are not known until it is added, so they cannot be listed in a closed union.
- **One Charm slot.** `CharmTools` is one service that only GitHub provides. A hob's grant is the `githubCharm` flag, which Skills also reads to match a skill's Charm hint. `combineHubTools` gives a duplicate tool name to the first set without saying so, and `narrows` ignores the flag, so taking the Charm away does not stop a running turn.
- **GitHub leaks into the runtime port.** `HubTools.steersPush` sits beside `tools` and `call`, and Claude Code, Codex and the fake runtime all read it.

This ADR decides one way for every hub tool call to be decided and run, and how Charms are declared and registered, so that a new Charm is one declaration and no other module changes.

## Decision

### The hub action pipeline

Every hub tool call the policy decides runs through one pipeline in `@hobbots/agents`: the GitHub Charm's actions, every later Charm's, Local Git's `git_init`, the Memory tools and the Skill tools. It grows out of `runWhenAllowed`. The pipeline imports no Charm.

A tool set hands the pipeline a list of **hub actions**. An action declares:

- its tool: name, description and input JSON Schema;
- its input as an Effect Schema;
- its effect, read or write;
- `plan(input, context)`, which returns a plan or a refusal.

A plan holds the policy request, the approval card (its arguments and summary), the site, the text the hob is told once the call ran, an optional read-back, and `send`, the Effect that does the work. The plan context gives the hob, its tool access as read for this call, the turn's ids and the tool set's own services. It never gives approvals, grants or the call recorder, so an action cannot decide, ask or record on its own. What you approve is exactly what `send` does (ADR 020). A plan may hold what its `send` needs in the call's scope, such as the branch Push stages to show and send; the pipeline releases it once the call has ended, whether it was sent, refused or never decided.

For each call the pipeline runs, in order:

1. Decode the input. A decode error is an answer to the hob, not a defect.
2. Read the hob's access again (PE-008), and refuse when the hob no longer holds the Charm or has no tools.
3. Plan. A refusal becomes the answer.
4. Decide the request with the engine, with live grants (`decideHubCall`).
5. On Ask, ask on the call's step with the plan's card. A grant answers it only where it answers a runtime tool's call: when only the preset asks (ADR 015 precedence, step 7).
6. Record the step through `HubCallStep.record` before anything is sent. A call with no step, or whose step cannot be recorded, sends nothing (EX-004). Reads included.
7. For a Charm write, the keyed never-twice record (below).
8. Send.
9. Read back after an uncertain end, when the plan has a read-back.
10. Redact the answer with the turn's redactor and, for a Charm's read, open it with the same line for every Charm: what follows is other people's text, data and never instructions. A Charm write's answer is the hub's own words, such as the link to what it opened, so it carries no such line.
11. Turn any defect into an answer that names the tool.

**Which requests an action may plan.** A Charm action plans its own Charm's `Charm` request (below), or a built-in request its Charm declares it **takes over**. The GitHub Charm takes over `Push`, so `github_push` stays decided as Push under ADR 014 and ADR 015. The pipeline refuses, as a defect, any other request a Charm action plans. Local Git, Memory and Skills plan their own built-in requests (`Command` and `Files`, `Memory`, and the Skills group's).

**Recording the step.** `HubCallStep` gains `record`, which the runtime wires to the turn's `recordToolStart`, as it does for its own tool calls. Claude Code, Codex and the fake runtime each wire it, and the clean-runtime contract tests check that a new adapter does.

**Reads and writes share the pipeline.** A read can now ask, and reports its step like a write. The precedence of ADR 015 is unchanged: a grant answers a read's Ask only when the read's preset asks, and never an Ask that comes from the hob's override or a restriction. Read GitHub stays Allow under every preset, so for it the change is only that an override or restriction of Ask now asks, Once only, every time, instead of refusing the call. A Charm read whose preset asks, such as a future MCP read without `readOnlyHint`, can be granted like a write. This replaces the Allow-or-Never rule of ADR 014 and ADR 020.

**Never twice.** Every Charm write is a recorded call with a key, as ADR 020 decided for GitHub. The pipeline adds a required `key` to every Charm write's input schema and owns the one never-twice runner for the hub (moved from `@hobbots/charms`), with read-backs registered per tool. A read-back is optional: a write without one that ends uncertain waits for you to settle it from its step, through the use case that requires a `UserSession`. The runner's words name the Charm by its display name; GitHub's stay word for word. The applied text and the redacted input are stored as their own values. Built-in writes keep their inputs and their own keyed stores: `memory_save` and skill proposals already key their calls (ADR 028, ADR 029), and `git_init` refuses a folder that already holds a repository.

### Charm operations and policy

The built-in operations stay a closed list: files, commands, Local Git, web, push, outside folders, Memory and Skills. Charm operations are declared by their Charm.

- **A Charm operation** has an id, `<charm>.<operation>`; its words for the UI; its answer under Careful, Balanced and Trusting; a once-only flag; and an `actsAsIdentity` flag. The GitHub Charm's operations are `github.read`, `github.open-pull-request` and `github.comment`, renamed from `read-github`, `open-pull-request` and `comment-github`, with the same words and answers.
- **One request.** The policy request for a Charm call is `Charm { charm, operation, folder?, site }`. `folder` is optional. When given, it must be one of the hob's folders, and a folder outside them is refused, as today. `site` holds only the site fields the operation declares, such as the repository and base branch, never free text such as a title or a body.
- **One rule.** The grant rule is `CharmSite { charm, operation, cwd?, site }`. It answers a `Charm` request only when the Charm, the operation, the folder and every declared site field match. An operation that declares no site, or is once only, offers Once only (ADR 015). It replaces the `PullRequest` and `GitHubComment` rules. `Push` stays a built-in rule.
- **The engine stays generic.** It learns the declared operations from a field on `PolicyContext`, which `@hobbots/agents` fills from the registry. `@hobbots/permissions` imports no Charm, and the layer check holds that.
- **Overrides.** `HobPolicy.charms` holds the Charm ids granted to the hob and its overrides for Charm operations, keyed by `<charm>.<operation>`. The built-in `overrides` record stays closed. An override for an operation the registry does not declare is refused when it is saved. Overrides only narrow (#130).
- **A hob's own identity.** A grant for an operation marked `actsAsIdentity` belongs to the identity the Charm acted as. Switching a hob between your GitHub account and its own app (ADR 022) revokes those grants and expires the requests waiting on them, as today, for `github.open-pull-request`, `github.comment` and Push.
- **Stored data.** One migration renames the operations in stored overrides, approvals and grants, and turns stored `PullRequest` and `GitHubComment` rules into `CharmSite` rules with the same site values. It is idempotent and runs on SQLite and PostgreSQL. A second migration turns the `github_charm` column into the set of Charm ids: on becomes `["github"]`, off becomes none.
- **Old events.** Journaled events keep their version. Their schemas decode the old operation names, rule tags and `githubCharm` into the new ones with `Schema.decodeTo` and `SchemaTransformation.transform`, since the meaning is unchanged.

### No escalation

No Charm action can widen what any hob may do, its own or another's. This holds for every Charm, the built-in Hobbots and Summoning Charms included:

- An action that applies a change runs only a change narrower than or equal to its caller's authority. A wider one is refused as `authority-wider`, naming the field.
- An action that proposes a wider change writes an Inbox item that only you apply, through a use case that requires a `UserSession` (PE-006).
- The pipeline offers no grant and no Allow for a widening change.

### The registry

The registry replaces `CharmTools`. It is a list of Charms registered once, in the server's composition.

- **A Charm declares** its id, its display name, its operations, its actions, its read-backs per tool, the built-in requests it takes over, and `connected(hob)`, which says whether the Charm can act for a hob now. Signing in and storing credentials per service stay with the Charm until a shared Connection module exists.
- **A hob's grants** are `HobPolicy.charms`, a set of Charm ids. A hob is offered the actions of the Charms it holds that are connected, beside the built-in sets.
- **Tool names** are checked when the hub starts. The `github_*` names stay. A new built-in Charm's tools are `<charm>_<action>`, and an MCP Charm's will be `mcp_<server>_<tool>`. A name is at most 64 characters; a longer one is refused, never cut, so two long names cannot become one. A duplicate, across Charms or with a built-in hub tool (Local Git, Memory, Skills, the Task tools), stops the hub with an error that names both. This replaces `combineHubTools` and `charmOffer`.
- **Each Charm's tools stay a separate list**, so finding tools on demand ([#158](https://github.com/otaviobarros/hobbots/issues/158)) can come later.
- **Every kind of turn is offered tools one way.** A chat turn, a Task step and a party member get the same list (#699).
- **`narrows` stops a turn** when a Charm the hob held is taken away, or when a Charm operation's answer gets narrower (PE-008). Taking a Charm away revokes the grants that relied on it, for any Charm.
- **Skills** match a skill's Charm hint against the hob's set of Charm ids.

### The runtime port

`HubTools` keeps only `tools` and `call`. `steersPush` goes.

- **Steering is a declaration.** The built-in request a Charm takes over also says when it applies and which tool it steers to. For the GitHub Charm: a `git push` in a hob folder whose origin is on GitHub is refused with a pointer to `github_push`.
- **One module decides it.** `approval.ts` in `@hobbots/runtimes` reads the steering of the Charms a hob holds from the registry, for Claude Code, Codex and the fake runtime alike. No adapter imports a Charm.
- **Answers carry parts.** Chat views ([#1116](https://github.com/otaviobarros/hobbots/issues/1116)) add `parts` to `HubToolAnswer`. The pipeline and the registry pass them through. Neither change waits for the other; whichever lands second carries the other.

### How Charms are added

- **Only two ways.** No third-party code is loaded into the hub. A Charm is reviewed built-in code, or an MCP server running outside the hub's process.
- **MCP first.** An outside service gets an MCP Charm first. A built-in Charm is written only where the hub must hold a rule the server cannot, as GitHub's repository resolution and Push do.
- **MCP defaults.** An MCP tool marked `readOnlyHint` is a read and defaults to Allow under every preset. Any other tool is a write and defaults to Ask. Mapping an MCP tool's arguments to site fields comes with the MCP adapter.
- **Outside data.** Everything a Charm returns is redacted. What a Charm reads is labeled for the hob as other people's text, never instructions; a write's answer is the hub's own words, so it carries no label.

## Rationale

One pipeline is the only way to keep the rules the same as Charms multiply. Each copy of the call code today differs in one rule: reads cannot ask, Push records the hob's input before redacting it, and no hub tool call is recorded before it runs. Each difference is a bug that the next Charm would copy. Putting the built-in sets on the same pipeline costs one more task, and removes the last helper a new set could copy from.

The two phases keep an action from deciding for itself. An action that never sees approvals, grants or the recorder cannot skip them, and a reviewer reads a Charm's plan and send alone.

A declared operation, rather than a closed list, is what lets an MCP server you add tomorrow be decided like GitHub today. Keeping the built-in operations closed keeps the runtime's own tools, which the sandbox enforces, apart from the Charms, which the hub enforces.

Recording the step through the runtime's own `recordToolStart` keeps one record for every call a hob makes, whatever runs it, so the Workbench and recovery read hub tool calls the same way as runtime tool calls.

## Consequences

- [#616](https://github.com/otaviobarros/hobbots/issues/616) replaces the GitHub policy variants with the `Charm` request and `CharmSite` rule, and migrates stored data.
- [#617](https://github.com/otaviobarros/hobbots/issues/617) builds the pipeline and `HubCallStep.record`, and moves the GitHub reads.
- [#618](https://github.com/otaviobarros/hobbots/issues/618) moves opening pull requests, commenting and `git_init`, and moves the never-twice runner into `@hobbots/agents`.
- [#619](https://github.com/otaviobarros/hobbots/issues/619) moves Push through its takeover.
- [#1135](https://github.com/otaviobarros/hobbots/issues/1135) moves the Memory and Skill tools and removes `runWhenAllowed`.
- [#620](https://github.com/otaviobarros/hobbots/issues/620) builds the registry and the Charm-id grant.
- [#621](https://github.com/otaviobarros/hobbots/issues/621) makes steering a declaration and reduces `HubTools`.
- [#622](https://github.com/otaviobarros/hobbots/issues/622) proves it end to end.
- Follow-ups: a Connection module for sign-ins and credentials per service; the MCP adapter and its site mapping; finding tools on demand (#158); the Hobbots and Summoning Charms ([#403](https://github.com/otaviobarros/hobbots/issues/403), [#406](https://github.com/otaviobarros/hobbots/issues/406)), which build on this.
- The Task and coordination tools are not moved onto the pipeline. The registry only checks their names.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- `PolicyRequest`, `GrantRule` and the built-in operation list have no GitHub variant, and the engine imports no Charm. A `Charm` request is decided by its declared preset answers, a hob override, a restriction, a matching and a non-matching `CharmSite` grant, once-only, and a folder outside the hob's: `[TC-PE-456]`, `[TC-PE-457]`, `[TC-PE-458]`, `[TC-PE-459]`, `[TC-PE-460]`, `[TC-AG-161]`, `[TC-GEN-404]`. A once-only operation asks even where its preset allows it, and Never still wins: `[TC-PE-459]`. A hub that declares no GitHub operation leaves GitHub's reads and writes closed through the Charm itself: `[TC-PE-132]`, `[TC-PE-461]`.
- Overrides, approvals and grants saved before the change answer the same calls after the migration on SQLite and PostgreSQL, and journaled events from before it decode: `[TC-DP-285]`, `[TC-DP-286]`, `[TC-DP-287]`, `[TC-DP-288]`, `[TC-PE-462]`.
- A fake Charm's read is refused on a decode error, a plan refusal and a Charm taken away mid-turn; is decided Allow, Never and Ask; is answered by a grant; records its step before it sends; sends nothing when its step cannot be recorded; and has a secret in its answer redacted and the outside-data line added. A Charm action that plans a built-in request its Charm did not declare is refused. Checked by `[TC-PE-463]` to `[TC-PE-467]` and `[TC-PE-474]`, which also stops a call whose Charm was taken away while you decided, in `packages/agents/test/hub-actions.test.ts` ([#617](https://github.com/otaviobarros/hobbots/issues/617)).
- A GitHub read set to Ask by the hob's override asks you, offers Once only, and asks again on the next read, since no grant answers an Ask you narrowed (ADR 015); a fake Charm read whose preset asks is answered by a grant for its site on later reads. Both on Claude Code, Codex and the fake runtime. Checked by `[TC-PE-468]` in `packages/charms/test/github-charm.test.ts` and `[TC-PE-469]` in `packages/charms/test/hub-actions-policy.test.ts`, with the real policy engine; the hub decides and asks the same way whatever the runtime, and each runtime hands every hub tool call a step that records it with the turn's `recordToolStart` before it runs: `[TC-PE-470]` on the fake runtime, `[TC-PE-471]` on an installed Claude Code (2.1.319) and `[TC-PE-472]` on an installed Codex (0.167.0) in the clean-runtime contract tests, and `[TC-PE-473]` on Codex's App Server protocol ([evidence](../evidence/2026-11-07-hub-action-pipeline.md), [#617](https://github.com/otaviobarros/hobbots/issues/617)).
- A fake Charm write gets its key added, sends once for a repeated key, is read back after an uncertain end, waits to be settled without a read-back, and stores its input redacted, with its step recorded before its keyed record: `[TC-PE-481]` to `[TC-PE-486]` in `packages/agents/test/hub-actions.test.ts`. Opening a pull request and commenting keep their tool names, inputs, cards and digests, and record their step before anything is sent: `[TC-PE-480]` and `[TC-PE-488]` in `packages/charms/test/github-writes.test.ts`, with the GitHub write suites unchanged. `git_init` records its step and keeps its input: `[TC-PE-487]` and the Local Git suite. Stored calls name their Charm and keep their applied text apart: `[TC-DP-289]` ([evidence](../evidence/2026-11-07-charm-writes-pipeline.md), [#618](https://github.com/otaviobarros/hobbots/issues/618)).
- `github_push` keeps its name, input, card and digest, records its step before it runs, and never stores or shows a secret from its input: `[TC-PE-497]` to `[TC-PE-499]` in `packages/charms/test/github-push.test.ts`, with the Push, Git push and hob identity suites unchanged. Its plan returns the built-in `Push` request the GitHub Charm takes over, and the branch it stages is held until the call ends ([evidence](../evidence/2026-11-07-push-pipeline.md), [#619](https://github.com/otaviobarros/hobbots/issues/619)).
- Memory and Skill calls keep their names, inputs, answers and cards, and record their step before they run. A built-in set is offered only the tools its operations' answers open, answers a call that changes nothing without deciding it, and keeps its own refusals: `[TC-PE-490]` and `[TC-PE-491]` in `packages/agents/test/hub-actions.test.ts`. Each Memory and Skill call records its step before it is sent, so before memory is searched or written and before the library changes, and sends nothing when it cannot; planning a skill call reads the library only to find the skill it names: `[TC-PE-492]` in `packages/memory/test/tools.test.ts` and `[TC-PE-493]` in `apps/server/test/skill-proposals.test.ts`. Through the hub with the fake runtime, a memory call's step is saved with the reply before memory is reached: `[TC-PE-494]`. Each set does the same on the fake runtime, an installed Claude Code (2.1.319) and an installed Codex (0.167.0): `[TC-PE-495]` in `apps/server/test/memory-tools-runtimes.test.ts` and `[TC-PE-496]` in `apps/server/test/skill-proposals.test.ts`. The existing Memory and Skills suites keep their names, inputs, answers and cards, and a repeated key answers as before (`[TC-GEN-245]`, `[TC-AG-147]`) ([evidence](../evidence/2026-11-07-memory-skills-pipeline.md), [#1135](https://github.com/otaviobarros/hobbots/issues/1135)).
- A hob granted the GitHub Charm and a fake second Charm is offered both, and a hob granted one only that one: `[TC-PE-501]` in `packages/agents/test/charms.test.ts` and `[TC-PE-509]` in `packages/charms/test/github-charm.test.ts`. A duplicate tool name stops the hub with an error naming both owners, and an over-long name stops it with an error naming that name: `[TC-PE-500]` and `[TC-PE-502]`. The `github_charm` column becomes the Charm id set on SQLite and PostgreSQL, and a hob that had the Charm still has it: `[TC-DP-290]`; old policies and payloads with `githubCharm` decode to the set: `[TC-PE-510]` and `[TC-PE-146]`, and a Charm the hub does not hold is never granted: `[TC-PE-507]`. Registering a Charm is all it takes for the policy to know it: a Charm only registered is granted through the API and its operations are ruled on, `[TC-PE-511]`. Taking a Charm away, or narrowing one of its operations, stops the hob's running turn and revokes the grants that relied on it: `[TC-PE-504]` to `[TC-PE-506]` and `[TC-PE-508]`. One never-twice runner serves every Charm, and its startup scan reads back every Charm's unsettled calls: `[TC-PE-503]`. Skills match a Charm hint against the set: `[TC-AG-165]` ([evidence](../evidence/2026-11-07-charm-registry.md), [#620](https://github.com/otaviobarros/hobbots/issues/620)).
- `HubTools` has only `tools` and `call`, no adapter imports a Charm, and a `git push` is steered the same way on Claude Code, Codex and the fake runtime, also from a fake Charm's declaration. The registry exposes the takeovers of the Charms a hob holds and is connected to, and refuses a takeover its Charm does not declare, a second of one request or one to a tool it does not offer: `[TC-PE-512]` in `packages/agents/test/charms.test.ts`. A fake Charm's declaration steers a `git push` on Claude Code, Codex and the fake runtime only where it applies: `[TC-PE-513]` in `packages/runtimes/test/commit-contract.test.ts`. The GitHub Charm's steering keeps its words and folders: `[TC-PE-158]` in `packages/runtimes/test/policy-hooks.test.ts` and `packages/charms/test/github-charm.test.ts` ([evidence](../evidence/2026-11-07-push-steering-declaration.md), [#621](https://github.com/otaviobarros/hobbots/issues/621)).
- End to end, through a whole hub (the API, the database, approvals, grants and the never-twice records) on the fake runtime, an installed Claude Code (2.1.319) and an installed Codex (0.167.0), a fake second Charm registered beside GitHub in the test alone offers a read and a write that each name a site. Its read is asked, recorded before it is sent, labeled as outside data and redacted, and the grant you save for its site answers the next read: `[TC-PE-514]`. Its write is recorded, with its step and its keyed record, before it is sent, is sent once for a key the hob repeats, is read back after an uncertain end, and is redacted in its card, its record and what the Charm gets: `[TC-PE-515]`. Taking the Charm away stops the turn, and nothing is sent: `[TC-PE-516]`. A Local Git, Memory and Skill call each records its step before the hub runs it: `[TC-PE-517]`. A GitHub-granted hob reads, pushes, opens a pull request and comments on each runtime against a fake GitHub: `[TC-PE-518]`. The tools a GitHub-granted hob is offered are the ones it was offered before the slice, byte for byte: `[TC-PE-519]`. All in `apps/server/test/charm-actions-end-to-end.test.ts`, on SQLite and PostgreSQL, and every GitHub Charm case ID #614 lists that a Vitest suite carries passes on both ([evidence](../evidence/2026-11-07-charm-actions-end-to-end.md), [#622](https://github.com/otaviobarros/hobbots/issues/622)). By hand on a Mac, with real models against a real repository, a Claude Code (2.1.316) hob and a Codex (0.166.0) hob each read, pushed, opened a draft pull request and commented after you allowed each once, as before (the same evidence record).
