# Hobs on Claude Code and Codex pick a well-described skill on their own

- **Date:** 2026-11-07
- **Issue:** [#1201](https://github.com/otaviobarros/hobbots/issues/1201)
- **Pull request:** [#PR](https://github.com/otaviobarros/hobbots/pull/PR)
- **Commit:** `fea550e` on `main`, with a clean tree
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64. The hub ran from a worktree of `main` on a new data folder under Balanced, with its own port, never the Mac's Hobbots data. `HOBBOTS_AGENTS_SKILLS` pointed at a stand-in folder that held only `qa-house-style`, so it was each hob's only skill. Pip ran on Claude Code 2.1.316 and Quill on Codex 0.166.0, both on a signed-in subscription. A second run used the Claude Code 2.1.319 CLI in a Linux x86_64 container, set up the way a hob's chat turn is (below).
- **Result:** Passed. With a description that says when to load the skill, every model tried picked it on its own at least once, and all but `gpt-6-luna` at its default effort picked it every time. With the vague description from #1065, the cheapest model at low effort missed on both runtimes, and a native install of the skill missed as often. Hobbots offers a mounted skill to the model the same way each runtime offers its own, so a miss is the model's choice, and the description is what changes it.

The skill's body was always "Number every step, and end with the word OTTER." The prompt was always "Give me three steps to water a plant.", with no `/` and each try in a new thread. Two descriptions were tried:

- **D1**, from the #1065 check: "Use when writing any reply that lists steps. Number every step."
- **D2**: "House style for every reply that gives steps, instructions or a how-to, however short. Load it before writing any list of steps: it holds a closing rule the reply must follow."

## Checks

A try counts as picked when the reply ends with OTTER, the reply's `skillsUsed` names the skill, and the runtime's log shows the load: the Skill tool call on Claude Code, a read of the mounted `SKILL.md` on Codex. The three agreed on every try, and no try asked for an approval. Cells are picked / tries.

### Through hobs on the Mac

| Hob | Model, effort | D1 | D2 |
|---|---|---|---|
| Pip | `haiku`, low | 1/3 | 3/3 |
| Pip | `haiku`, default (medium) | 3/3 | 3/3 |
| Pip | `sonnet`, default (medium) | 3/3 | 3/3 |
| Pip | `opus`, default (medium) | 3/3 | 3/3 |
| Quill | `gpt-6-luna`, low | 0/3 | 3/3 |
| Quill | `gpt-6-luna`, default | 2/3 | 1/3 |
| Quill | `gpt-6-astra`, default | 3/3 | 3/3 |

Two more Pip turns on `haiku` at low effort with D1, a first probe and the turn whose start was captured, also missed. They are not in the table.

### A native install of the same skill, with D1

The same skill installed where each runtime finds its own skills, outside Hobbots: in a throwaway `CODEX_HOME/skills` for `codex exec`, and in a throwaway project's `.claude/skills` for `claude -p`.

| Model, effort | Native | Through the hob |
|---|---|---|
| Codex `gpt-6-luna`, low | 0/3 | 0/3 |
| Codex `gpt-6-luna`, default | 1/3 | 2/3 |
| Codex `gpt-6-astra`, default | 3/3 | 3/3 |
| Claude Code `haiku`, low | 4/13 | 3/13 |

The `haiku` row holds 10 tries on each side beyond the first 3, run because the first 3 disagreed (native 3/3, the hob 1/3).

### Claude Code 2.1.319 in the cloud

The skill in a local plugin named `hobbots-skills`, `--setting-sources ""`, `--strict-mcp-config`, the tools `Skill` and `Read` only, the hub's runtime settings (bundled skills off, shell commands in a skill's text off), and "You are Pip, a hob in Hobbots." appended to the preset prompt. No hub tools and no memory. "Beside 40" adds 40 unrelated skills with long descriptions to the plugin.

| Description | Skills | `haiku` low | `haiku` default | `sonnet` low | `sonnet` default | `opus` default |
|---|---|---|---|---|---|---|
| D1 | alone | 1/3 | 3/3 | 3/3 | 3/3 | 2/2 |
| D2 | alone | 3/3 | 3/3 | 3/3 | 3/3 | 2/2 |
| D1 | beside 40 | 2/3 | 2/3 | 3/3 | 3/3 | 2/2 |
| D2 | beside 40 | 3/3 | 3/3 | 3/3 | 3/3 | 2/2 |

### What each runtime offers the model

- **Claude Code.** The model's skill listing holds `- hobbots-skills:qa-house-style: Use when writing any reply that lists steps. Number every step.`, in the same "available for use with the Skill tool" listing a native skill is in, and the Skill tool's text is the same. Neither the session's `init` message nor the listing marks a skill as one the model may invoke: a skill the model can pick is one that is listed, and an Only when asked one is left out (ADR 029). `init` also names Claude Code's `doctor` and `plugin-authoring`, which the model's listing leaves out.
- **Codex.** The model gets the same `<skills_instructions>` block as for a native skill, with each skill on a line in the same form. `skills/list` answers the mount with the name `hobbots-skills:qa-house-style`, scope `user`, enabled, no `pluginId` and no policy, so implicit invocation stays at Codex's default, which allows it. The hub does not log that answer, so it was read again on the hob's Codex home after the matrix.

## Findings

- Hobbots delivers a mounted skill as each runtime delivers its own. The differences are the `hobbots-skills:` prefix on the name, on both runtimes, that the hob sees only its own skills, and Hobbots' own instructions and hub tools beside it. None of them made a native install pick more often. On Codex the prefix seems to come from the mount's `.claude-plugin/plugin.json`.
- The description decides. A description that names the requests the skill is for, and says to load it before answering them, turned 1/3 and 0/3 into 3/3 at low effort on both runtimes. It does not guarantee a pick: `gpt-6-luna` at its default effort picked D2 once in three tries.
- Codex's own instructions tell the model not to use a skill "based solely on keywords, superficial relevance", which fits `gpt-6-luna` skipping D1. This was not tested on its own.
- Claude Code's default effort for these models resolved to medium. Codex's rollout does not record the effort, so `gpt-6-astra`'s default on a hob turn is not shown.
- Writing a folder skill back to an earlier revision's exact text, then syncing, left the library on the newer revision and made no new one. Seen once and not traced.

## Gaps

- Three tries a cell show a tendency, not a rate.
- The hub ran from a worktree of the repository, not from a packaged app.
- Turns ran in chat only. A Task step and a party member were not tried.
- On the Mac each hob had one skill. Only the cloud run tried the skill beside others.
