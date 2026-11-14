# The context pack with several hobs, on every runtime

- **Date:** 2026-11-14
- **Issue:** [#1465](https://github.com/otaviobarros/hobbots/issues/1465)
- **Pull request:** to be opened from `claude/project-thread-qrxw3r`
- **Commit:** the pull request branch `claude/project-thread-qrxw3r`, on `main` at `8e6dd57`
- **Setup:** a Linux x86_64 cloud container, from a source checkout. Claude Code 2.1.325, and codex-cli 0.169.0, installed and not signed in, each answered by a stand-in model: Claude Code through a Messages API stand-in, Codex through a Responses API stand-in. The fake runtime in the same run. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: in a camp with two hobs, each hob's new session started from a pack that listed the members and why it answered, named every speaker and carried only its own memory brief; a resumed session heard only what others said since its hob last spoke. The pack reached the model with the prompt, never in its system prompt or instructions, on Claude Code, Codex and the fake runtime. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-CH-1465-01]` to `[TC-CH-1465-04]` | `npx vitest run test/context-pack.test.ts` in `packages/agents`: speakers named, the members part with its reason kept when cut, Quests listed before Tasks, and "Since you last spoke" within the live chapter's share | ✅ |
| `[TC-CH-1465-05]` | `npx vitest run test/pack-people.test.ts` in `packages/agents`: the turn's reason is the hob's own entry from `answerersFor` | ✅ |
| `[TC-CH-1465-06]` | `npx vitest run test/several-hobs-pack.test.ts` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`: in Wren's camp, which Quill joined, Wren speaks, then Quill, then Wren again, with the fake runtime as Claude Code and as Codex | ✅ Quill's new session listed the members and "Owner mentioned you.", named the owner and Wren, and held Quill's memory and never Wren's; Wren's resumed session heard only the owner's message to Quill and Quill's reply, and never Quill's memory |
| `[TC-RT-1465-01]` | `HOBBOTS_CLAUDE_CODE=<claude> npx vitest run test/clean-runtime-claude-code.test.ts -t 1465` in `packages/runtimes` | ✅ the pack and the prompt reached the model in one user message; another hob's words never reached the system prompt |
| `[TC-RT-1465-02]` | `HOBBOTS_CODEX=<codex> npx vitest run test/clean-runtime-codex.test.ts -t 1465` in `packages/runtimes`, on Codex 0.169.0 | ✅ the same on Codex, never in its instructions |
| `[TC-RT-1465-03]` | The same on the fake runtime | ✅ |

## Gaps

- The stand-in models answer what each prompt scripts. Not run with a signed-in runtime and a real model, nor on the packaged app.
- The hub does not yet run a mentioned hob's turn in a camp with several hobs, so `[TC-CH-1465-06]` hands the camp to the other hob in the database, as `[TC-CH-1464-01]` does. The floor ([#1461](https://github.com/otaviobarros/hobbots/issues/1461)) will hand each turn its `TurnRequest`, whose cause and author the pack then says.
- Members are listed once per session, in the pack. A resumed session is not told when a member joins or leaves; it sees new speakers named in "Since you last spoke".
- Reply threads are not built, so "the line" is the main line.
