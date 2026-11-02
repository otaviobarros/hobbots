# A party member leads a nested Quest, and a delegation loop is stopped

- **Date:** 2026-11-02
- **Issue:** [#275](https://github.com/otaviobarros/hobbots/issues/275)
- **Pull request:** [#366](https://github.com/otaviobarros/hobbots/pull/366)
- **Commit:** not yet on `main` (ran on the pull request branch at `eddea55`, which merges `main` at `72a6907`)
- **Setup:** Linux x86_64, Node 22.23.4, the fake runtime. Hub cases on SQLite in memory and on PostgreSQL 16.15 (a local server on port 54329, as `pnpm test:pg` uses). Browser cases in Chromium 1243 against a hub from source on its own empty data folder and port, playing the scripted Black Friday Quest (`HOBBOTS_FAKE_QUEST=black-friday`) with hobs named Aldric, Quill, Ada, Rook and Pip.
- **Result:** Passed with gaps. A member brings in a hob of its own and leads that subtree under the checks every hob tool call already passes, a delegation loop is refused as `depth-limit` or `cycle` with nothing written, questions climb from the nearest lead, and Cancel reaches every level with confirmed outcomes; real Claude Code was not run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-OR-160]` | Hub level: Aldric brings in Rook, who brings in Pip. Pip's Task sits under Rook's, the Quests are at depth 1 (Aldric) and 2 (Rook), Pip's brief names only Rook, her result reaches Rook's session and never Aldric's chat, and all three Tasks and both Quests complete. | ✅ SQLite, PostgreSQL |
| `[TC-OR-161]` | Hub level: Pip's call to bring in Quill and her `start_quest` with `max_depth: 3` are refused as `depth-limit`; her calls to give work to Rook or Aldric, and Rook's to Aldric, are refused as `cycle`. Each hob reads the refusal back, and the tree still holds three Tasks. | ✅ SQLite, PostgreSQL |
| `[TC-OR-162]` | Hub level, depth limit raised to 3: Quill at depth 3 is refused as `cycle` for Rook, Pip and Aldric, and as `depth-limit` for one level more. | ✅ SQLite, PostgreSQL |
| `[TC-OR-163]` | Hub level: Pip's question reaches Rook first, Rook passes it to Aldric and Aldric to you (chain `rook`, `aldric`), and your answer goes back to Pip in her own session. | ✅ SQLite, PostgreSQL |
| `[TC-OR-164]` | Hub level: cancelling the Quest while Pip's turn runs confirms all three Tasks and both Quests cancelled, ends Pip's Attempt cancelled, and starts nothing after. | ✅ SQLite, PostgreSQL |
| `[TC-OR-165]` | Hub level: cancelling Rook's Task cancels Pip's under it and leaves Aldric's Quest going; reassigning Rook's Task while it leads Pip is refused as `children-open`, and giving Pip's Task to Aldric as `lineage-owner`. | ✅ SQLite, PostgreSQL |
| `[TC-CH-191]` | Browser: in the Quest tab, Pip's row sits one indent further in than Rook's, which sits further in than Aldric's; Rook's row reads "Leads Pip"; both end Done. | ✅ 3 of 3 runs |
| `[TC-CH-190]`, `[TC-OR-013]`, `[TC-IN-132]` | Browser: the Black Friday Quest without Rook and Pip plays as before in the Quest tab, the chat and the Inbox. | ✅ 3 of 3 runs each |
| Unit | `roomRows`: in a nested tree only the member that leads the nested Quest carries a party. | ✅ |

The same hub suites (`quests`, `task-controls`, `task-tools`) passed 40 of 40 on each database.

## Gaps

- Real Claude Code leading or joining a nested Quest was not run: serving the hob tools to a real Claude Code is not verified yet ([#271](https://github.com/otaviobarros/hobbots/issues/271)).
- The packaged Electron app was not run.
- The Quest tab's controls are still held, so Cancel on a nested Quest was proven at hub level only ([#311](https://github.com/otaviobarros/hobbots/issues/311)).
