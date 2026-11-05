# A hob's saves show under its replies with Undo, and its page shows its memory

- **Date:** 2026-11-05
- **Issue:** [#961](https://github.com/otaviobarros/hobbots/issues/961)
- **Pull request:** the pull request of `claude/project-thread-2dd0rb`.
- **Commit:** the head of `claude/project-thread-2dd0rb`; not yet on `main`.
- **Setup:** Linux x86_64 container (Node 22.23.4). Hub-level cases run the API over a test SQLite database and the in-memory `MemoryStore`. Browser cases use the bundled Chromium through Playwright against a hub started per test on the fake runtime, with `HOBBOTS_MEMORY=on` and `HOBBOTS_FAKE_MEMORY` set to `empty` or `seeded`, so the fake's `memory_save` and the Memory page share one fake memory.
- **Result:** Passed with gaps, after rebasing on `main` at `2938f51`: persistence 160 tests, web 838, server 555 of 556 (the one failure, `[TC-DP-008]`, needs IPv6, which this container lacks, and fails on `main` too), and 24 end-to-end cases (the three below, plus the Memory page, a hob's page and its profile, which these changes touch).

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-331]` | A thread lists the saves its replies made, and only its own | ✅ hub, in-memory store |
| `[TC-GEN-332]` | Undo puts back the version a save replaced, as you, marks the save undone and journals it; a second Undo changes nothing | ✅ hub, in-memory store |
| `[TC-GEN-333]` | Undo of a save that made a page removes the page | ✅ hub, in-memory store |
| `[TC-GEN-334]` | Undo is refused once the page changed after the save, for a save memory does not have yet, and while memory does not answer (503), and works once it answers | ✅ hub, in-memory store |
| `[TC-GEN-335]` | A hob's memory answers its own scope, About you and the project of its folder, with counts; an unknown hob is 404 and memory down is 503 | ✅ hub, in-memory store |
| `[TC-GEN-336]` | The record finds a save, lists a thread's saves oldest first, and marks only a `saved` save undone, once, journaling it | ✅ SQLite |
| `[TC-UX-971]` | A save shows one line under the reply that made it, and none under another; it is read back after a reload; Open reads the page in Memory; Undo removes a page the save made and the line says so | ✅ browser, empty fake |
| `[TC-UX-972]` | Undo of a later save puts the earlier version back; Undo of the earlier save is then refused with why | ✅ browser, empty fake |
| `[TC-UX-973]` | A hob's Memory tab shows its count, three pages it learned lately and what it can read with counts; Open in Memory opens its scope; What it may remember opens Permissions, where the Memory group sets both rules | ✅ browser, seeded fake |
| Manual | The line, the tab and the Memory group in Workshop Night at 1280 wide, against the design's chat, hob page and Permissions boards | ✅ browser |

## Gaps

- Not run against the bundled ai-memory, nor with a real Claude Code or Codex turn saving: [#964](https://github.com/otaviobarros/hobbots/issues/964).
- Undo checks that the save is still the page's latest version, then restores; a write landing between the two is not refused by the engine, since `restore` takes no expected version.
- A save from a Task step, which belongs to no reply, shows no line. Tell every hob, shares and their review come with [#960](https://github.com/otaviobarros/hobbots/issues/960).
- Not run on macOS, nor in the packaged app.
