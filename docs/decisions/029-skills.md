# ADR 029 — Skills

Status: **Accepted.** Adds a Skills group to the tool policy of [ADR 014](014-tool-policy-and-enforcement.md), a third thing a turn carries beside the briefing of [ADR 017](017-switching-brains.md) and the memory brief of [ADR 028](028-memory.md), a `skills/` entry to the backups of [ADR 026](026-backup-export-diagnostics.md), and a clean-runtime rule that every runtime adapter, Claude Code's and Codex's ([ADR 024](024-codex-adapter.md)) included, must pass. Records the design of the Skills library slice ([#1057](https://github.com/otaviobarros/hobbots/issues/1057)) for [#1058](https://github.com/otaviobarros/hobbots/issues/1058).

## Context

A skill is a folder with a `SKILL.md` (a name, a description and instructions) and any files it refers to. Claude Code and Codex both load skills in this format: the model sees each skill's name and description up front and reads the rest only when a task matches. Hobs need the same know-how, such as how a repository releases or how you like pull requests written, and today each runtime finds skills on its own, in its own folders, so a Claude Code hob and a Codex hob see different skills, and Hobbots can neither show nor control them.

The other tools that run local bots on these runtimes have adopted the same format, and almost none manage skills once installed: none pins a revision per agent, reviews an update before it applies, or records which skill a reply used, and one runtime's skills do not reach another's.

This ADR decides how Hobbots keeps one library of skills, how each runtime gets a hob's skills, and where the boundaries sit, so that skills depend on no runtime and no Charm, and nothing installed in a runtime's own setup reaches a hob.

The evidence for how each runtime loads skills is a probe of Codex 0.166.0 and of Claude Code 2.1.311 through the Agent SDK 0.3.311, run with fake home folders, and a reading of the Codex 0.166.0 source ([evidence](../evidence/2026-11-06-skills-loading-probe.md)). What it could not show is marked **unverified** below, with the issue that checks it.

## Decision

### Two seams

Skills follow the shape of Memory (ADR 028): one port in Hobbots' own words, one package that holds everything skill-specific, and two places where the rest of Hobbots meets skills, and only there:

1. **Delivery.** `PromptRequest` gains `skills?: ReadonlyArray<SkillMount> | null`. A mount is a skill's name, a read-only folder that holds it, and whether the hob may pick it on its own. The hub resolves a hob's skills before the turn and hands the adapter its mounts; the adapter alone decides where they go. Adapters never know the library, a revision or a scope.
2. **Hub tools.** The skill tools (below) are one more `HubTools` set, combined with the others as Memory's are.

Adapters report a generic `SkillUsed { name }` from the runtime's own events. The hub maps the name to the revision it mounted for that turn and journals it.

So a new runtime gets every skill feature by mapping mounts to its own loading path and reporting `SkillUsed`, and no runtime code changes when the library does.

### Packages

| Package | Owns | Depends on |
| --- | --- | --- |
| `@hobbots/domain` (`skills.ts`) | The types: skill, revision (content hash), assignment (scope, pin or held), source, proposal, use; the `SKILL.md` front matter schema | Nothing |
| `@hobbots/agents` | The `SkillLibrary` port, and pure policy: `resolveSkills` (scope union, clashes, opt-outs), rollout rules and proposal rules | `domain`, `api` |
| `@hobbots/skills` (new) | The file store, import from a folder, an archive or Git, the checks and flags, the update checker, the `skill_*` hub tools, and a fake for tests | `agents`, `domain`, `permissions` |
| `@hobbots/persistence` | Tables for skills, revisions, assignments, sources, proposals and uses, with their journaled events, on SQLite and PostgreSQL | `agents`, `domain` |
| `@hobbots/runtimes` | Delivery per runtime, from the list of mounts | `agents`, `domain` |
| `apps/server` | Composition: the only place that wires skills to the hub | everything |
| `apps/web` | The Skills page, a hob's Skills tab and the use line | `api` |

No other module imports `@hobbots/skills`, and it imports no runtime and no Charm. The layer check (`lint:layers`) holds this.

### Delivery per runtime

A hob uses its skills the way its runtime already does. Hobbots never pastes a skill into the prompt, so 30 skills cost their names and descriptions, not 30 documents.

- **Claude Code.** The adapter writes the mounts into a plugin folder in the hob's runtime folder that holds only a manifest and `skills/<name>/`, and passes it as `plugins: [{ type: "local", path, skipMcpDiscovery: true }]` with `skills: ["hobbots-skills:<name>", …]`, so the model's listing holds only the hob's skills and the Skill tool refuses any other. `settingSources: []` stays, so neither your `~/.claude` nor a repository's `.claude` loads anything. Verified in the probe: the plugin's two skills were listed as `hobbots-skills:<name>`, and its `.mcp.json` was skipped. The `skills` list is a filter on what the model sees, not a sandbox (the SDK says so), which is enough here because the only skills on disk that Claude Code loads beside the plugin's are its own built-in ones (below).
- **Codex.** The adapter writes the mounts into `CODEX_HOME/skills/<name>/` in the hob's own Codex home, which ADR 024 already keeps read-only to the sandbox, and turns off every root it does not use (below). Verified in the probe: skills there were listed with scope `user`. Codex's source calls `CODEX_HOME/skills` a location kept for backward compatibility; the App Server's `skills/extraRoots/set`, which the probe also saw add a root, is the fallback if a release drops it, and the contract tests of [#1061](https://github.com/otaviobarros/hobbots/issues/1061) find that before a user does.
- **A runtime without native skills** gets each mount's name and description in the turn's context block, labeled as reference data like the memory brief, and a hub tool `skill_read` that returns a mounted skill's files. Design only, until such a runtime exists.

The adapter rewrites its skills folder whenever a turn's mounts differ from the last turn's, and owns that folder entirely: nothing else is ever left in it.

- **Only when asked.** A mount the hob may not pick on its own is written with `disable-model-invocation: true` in its `SKILL.md` for Claude Code, and with `policy.allow_implicit_invocation: false` in `agents/openai.yaml` for Codex. These are written into the delivered copy from the mount, never into the stored revision. The Codex flag is read by Codex's skill loader in its source; the App Server's `skills/list` does not report it, so its effect on a turn is **unverified** until [#1061](https://github.com/otaviobarros/hobbots/issues/1061).
- **Explicit use.** Picking a skill with `/` in the composer becomes the runtime's own mention: `/hobbots-skills:<name>` on Claude Code and `$<name>` on Codex.
- **The use line.** A reply that used a skill shows a quiet line under it, such as "Used Release steps (r4)", like the line for a memory save. On Claude Code the adapter reads it from the Skill tool call; on Codex from an explicit mention and the model's read of a mounted `SKILL.md`. Both are **unverified** until [#1096](https://github.com/otaviobarros/hobbots/issues/1096).

### The clean-runtime rule

No hob loads anything installed in a runtime's own setup. Hobbots is the only thing that gives a hob skills, MCP servers, hooks or plugins. On every turn, chat-only turns included:

- **Claude Code** loads no skills, plugins, MCP servers, hooks or claude.ai connectors from `~/.claude`, `~/.claude.json` or a repository's `.claude` and `.mcp.json`. `settingSources: []` and the plugin above cover skills, plugins, hooks and file MCP servers. Verified in the probe with a fake home that held a skill, a hook and an MCP server, and a repository that held skills and an MCP server: none was listed, the hook did not run, and no MCP server was reported. **Unverified:** the claude.ai connectors a subscription sign-in can bring, which a fake home cannot show. Today `strictMcpConfig` is set only on turns with tools; [#1061](https://github.com/otaviobarros/hobbots/issues/1061) checks a chat-only turn on a real sign-in and closes it with whatever setting the probe proves.
- **Codex** loads no skills, MCP servers or configuration from `~/.codex`, since each hob has its own `CODEX_HOME` (ADR 024), and none from the roots it would otherwise scan. The probe found that, with `CODEX_HOME` set, Codex 0.166.0 still lists `~/.agents/skills`, a repository's `.agents/skills` and `.codex/skills` (even with the folder marked untrusted), and its own bundled skills. So before each turn the adapter writes, into the hob's `config.toml`, `[skills.bundled] enabled = false` and one `[[skills.config]]` rule with `enabled = false` for each `SKILL.md` it finds under `~/.agents/skills` and under each `.agents/skills` and `.codex/skills` between the repository's root and the hob's folder. Verified in the probe: with these, `skills/list` showed the bundled skills gone and each of those skills disabled, and only the hob's own as enabled. Codex 0.166.0 has no switch that turns a whole root off, so the adapter then checks `skills/list` before `turn/start`, and a turn that would see an enabled skill it did not mount does not start and says why.
- **A skill written during a turn.** Codex watches its roots, so a skill a hob writes into a repository's `.agents/skills` mid-turn can load in that turn. That is text the hob wrote itself, in the same turn; the next turn's rules turn it off, and Hobbots offers it for import like any repository skill.
- **Built-in skills.** Claude Code lists its own built-in skills and plugins whatever the settings (the probe saw them with an empty home); the `skills` list above keeps them out of the model's listing. Codex's bundled skills are turned off above.
- **Admin policy still applies.** Settings an administrator installs for a runtime (Claude Code's managed settings, Codex's system configuration and its `Admin` skills) are the organization's call, and Hobbots leaves them in force.
- **Repository instructions** (`AGENTS.md`, `CLAUDE.md`) are not covered by this ADR and load as they do today.

**`~/.agents/skills` stays, through Hobbots.** The shared folder is yours, not a runtime's, so its skills are kept, but no runtime reads it: the hub reads it itself, lists its skills under Everyone marked "from ~/.agents", and delivers them as mounts like any library skill, so every runtime gets the same set and a hob can opt out of one. The folder is a source: when its content changes, the hub makes a new revision of each changed skill, which rolls out like your own edit (below). A skill there that fails the import checks is listed with the rule it failed and is not delivered.

**One test for every runtime.** A clean-runtime contract test, in `@hobbots/runtimes`, runs each adapter, the fake included, against a fake home folder and a repository that hold a skill, an MCP server, a plugin, a hook and instruction files in every place that runtime reads, plus a skill in `~/.agents/skills`. It passes only when the runtime reports none of them, the `~/.agents` skill reaches the turn through Hobbots, and a mounted skill reaches it too. On Claude Code it reads what the model is offered from a stand-in for the API (`ANTHROPIC_BASE_URL`); on Codex from `skills/list` and a stand-in model provider, as the ADR 024 probe did. A new runtime adapter is not accepted until it passes.

### Scopes

A skill lives once in the library. Where it applies is an assignment, with the scopes Memory uses:

- **Everyone:** every hob, hobs summoned later included.
- **Project:** any hob while it works in a folder of that project. A project's identity is its normalized Git `origin`, as in ADR 028, so two clones share it.
- **Hob:** one hob.

A hob's skills for a turn are Everyone's, plus each project of the folders it works in, plus its own, resolved by `resolveSkills`:

- **The narrower scope wins a clash.** A hob's own skill replaces an Everyone or Project skill of the same name for that hob, and its profile shows the replaced one struck through.
- **Two projects that define one name** in the same turn are a warning on the hob, and neither loads until you pick one.
- **Opt out per hob.** A hob can turn off an Everyone or Project skill without removing it from the scope. That is a hob setting, so it survives updates.
- **Repository skills are a source, not a fourth scope** ([#1098](https://github.com/otaviobarros/hobbots/issues/1098)). Hobbots finds a repository's `.claude/skills` and `.agents/skills` and offers once per project to import them into that project's scope. They never load from the checkout, where a branch or a pull request could change them under a running hob.

### Storage and revisions

- **Immutable revisions.** A revision is a whole skill folder, identified by the SHA-256 of a canonical listing of its files (sorted relative paths, each file's mode and contents), and shown as r1, r2, r3. Its files live in `<data folder>/skills/objects/<hash>/`, written once and never changed. Importing the same content again returns the existing revision. A version the source carries (a Git tag, `metadata.version`, a plugin's version) is shown as a label only.
- **The database** holds skills, revisions, assignments, sources, proposals and uses, and refers to a revision only by its hash.

### Import

Adding a skill to the library and assigning it to a scope are two acts.

- **Sources:** written in Hobbots, a folder or an archive (`.zip`, `.skill`), copied and never linked, a Git repository resolved to a commit and kept as the source (a repository with many skills lists them to pick from), a repository a hob works in, a hob's proposal, and `~/.agents/skills`. Import reads a `skills-lock.json`, the lock file of the `skills` CLI, so a project that uses it keeps its versions.
- **Checks before anything is written:** valid front matter (a name in lowercase letters, digits and hyphens, and a description of at most 1,024 characters), no link or path outside the skill, no symlink, at most 5 MB and 200 files a skill. A failure names the file and the rule. No install script ever runs.
- **What is dropped:** a Claude Code plugin's hooks, commands, agents and `.mcp.json`, `allowed-tools` in the front matter, and the tool dependencies in Codex's `agents/openai.yaml`, each with a note, because they would add authority. A dependency on a Charm becomes a hint instead (below).
- **Flags** for what deserves a careful look: a script, a URL, and text hidden from view, such as zero-width characters. They show on an import and on every update.

### Pins and rollout

- **Pins per assignment.** "Everyone uses Commit style r3", "Pip uses Release steps r5". A change to the library never moves a pin by itself.
- **Your edits roll out automatically**, and say so before and after: the button reads "Save and roll out to 4 hobs", and What changed shows the rollout with Roll back. An assignment set to Keep on r4 is held and shows that r5 is available.
- **Rollback** is a rollout to an older revision, from History.
- **Running work keeps its revision.** The hub resolves a turn's mounts when the turn is accepted and records them with it, so a running turn, a queued turn and a Quest's Attempt in flight keep the revisions they were given. The next turn gets the new revision. Both adapters start a new runtime process for each turn: Codex's source publishes added and changed skills into a resumed thread's next turn, and Claude Code loads its plugins at each start. That a resumed session sees the new revision, and drops a removed skill, on each runtime is **unverified** until [#1061](https://github.com/otaviobarros/hobbots/issues/1061).
- **Every pin change is journaled** with who made it (you, or an approved proposal), and is part of the hob's versioned configuration, so the hob's History shows "Release steps r4 → r5".

### Updates from a source

For a Git source the hub looks once a day and on Check now, and never changes the library on its own ([#1097](https://github.com/otaviobarros/hobbots/issues/1097)). An upstream change shows as Update available, with a review: the `SKILL.md` diff, files added, removed and changed, and the flags. Accept makes a new revision and opens the rollout.

- **By hand by default.** Updates show on the Skills page under Updates, with a count.
- **Update automatically**, per skill you trust: each upstream revision is accepted and rolled out like your own edit, then shown in What changed with Roll back, and the skill says "Updates automatically from" its source.
- **A flagged update never applies on its own.** One that adds or changes a script, adds a URL or hides text waits for you with the flag shown, whatever the skill's setting.

### Proactive hobs

Every hob may suggest, but new skill content only enters the library through you, the same rule as Memory's shares, so an injected instruction cannot make itself a skill other hobs load ([#1063](https://github.com/otaviobarros/hobbots/issues/1063)).

| Tool | What it does | What happens |
| --- | --- | --- |
| `skill_propose` | A new skill, or a revision of one naming the revision it read, with why | A Skill card in the Inbox and in Skills › To review: Add, Edit then add, or Not now. A stale revision is shown against the newest one. Always asks |
| `skill_request` | Asks for a skill already in the library | Follows the preset: a review card under Careful and Balanced, through under Trusting, shown in What changed with Undo |
| `skill_feedback` | Says a skill is wrong, outdated or unclear, with a line | A note on the skill's page, counted, no Inbox card. Three notes suggest a revision |
| `skill_search` | Searches the library's names and descriptions | Never returns another hob's assignments |

- The tools are Hobbots' own, like Memory's, so they form a built-in **Skills** group in the tool policy (ADR 014), with Allow, Ask or Never per hob. They are not Charm tools. A refused call never reaches the library.
- **No spam.** At most one open proposal per hob per skill name, a retried key makes one card, and a hob with three proposals waiting is told to wait for your answer.
- **Origin.** A proposal keeps the hob, the thread and the memory pages it came from, shown as Learned from on the skill.
- **Try in a chat** opens a new chat with that hob where only the draft is loaded, before anyone else gets it ([#1099](https://github.com/otaviobarros/hobbots/issues/1099)).
- Later, the memory Curator turns procedure-like memory pages into proposals ([#1100](https://github.com/otaviobarros/hobbots/issues/1100)), and a memory page gets Turn into skill.

### Safety

A skill is instructions and files, never authority:

- **A skill grants nothing.** Its scripts run as the hob's own commands, under its tool policy and sandbox (ADR 014), and front matter that would grant tools is dropped on import.
- **Skill files are read-only to the turn.** The delivered folders are outside every folder a hob may write, and a hob changes a skill only by proposing a revision.
- **Only the hob's mounted skills load**, by the clean-runtime rule above.
- **New content waits for you.** A hob's proposal, and a flagged upstream update, never apply without your review under any preset.
- **A skill that needs a Charm** says so, and a hob without it sees a warning on its profile instead of a skill that fails halfway.

### Skills and Charms

A Charm is a connection with authority: it acts on an outside service, with policy operations, grants and credentials ([ADR 020](020-github-charm.md)). A skill is know-how with none. They are separate concepts, packages and pages, and neither imports the other.

- A skill can name the Charms it needs as `metadata.hobbots.charms` (for example `[github]`), and the tool dependencies in Codex's `agents/openai.yaml` are read into the same field on import. `resolveSkills` compares it with the Charm ids in the hob's configuration, which it already has, with no call into the Charms package.
- A future marketplace lists items of kind `charm` or `skill` and hands each install to the module that owns that kind through a small installer port, so adding skills to it changes no Charm code. There are no starter skills until then.
- They meet only on screens: a hob's profile shows its Charms and its Skills side by side, and a skill's page links to the Charm it needs.

### The Skills page

A Skills item in the sidebar, separate from Memory and built on its layout and parts: Overview, What changed, To review (proposals, requests and available updates, with a count) and Updates, then Everyone, each project and each hob. A skill opens with Instructions, Who uses it, History and Activity. A hob's page gets a Skills tab beside Memory. Memory and Skills link both ways (Turn into skill, Learned from). The screens are designed in [#1059](https://github.com/otaviobarros/hobbots/issues/1059) and built in [#1062](https://github.com/otaviobarros/hobbots/issues/1062).

### Journal events

`SkillRevisionAdded`, `SkillAssigned`, `SkillRolledOut`, `SkillHeld`, `SkillUpdateFound`, `SkillProposalRequested`, `SkillProposalChanged`, `SkillUsed` and `SkillRemoved`. Removing a skill that something still pins is refused with the list of who pins it; Unassign everywhere is one step, and a removed skill goes to the Archive.

### Backups, exports and Diagnostics

- **Backups** gain a `skills/` entry with every revision's files, and the database rows come with the rest ([#1064](https://github.com/otaviobarros/hobbots/issues/1064)).
- **Export** of the library, or of a chosen set, is a folder of skills with a `skills.lock.json` (name, source, revision hash and assignments), so another hub gets exactly the same revisions.
- **Diagnostics** name skills and revisions only, never their content.

### Out of scope

The skills marketplace and starter skills; drafting a skill by watching you work; skills for runtimes other than Claude Code and Codex, beyond the fallback above.

## Rationale

- **The library, not the runtimes, decides.** Each runtime finds skills in its own folders, and each folder can change under a hob. One library with immutable revisions makes the same skill reach every runtime, and makes what a hob loaded something you can see, pin and roll back.
- **Native loading over the prompt.** Both runtimes already list skills by description and read them on demand, so mounting them keeps the cost small and lets the runtime's own matching work. The context-block fallback exists only for a runtime that has none.
- **A plugin folder on Claude Code, `CODEX_HOME/skills` on Codex.** Each is the place that runtime already reads while Hobbots' isolation holds: `settingSources: []` keeps every other Claude Code source closed, and the hob's own `CODEX_HOME` is already read-only to the sandbox.
- **Turning roots off on Codex instead of moving `HOME`.** Codex finds `~/.agents/skills` through the home folder, but a different `HOME` would also change what the hob's commands see, such as Git's configuration. Per-skill rules, checked with `skills/list` before each turn, change nothing else. The hub reading `~/.agents/skills` itself is a refinement of the slice's first plan, made so both runtimes see the same skills and you control them.
- **Skill tools as a built-in group, not a Charm.** They act on Hobbots' own library, as Memory's tools act on memory, and grant nothing outside it. This drops the slice's dependency on the Charm registry.
- **Our own installer over the `skills` CLI.** The `skills` CLI has no library API, installs into the runtime folders hobs are kept from loading, takes the latest commit, keeps no revisions and sends telemetry by default. Reading its lock file keeps a project's versions without depending on it.
- **Review for content, the preset for requests.** A new or changed skill is instructions every hob that loads it follows, so it always waits for you. Asking for a skill already in the library changes no content, so the preset decides, as for any other tool call.

## Consequences

- A new package, `@hobbots/skills`, in the adapter layer, which `@hobbots/server` composes. `@hobbots/domain` gains the skill types, `@hobbots/agents` the port and `resolveSkills`, and `PromptRequest` gains `skills`.
- Each runtime adapter gains a skill delivery, a `SkillUsed` report and the clean-runtime contract test. The Codex adapter writes skill rules into the hob's `config.toml` and checks `skills/list` before each turn.
- The policy engine gains a Skills group, the Inbox a Skill kind, and backups a `skills/` entry.
- The hub watches `~/.agents/skills` and keeps a source for it.
- Contract tests pin the skill behavior of each runtime's probed version, so a release that moves a root or a flag fails a test before it reaches a hob.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Importing a folder, an archive and a Git revision makes one revision per distinct content, refuses a skill that breaks a check with the file and the rule, runs no script, drops hooks, commands, agents, MCP servers and tool grants with a note, and reads a `skills-lock.json` ([#1060](https://github.com/otaviobarros/hobbots/issues/1060)).
- A hob gets Everyone's, its projects' and its own skills, the narrower scope wins a clash, two projects that define one name load neither, and an opt-out survives an update; on the fake runtime, Claude Code and Codex the same mounts reach the turn, and Only when asked keeps the skill from being picked on its own on both ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- The clean-runtime contract test passes for the fake runtime, Claude Code and Codex: nothing in a fake home's `~/.claude`, `~/.claude.json` or `~/.codex`, or in a repository's `.claude`, `.mcp.json`, `.agents/skills` or `.codex/skills`, reaches a hob turn, chat-only turns included; a `~/.agents/skills` skill reaches every runtime through Hobbots; a Codex turn that would see a skill it did not mount does not start. On a real Claude Code sign-in, no claude.ai connector reaches a chat-only turn ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)). The probe's first findings are in the [evidence record](../evidence/2026-11-06-skills-loading-probe.md); not proven yet: a turn with a model on either runtime.
- A rollout reaches the next turn and never a running or queued one, a held assignment stays, a rollback restores the earlier revision, and a resumed session on each runtime sees the new revision and no longer sees a removed one ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- The Skills page and a hob's Skills tab show scopes, revisions, Who uses it, History and the rollout, in the browser on the fake runtime ([#1062](https://github.com/otaviobarros/hobbots/issues/1062)).
- `skill_propose` makes one card per hob and name, waits for you under every preset, and Add, Edit then add and Not now each work; `skill_request` follows the preset; `skill_feedback` and `skill_search` stay within the hob's reach; a Skills group answer of Never refuses the call before the library is reached ([#1063](https://github.com/otaviobarros/hobbots/issues/1063)).
- A backup restores every revision and assignment, an export's `skills.lock.json` brings back the same revisions on another hub, and Diagnostics hold no skill content ([#1064](https://github.com/otaviobarros/hobbots/issues/1064)).
- A reply that used a skill shows the use line with the revision on Claude Code and Codex, and the skill's page counts its uses ([#1096](https://github.com/otaviobarros/hobbots/issues/1096)).
- A Git source's change shows as Update available with its diff and flags; Update automatically applies an unflagged update and shows it with Roll back, and a flagged one waits ([#1097](https://github.com/otaviobarros/hobbots/issues/1097)).
- End to end, on Claude Code and Codex: a skill imported once and assigned to Everyone, a project and a hob is used by hobs on both runtimes, a rollout reaches the next turn, and the use line names the revision ([#1065](https://github.com/otaviobarros/hobbots/issues/1065)).
