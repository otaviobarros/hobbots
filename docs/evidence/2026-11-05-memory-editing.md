# You edit memory and About you, and an edit never overwrites a hob's save

- **Date:** 2026-11-05
- **Issue:** [#959](https://github.com/otaviobarros/hobbots/issues/959)
- **Pull request:** [#983](https://github.com/otaviobarros/hobbots/pull/983)
- **Commit:** the head of `claude/project-thread-dx4jmp`, the branch of the pull request, after merging `main`; not yet on `main`.
- **Setup:** Linux x86_64 container (Ubuntu 24.04.5, Node 22.23.4) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`, and the store's contract run with `HOBBOTS_MEMORY_CONTRACT=1`. Browser runs use the bundled Chromium through Playwright against a hub started per test with `HOBBOTS_FAKE_MEMORY=seeded`.
- **Result:** Passed with gaps: memory 114 tests, domain 153, web 836, server 552 of 553 (the one failure, `[TC-DP-008]`, needs IPv6, which this container lacks, and fails on `main` too), and the ten Memory end-to-end cases.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-330]` | A forget day is kept and cleared with the page; a page past its day leaves the list and search while a read still finds it | ✅ fake and ai-memory 3.4.2 |
| `[TC-GEN-331]` | Restoring a hob's version writes it back as a new version by you, with its tags and pin | ✅ fake and ai-memory 3.4.2 |
| `[TC-GEN-332]` | A chat note you pinned is not written again when its session ends again | ✅ fake and ai-memory 3.4.2 |
| `[TC-GEN-333]` | ai-memory's sweep deletes a page past its forget day and leaves a pinned page | ✅ ai-memory 3.4.2 |
| `[TC-GEN-334]` | An edit through the hub is a new version by you, History shows it, and Restore brings the one before back | ✅ hub, fake |
| `[TC-GEN-335]` | Pin and a forget day are versions by you over the version read | ✅ hub, fake |
| `[TC-GEN-336]` | Delete answers the version that brings the page back, and Undo restores it | ✅ hub, fake |
| `[TC-GEN-337]` | An edit, a pin or a delete over a version a hob replaced is refused with the current version and writes nothing; saved over the current version, it goes through; a new page never replaces one at its path | ✅ hub, fake |
| `[TC-GEN-338]` | About you's pages are yours, and every hob finds them | ✅ hub, fake |
| `[TC-UX-980]` | Edit saves a new version, and Restore in History brings the older text back | ✅ browser, seeded fake |
| `[TC-UX-981]` | Pin, a forget day with Keep it, and Delete with Undo | ✅ browser, seeded fake |
| `[TC-UX-982]` | A house rule in About you, and a new page that asks for a title first | ✅ browser, seeded fake |
| `[TC-UX-983]` | A save made while the editor is open refuses the editor's save and keeps its text; Save mine over it then writes it | ✅ browser, seeded fake |
| `[TC-UX-984]` | Open folder in the desktop app, and the line when it could not open | ✅ browser, stubbed desktop bridge |

## Findings

- ai-memory 3.4.2's `/admin/write-page` and `/admin/delete-page` take no expected version, and its page write no forget day, so your edits go over `/mcp` with the root bearer, which takes both and stamps you as the author.
- `/admin/restore-page` copies the old version's author, so the adapter writes the restored page once more as you; a restore makes two versions with the same text.
- ai-memory writes a session's page again at every end, pinned or not, so the hub sends no session end while its chat note is pinned.
- `[TC-UX-983]` first failed: the editor saved over whatever version the page read had refreshed to, so a save made meanwhile was overwritten without asking. The editor now saves over the version it opened.

## Gaps

- The browser has not run against the real engine; the store's behavior there is covered by the contract cases.
- Not run on macOS, nor in the packaged app.
- Shares and To review come with [#960](https://github.com/otaviobarros/hobbots/issues/960).
