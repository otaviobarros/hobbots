# Codex's install, version, sign-in and models show in provider health

- **Date:** 2026-11-03
- **Issue:** [#437](https://github.com/otaviobarros/hobbots/issues/437)
- **Pull request:** [#557](https://github.com/otaviobarros/hobbots/pull/557)
- **Commit:** `79076e7` on the pull request branch
- **Setup:** Linux x86_64 container (Ubuntu 24.04, Node 22), hub from source. Automated checks use a stand-in Codex that speaks the App Server's JSON-RPC. The manual check used Codex 0.166.0 (`@openai/codex` from npm) with no account and a throwaway `CODEX_HOME`. No macOS, no ChatGPT sign-in.
- **Result:** Passed with gaps. Every state shows with its fix, and the adapter reads the real Codex's version, sign-in and models. Until Codex turns run ([#438](https://github.com/otaviobarros/hobbots/issues/438)), a ChatGPT sign-in shows as unverified and Codex offers no model, so no hob or thread can pick a brain that cannot answer. A signed-in Codex and macOS are not verified.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-RT-001]` | A ChatGPT sign-in is unverified until turns run, read with `account/read` and `refreshToken: false`, and no `getAuthStatus` | ✅ |
| `[TC-RT-002]` | No sign-in is signed out | ✅ |
| `[TC-RT-003]` | An API-key sign-in is signed out, with billing `api-key` | ✅ |
| `[TC-RT-004]` | Codex 0.165.9 is outdated and never started | ✅ |
| `[TC-RT-005]` | A missing Codex, and one that prints no version, are unavailable without a version | ✅ |
| `[TC-RT-006]` | A Codex that never answers is unavailable with its version | ✅ |
| `[TC-RT-007]` | Until turns run, Codex enforces nothing and refuses a turn | ✅ |
| `[TC-RT-008]` | Every `model/list` page is read, without hidden models or `ultra` | ✅ |
| `[TC-RT-009]` | An outdated Codex offers no models | ✅ |
| `[TC-RT-016]` | A signed-in Codex offers no models, and never asks `model/list`, until turns run | ✅ |
| `[TC-RT-010]` | A turn's sign-in gets the access token and the workspace from the hub's App Server | ✅ with the stand-in |
| `[TC-RT-011]` | A turn's sign-in is refused without ChatGPT | ✅ |
| `[TC-RT-012]` | Settings › AI providers shows not installed, outdated, signed out, API key and signed-in Codex, each with its fix or why it cannot think yet, without a restart | ✅ in Chromium |
| `[TC-RT-013]` | The App Server client answers Codex's requests by method and refuses unknown ones | ✅ |
| `[TC-RT-014]` | Waiting requests fail and notifications end when Codex exits | ✅ |
| `[TC-RT-015]` | Starting a binary that cannot run fails | ✅ |
| `[TC-RT-017]` | A binary configured by bare name is asked its version again after an update | ✅ |
| `[TC-CH-202]` | The hub refuses a brain on a runtime that offers no models | ✅ |
| Manual | The adapter against Codex 0.166.0, signed out | ✅ `signedOut`, version 0.166.0, nine models, none with `ultra` |

## Gaps

- `account/read` while signed in with ChatGPT, and `workspaceRouting.chatgptAccountId` as the workspace for `chatgptAuthTokens`: [#437](https://github.com/otaviobarros/hobbots/issues/437), with a real account.
- macOS, and choosing Codex in onboarding, Summon and the profile: [#441](https://github.com/otaviobarros/hobbots/issues/441).
