# Hobs manage hobs end to end: hand-off, proposals, caps and retire

- **Date:** 2026-11-09
- **Issue:** [#412](https://github.com/otaviobarros/hobbots/issues/412)
- **Pull request:** [#1312](https://github.com/otaviobarros/hobbots/pull/1312)
- **Commit:** the head of `claude/project-thread-yzng2d` that lands this record, after `8385e2b`.
- **Setup:** the cloud Linux container (x86_64), Node 22.23.4, the fake runtime, SQLite and PostgreSQL 16, and Chromium for the browser test. `[TC-AG-412-07]` and `[TC-AG-406-10]` also ran against an installed Claude Code 2.1.319 and Codex 0.167.0 with their stand-in models and no account.
- **Result:** Passed with gaps: every scenario of #412 passes at hub level with the fake runtime; the browser case covers allowing a summon, opening each created hob and who summoned it; the installed runtimes cover check, summon, change, pause and wake. No real model was run.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-AG-412-08]` | A roster that lists a hob with the Summoning Charm tells the reader to hand summoning work to it, and to ask who should be responsible when several hold it | ✅ |
| `[TC-AG-412-01]` | A hob without the Charm hands the summon to the hob that holds it with a Task; that hob summons on the Task, and changes the hob it made there | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-02]` | When two hobs hold the Charm, the hob asks you who should be responsible; you pick Bram and Bram summons | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-03]` | On a Task, a manager checks three drafts, asks its lead about the unclear one, and summons the three from one card after you edit one; each is shown as summoned by it, with the hob each row made | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-04]` | A summon retried after its call moved into the Task its reply started returns the same hob, and the same key from another manager summons its own | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-09]` | Reading a change call back after the hub stopped part way finds only the versions that call made, never another Task's call with the same key | ✅ on SQLite and PostgreSQL |
| `[TC-AG-409-03]` | Always allow lets the next summons run without a card until the manager's cap, where the next one asks | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-05]` | Retire asks once only, with the check box and no Always allow; a running reply finishes under `finish` and stops under `stop` | ✅ on SQLite and PostgreSQL |
| `[TC-AG-412-07]` | Each runtime checks, summons, changes, pauses and wakes hobs through the Charm, each call recorded before it acts | ✅ on the fake runtime, Claude Code 2.1.319 and Codex 0.167.0 |
| `[TC-PE-501]`, `[TC-PE-502]` | A Charm offers its writes outside chats only when each write reads back, so a Task session gets the Summoning writes | ✅ |
| `[TC-UX-412-01]` | Once you allow a summon in the chat's Needs-you tray by keyboard, each hob it made opens from its card on the call's step and its profile says who summoned it; the tray, the decided card and each profile pass the accessibility scan | ✅ in Chromium on SQLite |

## Gaps

- No real model was run. Whether real Claude Code and Codex models hand summoning work over, ask who should be responsible, and use the Summoning tools well is tracked in [#1314](https://github.com/otaviobarros/hobbots/issues/1314), with the steps in the [hob management checklist](checklists/hob-management.md).
- The Charms tab does not show the live counts against the caps yet ([#410](https://github.com/otaviobarros/hobbots/issues/410)).
- The packaged Mac app was not run.
