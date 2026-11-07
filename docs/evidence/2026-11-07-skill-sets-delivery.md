# Skill sets through the Hobbots adapters, on Claude Code and Codex, with stand-in models

- **Date:** 2026-11-07
- **Issue:** [#1143](https://github.com/otaviobarros/hobbots/issues/1143)
- **Pull request:** the pull request that imports, delivers and exports skill sets
- **Commit:** `462314e` on that pull request's branch
- **Setup:** Linux x86_64 container, Node 26.13.0. The clean-runtime contract suites in `packages/runtimes/test`, run with `HOBBOTS_CLAUDE_CODE` set to Claude Code 2.1.311 (the binary of the pinned Agent SDK 0.3.311) and `HOBBOTS_CODEX` set to Codex 0.166.0, then to 0.167.0. These suites run the Hobbots adapters, the turn's skill folder, the sandbox and the policy hooks, with a stand-in for the model. CI skips them, because it has no runtime binaries. The suites' fixture mounts a set, `team-set`, with two skills that link to `references/rules.md` and to each other, a third skill the hob opted out of, and loose skills beside it. Separately, the importer took github.com/otaviobarros/agent-engineering at tag `v0.5.0` from Git into a fresh library.
- **Result:** Passed with gaps. On both runtimes, through the adapters, a set's skill loads from the set's folder, follows its links to the set's shared files and to a sibling skill, and is recorded as used with its set. The opted-out skill is offered nowhere. No real model ran.

## Contract suites

| Case | Runtime | Result |
|---|---|---|
| TC-RT-1143-01: a skill of a set follows its links to the set's files, and a chat-only turn reads nothing else | Claude Code 2.1.311 | ✅ |
| TC-RT-1143-02: with tools, a skill of a set reads the set's files under the policy's sandbox | Claude Code 2.1.311 | ✅ |
| TC-RT-1143-03: a skill of a set that was picked loads by `<set>:<name>` and is counted as used | Claude Code 2.1.311 | ✅ |
| TC-RT-1143-04: a skill of a set that was picked loads from its set's folder and follows its links | Codex 0.166.0, 0.167.0 | ✅ |
| TC-RT-1143-05: reading a set's skill's `SKILL.md` counts as using it, with its set | Codex 0.166.0, 0.167.0 | ✅ |
| Whole suites with the set mounted: Claude Code and Codex 0.167.0 suites plus the fake runtime's | all | ✅ 18 passed |
| Whole Codex suite | Codex 0.166.0 | ✅ 8 passed |

## Importing agent-engineering v0.5.0

| Check | Result |
|---|---|
| Import from Git at `v0.5.0` | ✅ One set, `agent-engineering`, labelled `0.5.0`, from commit `5d044fe` |
| Its skills | ✅ All nine: deliver-change, implement-change, plan-change, publish-change, remediate-findings, review-change, review-pr, setup-project and verify-change |
| What it keeps | ✅ 14 files: the nine `SKILL.md`, the four files in `references/` and setup-project's template. Nothing else of the plugin |
| Flags | ✅ Three URLs in review-pr's `SKILL.md`, shown for review |

## Gaps

- No real model ran, so whether a model follows a skill's links unprompted is still not observed ([#1065](https://github.com/otaviobarros/hobbots/issues/1065)).
- The imported agent-engineering set was not run through a hob turn. The contract suites use their own fixture set.
- macOS was not part of this run.
