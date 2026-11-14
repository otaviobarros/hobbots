# Quests run on their own, end to end, at hub level

- **Date:** 2026-11-14
- **Issue:** [#1353](https://github.com/otaviobarros/hobbots/issues/1353), slice [#1342](https://github.com/otaviobarros/hobbots/issues/1342)
- **Pull request:** [#1550](https://github.com/otaviobarros/hobbots/pull/1550)
- **Commit:** the pull request branch `claude/project-thread-r8sj6h`, after `dd867a0` on `main`
- **Setup:** a Linux x86_64 cloud container, from a source checkout, Node 22.23.4. The fake runtime playing every hob, as Claude Code and as Codex. A fake GitHub on a local port, serving the REST API, Git over HTTP and a GitHub App made by hand and linked to the reviewer. SQLite, and PostgreSQL 16.
- **Result:** Passed with gaps: the slice's whole scenario ran at hub level on both databases, on the fake Claude Code and the fake Codex, with one approval card and your stop as the only things that reached you. The manual checklist on the packaged Mac app with real Claude Code and real Codex has not been run yet.

## Checks

The scenario, at hub level:

| Case | Check | Result |
|---|---|---|
| `[TC-OR-1353-01]` | `npx vitest run test/quests-run-on-their-own.test.ts` in `apps/server`, on SQLite and with `HOBBOTS_TEST_DB=postgres`: Aldric delegates "review pull request #2 and post the review as a comment" to Rook, who holds the GitHub Charm with his own GitHub App, Comment on Ask and Edit files on Never | ✅ fake Claude Code and fake Codex, on both databases: the delegation listed Rook's tools and answers (`github_comment` Ask, read-only commands, no file edits) and his session was offered exactly those; `git diff` and `npm test` ran with no card, marked sandboxed, and nothing was refused; Aldric's `message_task` reached Rook's running turn as a steer, picked up by the same Attempt after his first call and before his comment's card; one approval card, then the comment on GitHub once, by `rook-the-reviewer[bot]`; your stop ended the Quest stopped, its Task and Rook's cancelled, nothing completed; one card in all, no question, no refusal, and your two messages |

The checks the slice's ADRs name in their Validation sections, each merged with the task that built it:

| Case | Check | Result |
|---|---|---|
| `[TC-PE-1343-01]`, `[TC-PE-1343-02]`, `[TC-OR-1343-01]` to `[TC-OR-1343-04]`, `[TC-IN-1343-01]` | ADR 038: a member is offered the GitHub Charm's writes in its Task session, comments after one card, pushes and opens a pull request, on the fake runtime and installed Claude Code and Codex; uncertain writes wait on the Task and are settled once | ✅ on `main` |
| `[TC-PE-430]`, `[TC-PE-019]`, `[TC-OR-1423]` | ADR 014, read-only commands (#1344): Edit files Never gives a member read-only commands in a sandbox closed to writes | ✅ on `main` |
| `[TC-OR-1345-01]` to `[TC-OR-1345-04]`, `[TC-RT-1345-01]`, `[TC-IN-1345-01]` to `[TC-IN-1345-04]` | ADR 019 (#1345): a lead's message reaches a running member's turn between two tool calls, or interrupts it | ✅ on `main` |
| `[TC-OR-1346-01]` to `[TC-OR-1346-05]`, `[TC-UX-1346-06]`, `[TC-UX-1346-07]` | ADR 018 (#1346): a lead stops its Quest only at your request, as stopped, never completed, on Claude Code and Codex | ✅ on `main` |
| `[TC-PE-1347-01]` to `[TC-PE-1347-05]` | ADR 034 (#1347): a change to a member's answers reaches its next turn, and a running turn keeps what it started with | ✅ on `main` |
| `[TC-PE-1348-01]`, `[TC-PE-1348-02]`, `[TC-OR-1348-01]` to `[TC-OR-1348-05]` | ADR 014 (#1348): a delegation lists the member's tools and answers before it starts | ✅ on `main` |
| `[TC-RT-1349-01]`, `[TC-PE-1349-01]`, `[TC-PE-1349-02]`, `[TC-OR-1349-01]` | ADR 020 (#1349): a `gh` command is refused with a pointer to the Charm, on every runtime | ✅ on `main` |
| `[TC-PE-1350-01]` to `[TC-PE-1350-03]`, `[TC-PE-1350-07]`, `[TC-IN-1350-04]` to `[TC-IN-1350-06]`, `[TC-GEN-1350-01]` | ADR 020 (#1350): a hob opens an issue and a sub-issue after one approval each | ✅ on `main` |
| `[TC-AG-1351-01]` to `[TC-AG-1351-04]`, `[TC-UX-1351-01]` | ADR 034 (#1351): a hob's operation answers show on its card and in `read_hob` | ✅ on `main` |
| `[TC-AG-1352-01]` to `[TC-AG-1352-05]`, `[TC-UX-1352-01]` to `[TC-UX-1352-03]` | ADR 034 (#1352): a Summoning change keeps the answers it does not set, and dropped ones can be restored | ✅ on `main` |
| `[TC-PE-1356-01]` to `[TC-PE-1356-23]`, `[TC-OR-1356-01]` to `[TC-OR-1356-03]` | ADR 014 (#1356): a call to a tool the session was not offered is a refusal, on every runtime | ✅ on `main` |
| `[TC-PE-1357-01]`, `[TC-PE-1357-02]`, `[TC-OP-1357-01]` to `[TC-OP-1357-03]`, `[TC-AG-1357-01]` | ADR 034 (#1357): settings that change what hobs may do keep a history | ✅ on `main` |

## Gaps

- The [manual checklist](checklists/quests-run-on-their-own.md) on the packaged Mac app with real Claude Code and real Codex, against a test repository on GitHub, is not run yet. It needs a signed-in Mac, so it stays open under [#1353](https://github.com/otaviobarros/hobbots/issues/1353) and its run gets its own record.
- The hub-level scenario plays every hob on the fake runtime. Installed Claude Code and Codex answered by stand-in models are covered piece by piece (`[TC-OR-1343-01]`, `[TC-RT-1345-01]`, `[TC-PE-1356-01]`, `[TC-PE-1356-02]`), not in one run.
- The fake runtime takes a steered message before its next hub call and follows its script, so the scenario proves the note reached the turn before the comment, not that a model changed its review because of it. R4 of the checklist covers that.
- The hob's sandbox does not start in CI; the GitHub Charm's own fence is proven against the real sandbox in `[TC-PE-152]`.
