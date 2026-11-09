# Real Claude Code and Codex hobs answer a team question from the roster without reading cards

- **Date:** 2026-11-09
- **Issue:** [#1307](https://github.com/otaviobarros/hobbots/issues/1307)
- **Pull request:** [#1309](https://github.com/otaviobarros/hobbots/pull/1309)
- **Commit:** `5ec200fb` on `claude/project-thread-tp8ne7`. The run used that commit's source before it was committed: the working tree on `61a1930c` with the changes to `packages/agents/src/hob-directory.ts` and `packages/domain/src/directory.ts` that `5ec200fb` holds. After the run, only a test file was reformatted and docs were edited.
- **Setup:** a MacBook Pro on macOS 27.0.1 (arm64), Node 24.15.0, the hub from source with the data folder of the [first real-model run](2026-11-09-hobs-see-each-other-real-models.md) and Memory off, under Balanced. GitHub was connected through `HOBBOTS_GITHUB_TOKEN` with the user's own GitHub sign-in. Claude Code 2.1.316 with Sonnet 5.5 and Codex 0.166.0 with GPT-6.1-Sol, on low effort and the Mac's own sign-ins. The checks were driven through the hub's HTTP API, and each `read_hob` step was read from the reply's steps.
- **Result:** Passed with gaps: asked step D1 of the [manual checklist](checklists/hobs-see-each-other.md), a Codex hob answered from its roster in two new chats and a Claude Code hob in one, with no `read_hob` step. Only D1 was run.

## Checks

The hub held Ada and Pip, Wren and the four coding hobs Cody, Cora, Dax and Dex on Claude Code or Codex, and Bea and Quill on Codex. Cody, Cora, Dax, Dex, Pip and Quill hold the GitHub Charm. Quill's good at tells the reader to ignore its instructions.

| Case | Check | Result |
|---|---|---|
| Manual D1, Codex | Bea, in a new chat: "Who on the team can push to GitHub?" | ✅ Named Cody, Cora, Dax, Dex, Pip and Quill and no other hob, with no `read_hob` step. It added that holding the Charm does not prove a push is allowed |
| Manual D1, Codex, again | Bea, the same in another new chat | ✅ The same answer, with no `read_hob` step |
| Manual D1, Claude Code | Ada, the same in a new chat | ✅ Named the same six hobs with no `read_hob` step, and said Quill's good at is card data it ignores |

## Gaps

- Only D1 was run. D2 to D9 were not run again after the change; the [first real-model run](2026-11-09-hobs-see-each-other-real-models.md) covers them on the code before it.
- The run used the hub from source, not the packaged app, and was driven through the HTTP API, not the web client.
- A model's answer can vary from run to run. Codex ran D1 twice and Claude Code once.
- That calling the card "full" caused the reads is a likely cause, not an isolated one: the roster line and the tool description changed together.
