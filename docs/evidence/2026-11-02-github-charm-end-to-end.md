# Hobs work with GitHub through the Charm, end to end against a fake GitHub

- **Date:** 2026-11-02
- **Issue:** [#325](https://github.com/otaviobarros/hobbots/issues/325)
- **Pull request:** to be opened from `claude/project-thread-ohjncx`
- **Commit:** not yet on `main` (ran on the pull request branch, based on `cf040ae`)
- **Setup:** Automated only. The hub's own composition over the HTTP API, with the fake runtime making the scripted GitHub Charm calls, and a fake GitHub on a local port (`@hobbots/charms/testing`) serving the device flow, the REST API the Charm calls and Git over HTTP through `git http-backend`. The hub's real sign-in, API client and push code talk to it; only their addresses change. The keychain is the in-memory one, and the hob's sandbox is a stand-in that runs Git's `upload-pack` as it is and records the environment it gets. Linux x86_64, Node 22.23.4, Git 2.43, on SQLite in memory and on PostgreSQL 16; CI runs the suite on SQLite and PostgreSQL 18.
- **Result:** Passed with gaps. A hob connected through the device flow reads its repository's counts, pushes after an approval, force pushes once only, opens a draft pull request and comments; a repository outside its folders, or one the app is not installed on, is refused before anything is asked or sent; and no token GitHub issued appears in the sandbox's environment, any file on the hub, the database or anything the API answers. Real GitHub and real Claude Code were not part of this run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-240]` | Before GitHub is connected, the hob is offered no GitHub action and nothing reaches GitHub. Connecting starts the device flow, polls until the code is entered, and Settings then shows the account and the repositories the app is installed on. The next turn reads the repository. | ✅ |
| `[TC-PE-241]` | Without asking, the hob reads the repository's open count and counts issues and pull requests by state and label; every search the hub sent is pinned to the hob's repository. | ✅ |
| `[TC-PE-242]` | Under Balanced, a push asks with the commit, its count, its subject and the acting account, sends nothing before the approval, and puts exactly that commit on the GitHub branch after it. | ✅ |
| `[TC-PE-243]` | A push that does not build on GitHub's branch is refused by GitHub and changes nothing. A force push asks once only: Always and an unconfirmed approval are refused, the confirmed one replaces the branch and saves no rule, and the next force push asks again. | ✅ |
| `[TC-PE-244]` | Opening a pull request from the pushed branch asks with its head, base, draft flag and title, and after the approval GitHub has a draft pull request with that title and body, opened by the connected account. | ✅ |
| `[TC-PE-245]` | Commenting on an issue asks, and after the approval the comment is on GitHub by the connected account with the hub's hidden marker; reading the issue back shows the comment without the marker. | ✅ |
| `[TC-PE-246]` | Reading, pushing, opening a pull request and commenting from a folder outside the hob's are each refused as not one of its folders; reading and pushing from one of its folders whose repository the app is not installed on are refused as not installed. Nothing is asked, and GitHub receives no request for either repository. | ✅ |
| `[TC-PE-247]` | Every signed request GitHub received used a token GitHub issued to the hub. No access or refresh token appears in the environment of a process the Charm started in the hob's sandbox, in any file under the test's folders (the hob's folders, its runtime folder, tool logs and the Charm's staging repositories), in any row of any table, or in any API answer, replies, steps and approval cards included. | ✅ |
| `[TC-PE-150]` to `[TC-PE-159]` | Existing Charm cases, now on the shared fake GitHub's Git server instead of their own: pushes from the hub's staging repository, the hostile folder configuration, the sandboxed source side, once-only pushes and pushing over SSH. | ✅ |

## Gaps

- No real GitHub: the Hobbots GitHub App is not registered yet, so the device flow, the installations and the permissions above are GitHub's documented behaviour as the fake serves it ([#322](https://github.com/otaviobarros/hobbots/issues/322)).
- Only the fake runtime ran. A real Claude Code turn calling the Charm is not verified ([#8](https://github.com/otaviobarros/hobbots/issues/8)).
- The hob's sandbox was a stand-in that records the environment; the real sandbox around the push's source side is proven in `[TC-PE-152]`, on hubs where it starts.
- The keychain was the in-memory one, so this run says nothing about the macOS Keychain or the Secret Service.
- The fake runtime ends a refused hub call's step as done, while Claude Code is told the call failed, so these cases check a refusal by its text rather than by its step.
