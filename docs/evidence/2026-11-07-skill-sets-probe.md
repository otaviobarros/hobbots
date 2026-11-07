# How Claude Code and Codex load a set of skills that share files, with stand-in models

- **Date:** 2026-11-07
- **Issue:** [#1143](https://github.com/otaviobarros/hobbots/issues/1143)
- **Pull request:** the pull request that amends [ADR 029](../decisions/029-skills.md) with skill sets
- **Commit:** `0b3c501` on `main`, for the probe; no Hobbots code ran
- **Setup:** Manual probe in a Linux x86_64 container (Node 26.13.0). Codex 0.166.0, the minimum Hobbots supports, and 0.167.0, the newest stable release (`@openai/codex` from npm), each started as `codex app-server` over stdio by a small JSON-RPC client, with `HOME` set to a fake home folder, `CODEX_HOME` to an empty Codex home, the working folder in a fake Git repository and `-c skills.bundled.enabled=false`. Claude Code 2.1.311 through the Agent SDK 0.3.311, the version Hobbots pins, and Claude Code 2.1.319 through the Agent SDK 0.3.319, the newest, with the same kind of fake home and repository and the options the adapter passes (`settingSources: []`, `strictMcpConfig: true`, `disableBundledSkills`, `disableSkillShellExecution`). A stand-in played the model and recorded each request, as in the [first skills probe](2026-11-06-skills-loading-probe.md): a stand-in for the Responses API as a custom model provider for Codex, and a stand-in for the Messages API (`ANTHROPIC_BASE_URL`) for Claude Code. The set was [agent-engineering](https://github.com/otaviobarros/agent-engineering) v0.5.0 (commit `5d044fe`): nine skills under `skills/<name>/SKILL.md` and the shared rules in `references/` at its root, which the skills link to as `../../references/workflow-contract.md` and to each other as `../plan-change/SKILL.md`. Beside it were a second set, `other-set`, with its own `plan-change` and `references/rules.md`, and one loose skill, `release-steps`.
- **Result:** Passed with gaps. On both runtimes a set's skills load from a folder laid out as the set is, a skill's relative links reach the set's shared files and its sibling skills, the clean-runtime admission check still holds, and two sets can each bring a skill of the same name. No real model ran.

## Codex 0.166.0 and 0.167.0

Both versions gave the same results.

| Case | Check | Result |
|---|---|---|
| Probe | `skills/extraRoots/set` with `<set>/skills` for each set and `skills/` for the loose skill, then `skills/list` | ✅ All eleven skills listed, each with scope `user`, enabled, at its path in its set: the nine of agent-engineering, `other-set`'s `plan-change` and `release-steps`. Each is named by its front matter alone (`deliver-change`), with no set prefix |
| Probe | One extra root at the set's own folder, `<set>`, rather than `<set>/skills` | ✅ The same nine skills: Codex searches below a root, so `references/` beside `skills/` is no obstacle and holds no skill |
| Probe | One extra root above every set and the loose skill | ✅ All eleven again |
| Probe | Two roots that each hold a `plan-change` | ✅ Both listed, each with its own path. The model's skills block lists both, each with its path |
| Probe | `turn/start` with the text and a `skill` input item naming `deliver-change` and the `SKILL.md` in its set | ✅ The model's first request held a `<skill>` block with the name, the mounted path and the whole `SKILL.md` |
| Probe | The stand-in model then runs `cat '<skill folder>/../../references/workflow-contract.md'` and `cat '<skill folder>/../plan-change/SKILL.md'` | ✅ Both commands printed the files: the shared rules and the sibling skill |
| Probe | A `skill` item for `plan-change` with the path of `other-set`'s copy, while agent-engineering's is listed too | ✅ The model was given `other-set`'s `SKILL.md`, not agent-engineering's: the item's path decides which of two skills of one name loads |
| Probe | The same plugin installed the way Codex installs one (`codex plugin marketplace add` and `codex plugin add`), in a separate Codex home | Its skills listed as `agent-engineering:deliver-change` and so on, from a copy in `CODEX_HOME/plugins/cache`, and the install wrote the plugin into `config.toml`, which every turn of a hob shares. Codex took the plugin's manifest from either `.claude-plugin/plugin.json` or the `plugin.json` at the root, with the other one removed |

## Claude Code 2.1.311 and 2.1.319

Both versions gave the same results. Each set was passed as its own local plugin (`plugins: [{ type: "local", path, skipMcpDiscovery: true }]`) with a manifest naming the set, and the loose skill as the `hobbots-skills` plugin, as today.

| Case | Check | Result |
|---|---|---|
| Probe | `system/init` with three plugins | ✅ `agent-engineering:<name>` for each of the nine skills, `other-set:plan-change` and `hobbots-skills:release-steps`; the three plugins listed by those names |
| Probe | `skills` naming all five that were used, and the first request to the stand-in | ✅ Each named skill was offered, with its plugin prefix; `agent-engineering:plan-change` and `other-set:plan-change` side by side |
| Probe | `skills: ["agent-engineering:deliver-change"]` alone | ✅ Only that skill was offered; the other sets' skills and the loose one were left out |
| Probe | The stand-in model calls the Skill tool for `agent-engineering:deliver-change` | ✅ The tool answered with the skill's instructions and `Base directory for this skill:` the skill's folder in its set |
| Probe | In the resumed session, the model reads `<base>/../../references/workflow-contract.md` and `<base>/../plan-change/SKILL.md` with the Read tool | ✅ Both files were read: the shared rules and the sibling skill |
| Probe | The prompt `/agent-engineering:deliver-change go` | ✅ The skill's instructions reached the model, with `go` as its arguments |
| Probe | The prompt `/deliver-change go`, with only one skill of that name | ✅ The skill's instructions reached the model: Claude Code finds a plugin's skill by its bare name |
| Probe | The prompt `/plan-change go`, with `agent-engineering:plan-change` and `other-set:plan-change` both loaded | ❌ No choice or warning: Claude Code loaded agent-engineering's, the first plugin passed. The bare name is ambiguous, so the adapter must always send the prefixed form |
| Probe | A set's manifest with `skills: ["./procedures", "./more/deep"]` and skills in those folders and in `skills/` | ✅ All four listed as `<set>:<name>`: the manifest's `skills` paths are searched along with `skills/` |

## What this means for ADR 029

- A set is delivered as a folder laid out as it was imported, so a skill's relative links resolve to the same files on both runtimes. Hobbots never rewrites a link.
- On Claude Code, each set is its own plugin named after the set, which gives the `<set>:<name>` names Claude Code already uses for a plugin's skills. The adapter mentions the prefixed name, so two sets that share a skill name never load the wrong one.
- On Codex, each set's folder is one more extra root, as the loose skills' folder is. Codex names the skills by their front matter alone, and the `skill` item's path picks between two of the same name. Codex's own plugin install is not used: it writes to the configuration every turn of a hob shares.
- The admission check (`skills/list` before `turn/start`) needs no change beyond counting each set's folder as mounted: every listed skill was under a root the client set.

## Gaps

- No real model ran, so whether a model follows a skill's links on its own, without the stand-in's scripted reads, is not observed ([#1065](https://github.com/otaviobarros/hobbots/issues/1065)).
- The Hobbots adapters, sandbox and policy were not part of the probe: the reads and commands ran without them. The clean-runtime contract test with a set mounted is part of [#1143](https://github.com/otaviobarros/hobbots/issues/1143).
- macOS was not part of the probe.
