# Shares and memory outages hold on the packaged Mac app with real Claude Code and Codex hobs

- **Date:** 2026-11-06
- **Issue:** [#951](https://github.com/otaviobarros/hobbots/issues/951)
- **Pull request:** [#1050](https://github.com/otaviobarros/hobbots/pull/1050)
- **Commit:** `ceb66e9` on `main`, with a clean tree
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64, an ad hoc signed `pnpm package:mac` build, ai-memory 3.4.2, Claude Code 2.1.316 on a signed-in subscription with the `haiku` model, Codex 0.166.0 on a signed-in subscription with the `gpt-6-luna` model, both on low effort. The memory model was the default, which resolves to `haiku`. The app ran on a new data folder (`--user-data-dir`) with `HOBBOTS_MODE=hub` and opening at login off, never the Mac's Hobbots data, under the Balanced preset, with one approved Git folder and no remote. Hobs: Moss and Fern on Claude Code, Reed and Sedge on Codex.
- **Result:** Passed with gaps. On both runtimes a share reaches another hob only after it is approved in the Inbox, and stopping ai-memory in the middle of a chat loses no save and no turn. Three bugs came up, and none of them breaks these checks: search misses plain questions, a long Codex command ends as uncertain, and a session page reads a kept save as lost.

## Checks

Replies and tool answers came from real turns. Shares were decided by clicking Share it in the Inbox of the app's own window, driven over its debugging port.

| Case | Check | Claude Code | Codex |
|---|---|---|---|
| Share waits | A hob calls `memory_save` with scope `project`. It is told the page waits for review in the Inbox, and the share is `waiting` | ✅ Moss | ✅ Reed |
| Nothing before approval | The other hob's `memory_search` for the page's word answers nothing | ✅ Fern, `lint` | ✅ Sedge, `deploys` |
| Inbox | The request shows the hob, the project and the page's text, and Share it records it as `shared` | ✅ | ✅ |
| After approval | The other hob's `memory_search` for the same word finds the page | ✅ Fern | ✅ Sedge |
| Brief after approval | A new thread of the other hob knows the page before any tool call | ✅ Fern | ✅ Sedge |
| Engine down mid-reply | `kill -9` on ai-memory with its binary moved away, during a reply running `sleep 15`. The reply ends `complete`, and the save that follows the kill answers that Hobbots kept the page | ✅ Moss | ✅ Reed |
| Chat goes on | While memory is down, the same thread takes another turn, and a new thread is told memory is unavailable and answers from there | ✅ | ✅ |
| Save arrives | With the binary back and the app quit and opened again, the kept page is in the hob's memory, with one version, written as the hob | ✅ | ✅ |
| Quick crash | `kill -9` on ai-memory with its binary in place, just after a turn starts. The hub starts it again, the reply ends `complete`, and the page has one version. The save may have landed either side of the kill | ✅ | ✅ |
| Capture | Archiving the thread writes `sessions/<thread id>.md` in the hob's memory, with every prompt, reply and tool step, including the turns during the outage | ✅ | ✅ |
| Summary on a real sign-in | The memory model rewrites the session page as a second version, and Usage counts 2 calls, 6,570 tokens in and 867 out | ✅ `haiku` | ✅ `haiku` |
| Memory tools | Real turns call `memory_search` and `memory_save`, each shown as a tool step | ✅ | ✅ |
| Carries over | A new thread quotes the hob's own page with no tool call | Proven in [the earlier record](2026-11-05-memory-packaged-app.md) | ✅ Reed |

## Findings

- [#1047](https://github.com/otaviobarros/hobbots/issues/1047): `memory_search` and the Memory page's search find a page only when every word of the query is a whole word in it. "how does this project run its tests" answers nothing while "tests" finds the page, and word starts and hyphenated names fail too. The first "nothing before approval" search used such a sentence, so it proved nothing and was run again with one word, as the table shows.
- [#1048](https://github.com/otaviobarros/hobbots/issues/1048): Codex answered `sleep 15` after about 10 seconds, the hob reported it as done, and the step ended as `uncertain`. Claude Code's step ended as `done`.
- [#1049](https://github.com/otaviobarros/hobbots/issues/1049): a session page's summary still says a kept save was not written after it arrived. Events sent late carry the time they reached memory.
- With its binary gone the engine goes off and stays off, even once the binary is back, until the app starts again. The hub answers 503 for memory reads meanwhile, and nothing is lost.

## Gaps

- The Inbox was driven through the window's debugging port, not with a person's mouse.
- `everyone` shares, Edit, then share, Keep it private and Undo did not run on real turns. Hub tests cover them ([evidence](2026-11-05-memory-shares.md)).
- A stop between sending a page and hearing back from ai-memory was not forced here. Hub tests cover it.
- The x64 app was built but not run, and a Developer ID signed and notarized build does not exist yet.
