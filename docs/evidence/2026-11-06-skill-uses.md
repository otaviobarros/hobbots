# A reply shows which skills it used, on Claude Code and Codex, with stand-in models

- **Date:** 2026-11-06
- **Issue:** [#1096](https://github.com/otaviobarros/hobbots/issues/1096)
- **Pull request:** the pull request that shows which skills a reply used
- **Commit:** `cee4116c` on `claude/project-thread-7bu5nj`, with a clean tree
- **Setup:** Linux x86_64 container (Node 22), running as root. Codex 0.166.0 (`@openai/codex` from npm) through `runCodexTurn`, with a stand-in for the Responses API set as a custom model provider. Claude Code 2.1.311 (the Agent SDK's own binary) through the adapter's `sendPrompt`, with a stand-in for the Messages API (`ANTHROPIC_BASE_URL`, a throwaway token) and every `CLAUDE*` and `ANTHROPIC*` variable of the machine removed. Both used the clean-runtime fixture, `packages/runtimes/test/clean-runtime.ts`, with a fake home folder. The hub-level tests ran on SQLite and on PostgreSQL 16 with the fake runtime. No account and no real model on either runtime.
- **Result:** Passed. On both runtimes, a skill the model picked and a skill you picked were each reported once as used, a skill the turn was not given never was, and a skill you picked reached the model through the runtime's own mention, an Only when asked one included. Through the hub, each reply recorded the revision its turn mounted, and the counts matched the recorded uses.

## Codex 0.166.0

`HOBBOTS_CODEX=<codex> pnpm --filter @hobbots/runtimes exec vitest run test/clean-runtime-codex.test.ts`

| Case | Check | Result |
|---|---|---|
| TC-RT-526 | The turn's `askedSkill` is an Only when asked skill, sent as a `skill` input item beside the text | ✅ The skill's instructions reached the model; `SkillUsed` reported once, `explicit: true` |
| TC-RT-527 | With tools, the model runs `cat` on the mounted skill's `SKILL.md`, then on a repository skill's `SKILL.md` | ✅ Codex reported both as `read` command actions; only the mounted skill was reported as used |
| TC-RT-510 to TC-RT-513 | The clean-runtime checks of #1061, again | ✅ Unchanged |

## Claude Code 2.1.311

`HOBBOTS_CLAUDE_CODE=<claude> pnpm --filter @hobbots/runtimes exec vitest run test/clean-runtime-claude-code.test.ts`

| Case | Check | Result |
|---|---|---|
| TC-RT-516 | The model calls `Skill` for the mounted skill, then for a home folder skill | ✅ `SkillUsed` reported once, for the mounted skill; the refused one never |
| TC-RT-525 | The turn's `askedSkill` is an Only when asked skill, sent as `/hobbots-skills:<name>` ahead of the prompt | ✅ The skill's instructions reached the model; `SkillUsed` reported once, `explicit: true` |
| TC-RT-514, TC-RT-515, TC-RT-517, TC-RT-518 | The clean-runtime checks of #1061, again | ✅ Unchanged |

## Through the hub

`pnpm --filter @hobbots/server exec vitest run test/skill-assignments.test.ts test/task-steps.test.ts`, and the same with `HOBBOTS_TEST_DB=postgres`

| Case | Check | Result |
|---|---|---|
| TC-AG-144 | A hob uses its skill twice in one turn after a rollout to r2, and names a skill it does not have | ✅ The reply records the skill once, at r2; nothing for the other; a later reply that used none records none |
| TC-AG-145 | You pick a skill with the `skill` field, with `/release-steps` typed at the start, and name one the hob lacks | ✅ Recorded as yours both times, the runtime got the prompt without `/release-steps`, and the unknown name was not handed to the turn. The skill's uses counted 3 in all and this week, per hob and per thread, and the hob's view listed it as last used |
| TC-OR-647 | A Task step uses the hob's skill | ✅ Counted for the hob, with no thread or reply |
| TC-DP-282 | Uses on SQLite and PostgreSQL | ✅ Each journaled as `SkillUsed` with its hob, thread and reply; read per skill, per hob and in all, newest first |

## Gaps

- No real model ran, so whether a real model picks a skill, and how often, was not observed.
- On Codex, a skill the model reads by any way other than a command Codex parses as a read (such as a script that prints it) is not counted.
- The Used line's Open, and the Activity tab, scope lists and hob Skills tab that show the counts, wait for the Skills page ([#1062](https://github.com/otaviobarros/hobbots/issues/1062)). The routes are in place.
- A skill from an administrator's settings is recorded as the organization's when the runtime names it; no runtime here had one used.
