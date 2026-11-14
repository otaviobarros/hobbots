# Memory per hob in a shared camp, on every runtime

- **Date:** 2026-11-14
- **Issue:** [#1466](https://github.com/otaviobarros/hobbots/issues/1466)
- **Pull request:** [#1539](https://github.com/otaviobarros/hobbots/pull/1539)
- **Commit:** `acc6b19` on the pull request branch `claude/project-thread-w3652y`, based on `main` at `be37ae7`
- **Setup:** a Linux x86_64 cloud container, from a source checkout. The bundled ai-memory 3.4.2 and the fake memory. Replies from Claude Code and Codex as the journal records them, and the fake runtime acting as Claude Code and as Codex in the hub. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: in a camp where two hobs answer, each hob's memory kept its own replies and the person's messages it took a turn on, with the person as their source, and nothing of the other hob's turn or of a message no hob answered. A private camp reached no hob's memory, and making a camp private ended both hobs' sessions. Every write went to the writing hob's own memory, as that hob. Nothing was run with a real model.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-1466-01]` | `npx vitest run test/memory-capture.test.ts` in `packages/persistence`, on SQLite and with `HOBBOTS_TEST_DB=postgres` | ✅ a thread's session is open in two hobs' memory at once and each ends on its own; the messages hobs took are read back as stored |
| `[TC-GEN-1466-02]` | `npx vitest run test/capture-fake.test.ts test/capture-ai-memory.test.ts` in `packages/memory`, after `pnpm fetch-engine` | ✅ on both engines: Pip's memory held "what is our stall number?" and its reply, Quill's held "write the sign for it." and its Codex reply, the message body ending "(from user owner)"; neither held the other's turn nor "Lunch is at noon.", which no hob answered |
| `[TC-GEN-1466-03]` | The same | ✅ a private camp reached neither hob's memory; a camp made private ended both sessions and kept what each had |
| `[TC-GEN-1466-04]` | The same | ✅ every capture and session end went to the writing hob's own memory as that hob, with the journal naming the other hob as the thread's |
| `[TC-GEN-1466-05]` | `npx vitest run test/several-hobs-pack.test.ts` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`, with the fake runtime as Claude Code and as Codex | ✅ through the hub's own journal and capture worker: Wren's and Quill's memory each held their own message and reply only, and nothing written after the camp was made private |
| Earlier capture cases | `[TC-GEN-300]` to `[TC-GEN-402]`, `[TC-GEN-1377-01]` to `[TC-GEN-1377-09]`, `[TC-OR-598]`, `[TC-OR-600]`, `[TC-GEN-1377-04]`, the store contract | ✅ on both engines, SQLite and PostgreSQL |

## Gaps

- A person's message is kept by the hob whose reply names it as its prompt. The people's messages a pack carried under "Since you last spoke" are context, not a turn on them, so they are not kept.
- On ai-memory, a session is now kept under a name made from its hob's project and its id, so a session open when the hub updates continues under the new name and ai-memory ends the old one when it is idle. Chat notes written before keep their pages.
- The hub does not yet run a mentioned hob's turn in a camp with several hobs, so `[TC-GEN-1466-05]` hands the camp to the other hob in the database, as `[TC-CH-1465-06]` does.
- Not run with a signed-in runtime and a real model, nor on the packaged app.
