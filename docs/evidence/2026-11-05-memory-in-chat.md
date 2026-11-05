# A hob's saves show under its replies with Undo, and its page shows its memory

- **Date:** 2026-11-05
- **Issue:** [#961](https://github.com/otaviobarros/hobbots/issues/961)
- **Pull request:** the pull request of `claude/project-thread-2dd0rb`.
- **Commit:** the head of `claude/project-thread-2dd0rb`; not yet on `main`.
- **Setup:** Linux x86_64 container (Node 22.23.4). Hub-level cases run the API over a test SQLite database and the in-memory `MemoryStore`. Browser cases use the bundled Chromium through Playwright against a hub started per test on the fake runtime, with `HOBBOTS_MEMORY=on` and `HOBBOTS_FAKE_MEMORY` set to `empty` or `seeded`, so the fake's `memory_save` and the Memory page share one fake memory.
- **Result:** Passed with gaps. After review, the cases added for Undo's race, the live list and a failed read pass too: the memory store contract on both stores, the hub's six, the three unit cases and the four browser cases in `memory-in-chat`. Before review, after rebasing on `main` at `2938f51`: persistence 160 tests, web 838, server 555 of 556 (the one failure, `[TC-DP-008]`, needs IPv6, which this container lacks, and fails on `main` too), and 24 end-to-end cases (the three in the first pass, plus the Memory page, a hob's page and its profile, which these changes touch).

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-341]` | A thread lists the saves its replies made, and only its own | ✅ hub, in-memory store |
| `[TC-GEN-342]` | Undo puts back the version a save replaced, as you, marks the save undone and journals it; a second Undo changes nothing | ✅ hub, in-memory store |
| `[TC-GEN-343]` | Undo of a save that made a page removes the page | ✅ hub, in-memory store |
| `[TC-GEN-344]` | Undo is refused once the page changed after the save, for a save memory does not have yet, and while memory does not answer (503), and works once it answers | ✅ hub, in-memory store |
| `[TC-GEN-345]` | A hob's memory answers its own scope, About you and the project of its folder, with counts; an unknown hob is 404 and memory down is 503 | ✅ hub, in-memory store |
| `[TC-GEN-347]` | Undo is refused when you change the page after it read the page's history, and your change stays | ✅ hub, in-memory store |
| `[TC-GEN-175]` | A restore against a version that is no longer the latest writes nothing and answers the current one | ✅ in-memory store and the bundled ai-memory 3.4.2 |
| `[TC-GEN-348]` | A restore at a version is refused when ai-memory itself writes the page after the restore read it, and that write stays | ✅ bundled ai-memory 3.4.2 |
| `[TC-GEN-350]` | ai-memory's line diff rebuilds one version from another, and a diff that does not fit is refused | ✅ unit |
| `[TC-GEN-349]` | A restore brings an earlier version back line for line, with its blank and last lines | ✅ in-memory store and the bundled ai-memory 3.4.2 |
| `[TC-GEN-346]` | The record finds a save, lists a thread's saves oldest first, and marks only a `saved` save undone, once, journaling it | ✅ SQLite |
| `[TC-UX-971]` | A save shows one line under the reply that made it, and none under another; it is read back after a reload; Open reads the page in Memory; Undo removes a page the save made and the line says so | ✅ browser, empty fake |
| `[TC-UX-972]` | Undo of a later save puts the earlier version back; Undo of the earlier save is then refused with why | ✅ browser, empty fake |
| `[TC-UX-973]` | A hob's Memory tab shows its count, three pages it learned lately and what it can read with counts; Open in Memory opens its scope; What it may remember opens Permissions, where the Memory group sets both rules | ✅ browser, seeded fake |
| `[TC-UX-974]` | A save that arrives while a thread's first read of its saves is on its way still shows when that read answers late | ✅ unit, query client |
| `[TC-UX-975]` | An Undo that arrives while a later read is on its way is not put back by that read | ✅ unit, query client |
| `[TC-UX-976]` | When the stream resumes, a read already on its way is dropped and the saves read again | ✅ unit, query client |
| `[TC-UX-977]` | When a chat's saves cannot be read it says so, no line shows, and Try again brings them back | ✅ browser, empty fake |
| Manual | The line, the tab and the Memory group in Workshop Night at 1280 wide, against the design's chat, hob page and Permissions boards | ✅ browser |

## Gaps

- Not run against the bundled ai-memory, nor with a real Claude Code or Codex turn saving: [#964](https://github.com/otaviobarros/hobbots/issues/964).
- A restore at a version, as Undo's, keeps the page's current tags and pin: ai-memory answers them only for the latest version. One whose diff ai-memory cuts short is refused rather than written.
- A restore with no expected version, as the Memory page's, goes through ai-memory's `restore-page`, which takes no precondition; the hub's own changes wait meanwhile.
- A save from a Task step, which belongs to no reply, shows no line. Tell every hob, shares and their review come with [#960](https://github.com/otaviobarros/hobbots/issues/960).
- Not run on macOS, nor in the packaged app.
