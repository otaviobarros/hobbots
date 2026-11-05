# The Memory page shows what hobs learned, from the fake and from ai-memory

- **Date:** 2026-11-05
- **Issue:** [#958](https://github.com/otaviobarros/hobbots/issues/958)
- **Pull request:** [#977](https://github.com/otaviobarros/hobbots/pull/977)
- **Commit:** the head of `claude/project-thread-na9aiw`, the branch of the pull request, after merging `main` at `d4cd3619`; not yet on `main`. This record is updated in the same commit as the reconnect and outage cases it lists.
- **Setup:** Linux x86_64 container (Ubuntu 24.04.5, Node 22.23.4) with ai-memory 3.4.2 for `linux-x64`, fetched and checked by `pnpm --filter @hobbots/memory fetch-engine`. Browser runs use the bundled Chromium through Playwright against a hub started per test, with `HOBBOTS_FAKE_MEMORY` set to `seeded`, `empty` or `down` and `HOBBOTS_MEMORY_LOOK_SECONDS=1`. The real engine was run with `HOBBOTS_MEMORY=on` and `HOBBOTS_MEMORY_ENGINE_DIR=packages/memory/engine/linux-x64`.
- **Result:** Passed with gaps: memory 71 tests (the ai-memory contract with `HOBBOTS_MEMORY_CONTRACT=1`), domain 153, agents 17, web 831, server 546 of 547 (the one failure, `[TC-DP-008]`, needs IPv6, which this container lacks, and fails on `main` too), and the five Memory end-to-end cases. Every view and state was captured in all four themes at 1440 and 1024 wide, with no sideways scroll in any.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-230]` | `versionChanges` gives a first version as all added lines and a later one as its added and kept lines; another page's or a forgotten page's version gives nothing; a hob never reads another hob's | ✅ fake and ai-memory 3.4.2 |
| `[TC-OP-094]` | `scopes` names the scopes that hold pages, projects included, and only those the actor may reach (from #971, which this branch now uses) | ✅ fake and ai-memory 3.4.2 |
| `[TC-UX-944]` | A page's kind comes from its folder, and `constructor/` or `__proto__/` paths read as notes | ✅ unit |
| `[TC-UX-955]` | A What changed event that lands while the first read is still out is kept: the read is cancelled and read again, so the save shows. Without the cancel the case fails | ✅ unit |
| `[TC-UX-957]` | A reconnect while the first read is still out cancels it and reads again, so a save made while the stream was away shows. Without the cancel the case fails | ✅ unit |
| `[TC-UX-951]` | Memory opens from the sidebar, shows Recently learned and About you, a hob's pages grouped by kind with a kind filter, and a page with its History and Show changes | ✅ browser, seeded fake |
| `[TC-UX-952]` | Search finds pages across scopes; What changed streams a new hob's saves within a look, and Yours leaves them out | ✅ browser, seeded fake |
| `[TC-UX-953]` | With nothing remembered, Memory says how it fills | ✅ browser, empty fake |
| `[TC-UX-954]` | While memory does not answer, Memory says so and Try again asks again | ✅ browser, fake down |
| `[TC-UX-958]` | With the page loaded and the hub not looking for changes, memory stopping makes the next look at the scopes, 30 seconds on, show the banner and the header's line over what loaded; memory answering again clears both on the look after. With the scopes read only polling while failed, the case fails | ✅ browser, seeded fake, scopes answered 503 by the browser |
| Manual | The hub with the real engine and no pages shows Nothing remembered yet; scopes answered 503 only while the engine started | ✅ browser, ai-memory 3.4.2 |
| Manual | Overview, a project, a hob, a page with changes, search, What changed, nothing yet and not answering, in Workshop Night, Workshop Daylight, Lamplight Dusk and Lamplight Paper, each at 1440 and 1024 wide: the theme applied and no sideways scroll in all 48 captures | ✅ browser, seeded, empty and down fakes |

## Findings

- ai-memory keeps old versions only as diffs from its history route, so the page shows what a version changed, not the whole old page.
- On every reconnect the browser reads memory again, since a save can land while the event stream is down.

## Gaps

- The real engine was looked at in the browser only with no pages; pages, versions and project scopes on it are covered by the store's contract cases, not by a browser run.
- Not run on macOS, nor in the packaged app.
- Edit, pin, forget, restore and editing About you come with [#959](https://github.com/otaviobarros/hobbots/issues/959); To review and shares with [#960](https://github.com/otaviobarros/hobbots/issues/960).
