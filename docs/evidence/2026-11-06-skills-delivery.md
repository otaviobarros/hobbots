# Each runtime loads only the skills Hobbots mounts, with fake home folders and stand-in models

- **Date:** 2026-11-06
- **Issue:** [#1061](https://github.com/otaviobarros/hobbots/issues/1061)
- **Pull request:** the pull request that adds skill delivery to `@hobbots/runtimes`
- **Commit:** the head of `claude/project-thread-xu1diu`, with a clean tree
- **Setup:** Linux x86_64 container (Node 22), running as root. Codex 0.166.0 (`@openai/codex` from npm) through `runCodexTurn`, with a stand-in for the Responses API set as a custom model provider. Claude Code 2.1.311 (the Agent SDK's own binary) and 2.1.319 through the adapter's `sendPrompt`, with a stand-in for the Messages API (`ANTHROPIC_BASE_URL`, a throwaway token) and every `CLAUDE*` and `ANTHROPIC*` variable of the machine removed. `HOME` pointed at a fake home folder for each run. The fixture, `packages/runtimes/test/clean-runtime.ts`, holds a skill, an MCP server, a plugin, a hook and instruction files in `~/.claude`, `~/.claude.json` and `~/.codex`, a skill in `~/.agents/skills`, and skills, hooks and MCP servers in a repository's `.claude`, `.mcp.json`, `.agents/skills` and `.codex/skills`. Every hook and MCP server touches a file if it ever runs. The turns mounted three hand-made revisions: one the hob may pick, one Only when asked, and the `~/.agents` skill as the hub would serve it. For Codex, an administrator's skill was written to `/etc/codex/skills`. No account and no real model on either runtime.
- **Result:** Passed. On both runtimes, chat-only turns and turns in the repository were offered exactly the mounted skills, the `~/.agents` one included, and nothing from the home folder or the repository; no hook or MCP server ran. claude.ai connectors and a real model were not observed.

## Codex 0.166.0

`HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/clean-runtime-codex.test.ts`

| Case | Check | Result |
|---|---|---|
| TC-RT-510 | Chat-only turn: what the stand-in model was offered | ✅ The mounted skill's and the `~/.agents` skill's descriptions; no Only when asked skill, no bundled skill, nothing from `~/.codex`, `~/.claude` or the repository |
| TC-RT-511 | Turn with tools in the repository | ✅ Same, with the repository's `.agents/skills` and `.codex/skills` turned off; its MCP server not started; the turn's skill folder removed after the turn |
| TC-RT-510, TC-RT-511 | An administrator's skill in `/etc/codex/skills` | ✅ Listed by `skills/list` with scope `admin`, let through the check, offered to the model and reported on `SessionStarted` as `organizationSkills` |
| TC-RT-512 | A turn without skills | ✅ No skill offered |
| TC-RT-513 | A skill that appears in `~/.agents/skills` after Hobbots wrote its rules, before Codex starts | ✅ The turn did not start, with the skill named; no model request was made |
| Control | The same fixture with no skill rules on the command line | ✅ The check refused the turn, naming the `~/.agents` skill, the repository's two and the five bundled skills Codex writes into `CODEX_HOME/skills/.system`, and not the administrator's |
| Probe | `$library-skill` in the prompt's text | Not loaded: the App Server loads a skill by mention only from a `skill` input item, so the composer's explicit use must send one ([#1096](https://github.com/otaviobarros/hobbots/issues/1096)) |

## Claude Code 2.1.311 and 2.1.319

`HOBBOTS_CLAUDE_CODE=<claude> pnpm --filter @hobbots/runtimes exec vitest run test/clean-runtime-claude-code.test.ts`

| Case | Check | Result |
|---|---|---|
| TC-RT-514 | Chat-only turn: the skills listing and tools in each request | ✅ The listing held only `hobbots-skills:library-skill` and `hobbots-skills:shared-agents-skill`; no built-in skill; the only tool was `Skill` (beside Claude Code's `DeferredToolPlaceholder`) |
| TC-RT-515 | Turn with tools in the repository | ✅ Nothing from `~/.claude`, `~/.claude.json` or the repository's `.claude` and `.mcp.json`; no `mcp__` tool; no hook ran; the turn's skill folder removed after the turn |
| TC-RT-516 | The model calls `Skill` for the mounted skill, then for a home folder skill | ✅ The first returned the skill's instructions, shown as a step; the second was refused with `Unknown skill` |
| TC-RT-517 | The prompt is `/hobbots-skills:asked-skill` (Only when asked) | ✅ The skill's instructions reached the model |
| TC-RT-518 | A turn without skills | ✅ No skill listed and no tool offered |

## Gaps

- claude.ai connectors and skills or plugins synced from claude.ai need a real subscription sign-in. Every turn now sets `disableClaudeAiConnectors`, `syncClaudeAiSkills: false` and `syncClaudeAiPlugins: false`, as the Agent SDK 0.3.311 documents them, and `strictMcpConfig` on chat-only turns too; their effect on a real sign-in is not observed.
- Whether Claude Code's managed settings can add skills was not probed.
- On Codex, Only when asked with an explicit `skill` input item was not run.
- The Hobbots sandbox around either runtime was not part of these runs; the skill folder's sandbox rules are covered by unit tests only.
- No real model ran.
