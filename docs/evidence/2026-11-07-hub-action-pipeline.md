# Hub tool calls run through one pipeline, and every runtime records their steps

- **Date:** 2026-11-07
- **Issue:** [#617](https://github.com/otaviobarros/hobbots/issues/617)
- **Pull request:** [#1154](https://github.com/otaviobarros/hobbots/pull/1154)
- **Commit:** `e427edf`, then the review's fixes after it, on `claude/project-thread-hm5rq3`, with a clean tree
- **Setup:** Linux x86_64 container, Node 26.13.0, SQLite through `node:sqlite`. The pipeline and GitHub read suites ran with the fake runtime and the real policy engine. The clean-runtime contract suites ran against an installed Claude Code 2.1.319 (`HOBBOTS_CLAUDE_CODE`) and an installed Codex 0.167.0 from npm (`HOBBOTS_CODEX`), each with its stand-in model, so no account or real model was used. CI skips both installed-runtime suites.
- **Result:** Passed: every hub tool call through the pipeline is decided, asked, recorded before it is sent, and redacted; a denied or stopped call ends its step as denied; and Claude Code, Codex and the fake runtime each hand a hub call a step that records it with the turn's `recordToolStart` before the hub runs it, and runs nothing when recording is refused.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-463]` to `[TC-PE-467]` | A fake Charm's read: bad input, plan refusal, no tools, Charm taken away, Allow, Never, Ask approved, denied and unaskable, a missing or failing record, a defect, and requests its owner does not declare | ✅ Each answer as expected; nothing is sent unless recorded; a denied step ends `denied` by the user |
| `[TC-PE-474]` | The Charm is taken away while the user decides; the plan context's shape | ✅ The approved call is refused and its step ends `denied`; the context holds only `access` and the turn's ids |
| `[TC-PE-468]` | A GitHub read under an override of Ask, twice | ✅ Asks each time, not grantable, no grant saved; each step recorded before GitHub is read |
| `[TC-PE-469]` | A fake Charm read whose preset asks, approved Always | ✅ The grant answers the next read of the same site; another site asks |
| `[TC-PE-470]` | Fake runtime: a hub call's step records before the hub runs it | ✅ |
| `[TC-PE-471]` | Installed Claude Code 2.1.319: the same | ✅ |
| `[TC-PE-472]` | Installed Codex 0.167.0: the same | ✅ |
| `[TC-PE-473]` | Codex's App Server protocol, with a fake server: the same | ✅ |

## Gaps

- macOS and the packaged app were not run.
- The installed-runtime cases run only where the binaries are set, so CI does not repeat them.
