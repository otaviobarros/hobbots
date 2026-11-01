# Evidence records

Each end-to-end proof leaves one dated record here. A record says what ran, on which commit and setup, and what happened, so anyone can tell later what was proven and what was not. The [status page](../STATUS.md) links every record.

## When to write one

Write a record in the pull request that closes a "Prove …" issue, or that runs a manual check worth keeping, such as a run on the packaged app with real Claude Code. Write it in the same pull request as the tests it describes (STD-DOCS-010).

A record is a snapshot. Never edit its result after it merges. A later run gets a new record, and the status page links the newest one.

## File name and fields

Name the file `YYYY-MM-DD-<short-name>.md`, dated on the day the checks ran. Start it with these fields, in this order. `pnpm check` fails when one is missing.

```md
# <What was proven>

- **Date:** 2026-10-29
- **Issue:** [#49](https://github.com/otaviobarros/hobbots/issues/49)
- **Pull request:** [#72](https://github.com/otaviobarros/hobbots/pull/72)
- **Commit:** `aeb8ad3` on `main`
- **Setup:** the machine, OS, architecture, build, runtime and versions.
- **Result:** Passed, Passed with gaps, or Failed, and one sentence on why.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-EX-008]` | What was checked | ✅ or ❌ and what happened |

## Gaps

What this run did not prove, each with the issue that tracks it.
```

- **Commit** is the commit on `main` that holds the tested code. When the run happened on the pull request branch, name that commit too.
- **Setup** names every version that the result depends on, such as Claude Code, macOS and the architecture.
- **Checks** cites test case IDs (STD-TEST-001) for automated checks. A manual step has no ID.
- **Gaps** lists what is left, so the status page can show it under "Not proven yet".

## Manual checklists

A check that needs a real runtime, a packaged app or a real Mac, and that will be run again, keeps its steps in [`checklists/`](checklists/). Each run of a checklist leaves a new record that cites its step numbers in `Manual` rows.

- [Tools under policy on real Claude Code](checklists/tools-under-policy.md)

## Records

- [2026-10-29 The background service](2026-10-29-background-service.md)
- [2026-10-30 First launch](2026-10-30-first-launch.md)
- [2026-10-30 Three hobs chat, edit and retire independently](2026-10-30-multi-hob.md)
- [2026-10-31 Hob edits reach existing threads](2026-10-31-hob-edits-existing-threads.md)
- [2026-10-31 Reliable chat survives a crash, time offline, an expired cursor and a restored backup](2026-10-31-reliable-chat.md)
- [2026-11-01 Hobs use tools within their folders, under the policy](2026-11-01-tools-under-policy.md)
- [2026-11-01 Approvals hold end to end: rules, doubled clicks, expiry and the Inbox](2026-11-01-approvals-end-to-end.md)
- [2026-11-01 Threads are archived, found, read and restored without losing history](2026-11-01-archive-threads.md)
