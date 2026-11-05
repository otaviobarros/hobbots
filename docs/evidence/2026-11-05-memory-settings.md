# The memory model is chosen in Settings and written into ai-memory's provider settings

- **Date:** 2026-11-05
- **Issue:** [#962](https://github.com/otaviobarros/hobbots/issues/962)
- **Pull request:** this change's pull request
- **Commit:** the pull request's head; not yet on `main`
- **Setup:** Linux x86_64 container (Node 26.13.0) with ai-memory 3.4.2 for `linux-x64`, fetched by `pnpm --filter @hobbots/memory fetch-engine`. Run with `pnpm --filter @hobbots/memory test`, `pnpm --filter @hobbots/server test`, `pnpm --filter @hobbots/web test`, `pnpm --filter @hobbots/desktop test` and the browser test `memory-settings.e2e.ts`.
- **Result:** Passed with gaps. The choice is stored in the data folder, written into ai-memory's provider settings, and a change restarts only the engine. ai-memory 3.4.2 starts with every config Hobbots writes. No provider credential reaches the engine yet, so memory runs with no AI whatever model you choose, and Settings says so ([#972](https://github.com/otaviobarros/hobbots/issues/972)).

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-GEN-212]` | The default writes the provider, model and effort, sums up chats with the model, and keeps ai-memory's own learning scheduler off | ✅ |
| `[TC-GEN-213]` | No AI writes no model setting at all, whatever else was chosen | ✅ |
| `[TC-GEN-214]` | The fallback is the other provider's small model, naming its key variable for Anthropic; plain summaries write none | ✅ |
| `[TC-GEN-215]` | A task given the stronger model gets its own table with the fallbacks; summaries with no AI turn off `consolidate_on_session_end` | ✅ |
| `[TC-GEN-216]` | A provider without a credential is left out: the engine runs with no AI, and a fallback without one is dropped | ✅ |
| `[TC-GEN-217]` | ai-memory 3.4.2 starts with the chosen model, effort and per-task models, and its status reads back as pages and use | ✅ (with a placeholder Anthropic key; no call is made) |
| `[TC-GEN-218]` | ai-memory 3.4.2 starts with no model under No AI | ✅ |
| `[TC-GEN-219]` | The hub answers the default choice, the engine's state, its pages, its folder's size and its use, with no address or key | ✅ |
| `[TC-GEN-220]` | A changed model is stored in `memory-settings.json` and the engine is reconfigured | ✅ |
| `[TC-GEN-221]` | A model its provider does not offer is refused; a damaged file reads as the default | ✅ |
| `[TC-GEN-210]`, `[TC-GEN-211]` | Show the files opens only the memory pages folder, never one the page names, and nothing before memory has pages | ✅ |
| `[TC-GEN-223]` | The memory folder's size is measured off the request path, through every subfolder, and requests that come together share one measurement | ✅ |
| `[TC-GEN-224]` | In a browser: a choice the hub refuses stays shown with Try again, which sends it again, and Keep the one before, which goes back | ✅ |
| `[TC-GEN-225]` | In a browser: Show the files says when the folder could not open, and Try again opens it | ✅ |
| `[TC-GEN-222]` | In a browser: the model is chosen in Your data and kept after a reload, Safety shows shares following the preset with About you always asking, and Usage shows memory's line | ✅ |

## Findings

- ai-memory refuses to start when a configured provider, a fallback or a task model has no credential, so the hub writes only providers it can hand a key. Today that is none.
- A Claude subscription's sign-in (`anthropic-oauth`) is refused by Anthropic for other apps, so Claude needs an Anthropic API key.
- ai-memory's `codex` provider needs a Codex `auth.json` file, which Hobbots does not keep (ADR 024).
- A fallback for a provider that takes a key must name the variable with `api_key_env`.
- ai-memory turns on its learning scheduler whenever a model is configured; Hobbots turns it off (`[auto_improve.scheduler] enabled = false`), since that is the Curator's work, later.

## Gaps

- No real model call is made: a provider credential cannot reach the engine yet, so the issue's "the next summary uses the selected provider" is not met here and is deferred to [#972](https://github.com/otaviobarros/hobbots/issues/972).
- The design's Lessons from repeated work and Overnight tidy tasks, and its Wait and try later fallback, are not offered: the first two are the Curator's, and ai-memory has no setting that waits.
- `memory-settings.json` is not yet in a backup; the memory backup is [#963](https://github.com/otaviobarros/hobbots/issues/963).
- Not run on macOS or in the packaged app.
