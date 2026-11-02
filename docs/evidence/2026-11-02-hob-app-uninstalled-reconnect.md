# A hob's uninstalled GitHub app is marked for reinstalling on its Charms tab

- **Date:** 2026-11-02
- **Issue:** [#419](https://github.com/otaviobarros/hobbots/issues/419)
- **Pull request:** [#423](https://github.com/otaviobarros/hobbots/pull/423)
- **Commit:** not yet on `main` (ran on the pull request branch, based on `af93ddf`)
- **Setup:** Automated only. The end-to-end case runs the hub as `main.ts` composes it, over its HTTP API, with the fake runtime and the fake GitHub on a local port (`@hobbots/charms/testing`), as the [#228 record](2026-11-02-hob-github-identity-end-to-end.md) describes. The other cases run the hob's app service against the same fake GitHub. The keychain is the in-memory one. Linux x86_64, Node 22.23.4, Git 2.43, on SQLite in memory. CI runs the suites on SQLite and PostgreSQL.
- **Result:** Passed. An app uninstalled on GitHub fails the hob's next action with where to install it again, is marked for reinstalling on the Charms tab, and reaches GitHub no more until it is reinstalled and listed again. An app still installed elsewhere is not marked. Real GitHub was not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-115]` | With Frodo's app uninstalled on GitHub, the hob's next read is refused with "frodo-hobbots[bot] is not installed on otaviobarros/shire" and the link to install it. The hub made one request with the cached token, one attempt to mint a new one and one look at where the app is installed, then stopped, and nothing went as the user. The Charms tab shows the app as needing a reconnect for its installation, and the hob's next read sends nothing to GitHub. Once reinstalled and listed again, the mark is gone and the hob reads as its bot. Before the fix this case failed: the tab still showed no reconnect. | ✅ |
| `[TC-GEN-155]` | An app the Charms tab showed installed, uninstalled before any call: GitHub finds no installation for the repository and lists none anywhere. The comment is not sent, the app is marked for reinstalling, the next token is refused without a request to GitHub, and listing the installations after a reinstall clears the mark. | ✅ |
| `[TC-GEN-156]` | An app installed twice loses the installation the hub had a token for. The read there is refused as not installed on that repository, the app is not marked, and a token for the repository its other installation reaches is still minted. | ✅ |

## Gaps

- No real GitHub. That GitHub answers `404` when minting a token for a removed installation, and lists no installation once the app is uninstalled, is its documented behaviour as the fake serves it ([#420](https://github.com/otaviobarros/hobbots/issues/420)).
- The hub remembers that it saw the app installed only while it runs. After a restart, an app uninstalled meanwhile fails with where to install it again but is not marked until the hub has seen it installed once more; the Charms tab then lists no installation.
