# Hobs search and read the web end to end: sources, site rules, data going out and robots.txt

- **Date:** 2026-11-09
- **Issue:** [#1272](https://github.com/otaviobarros/hobbots/issues/1272)
- **Pull request:** the pull request that lands this record
- **Commit:** the head of `claude/project-thread-255w81` that lands this record, after `4cdce15` on `main`.
- **Setup:** the cloud Linux container (x86_64), Node 22.23.4, the fake runtime, a local test site standing in for the web, SQLite and PostgreSQL 16, and Chromium for the browser tests with the hub's stand-in web (`HOBBOTS_FAKE_WEB=on`). The clean-runtime contract tests ran against an installed Claude Code 2.1.321 and Codex 0.166.0 and 0.167.0, each with a stand-in model and no account.
- **Result:** Passed with gaps: every scenario of #1272 passes at hub level with the fake runtime, the search-and-read flow passes on both installed runtimes, and the browser covers the flow under Careful. No real model or real site was used, and a stand-in model's Codex search reports no results.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-1272-01]` | Under Balanced, a hob searches, reads two pages from the results and answers with them, asking nothing; each page keeps its text on its own step, and the turn's records hold the search with its two results and the two pages read | ✅ on SQLite and PostgreSQL |
| `[TC-RT-1272-01]` | On Claude Code, `WebSearch` runs Anthropic's `web_search` on the stand-in; the hub's limits are asked first, the two hits are recorded as found before any page is read, both pages are read with `web_fetch`, and the answer names them | ✅ on Claude Code 2.1.321 |
| `[TC-RT-1272-02]` | On Codex, every request of the turn holds search to cached (`external_web_access: false`); the search is recorded before the first page is read, both pages are read with `web_fetch`, and the answer names them | ✅ on Codex 0.166.0 and 0.167.0 |
| `[TC-PE-1267-11]` | Under Careful the first page on a new site asks, Always for the site answers the next, and Never for Use the web closes `web_fetch` | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1272-02]` | Never for Search the web turns the runtime's search off for the next turn while `web_fetch` stays; Never for Use the web as well closes `web_fetch`; nothing is recorded for a closed tool | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1268-03]`, `[TC-PE-1268-05]` | After a page tells the hob to send data out, a URL it built and a `curl` to a new host wait for you, in the same turn and the next | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1272-04]` | A GitHub comment that an Always grant answers waits for you, with the read-the-web reason, once the session searched; nothing is posted until you decide | ✅ on SQLite and PostgreSQL, against a fake GitHub |
| `[TC-GEN-1268-01]` | While the session has read the web, a memory save names the page as its source and a share asks you first | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1268-04]` | A hob that searches, opens two results, edits files and runs tests is asked nothing | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1267-12]` | `localhost`, `127.0.0.1`, `169.254.169.254`, a name that resolves to loopback and a redirect to one are refused before anything is sent; a private address asks | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1272-03]` | A site whose robots.txt disallows Hobbots by name is refused and only its robots.txt is asked for; a site that disallows only `*` is read | ✅ on SQLite and PostgreSQL |
| `[TC-PE-1269-03]`, `[TC-PE-1269-04]` | Searches and pages are counted per turn and per hob, and a hob's limits refuse the search and page past them and turn search off for its next turn | ✅ on SQLite and PostgreSQL |
| `[TC-UX-1272-01]` | Under Careful, the first result page asks with Always for this site, the second reads without a card, the reply shows the search and both pages as sources, Open shows the text the hob got, an address the hob wrote on that site still asks, and Permissions lists the site rule | ✅ in Chromium on SQLite |
| `[TC-UX-1271-01]` | Open on a page shows the text, address and links the hob got | ✅ in Chromium on SQLite |
| `[TC-RT-1266-09]`, `[TC-RT-1266-10]`, `[TC-RT-1266-11]` | Neither runtime loads a web setting from `~/.claude` or `~/.codex`: only the policy offers search, and Claude Code is never offered `WebFetch` | ✅ on Claude Code 2.1.321 and Codex 0.166.0 and 0.167.0 |

## Gaps

- No real model and no real site ran here. The v0.0.4 smoke test ran the search-and-read flow with real models on a packaged Mac build, on Claude Code and Codex, and found that on Codex the first page on a new site under Careful does not ask and Never for Search the web and for Use the web does not hold, reported privately ([#1314](https://github.com/otaviobarros/hobbots/issues/1314), [evidence](2026-11-09-v0-0-4-mac-smoke.md)).
- A stand-in model's Codex search reports no results: Codex gets them from OpenAI's search out of band, so the stand-in cannot hand them over. The smoke test above shows a real Codex search's links read without asking.
- An installed Codex starting its next turn with search off after going over its per-turn limit is shown only by the smoke test above, and two pages read at once passing a one-page limit on Claude Code is [#1335](https://github.com/otaviobarros/hobbots/issues/1335).
