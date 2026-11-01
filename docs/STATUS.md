# Status

What Hobbots does today, split into what has been proven end to end and what has not. Each item has the date it last changed and the issue that tracks it. A proven item links its [evidence record](evidence/README.md), which names the commit and setup it ran on.

Hobbots is an early build. Only macOS on Apple silicon has been checked by hand. Linux, Windows and Intel Macs have not.

## What works

Proven end to end, on the setup its record names.

- **2026-10-28 · Database suites run on SQLite and PostgreSQL.** The persistence and server suites run on both databases on every pull request and push to `main`. ([#19](https://github.com/otaviobarros/hobbots/issues/19), [CI workflow](../.github/workflows/ci.yml))
- **2026-10-29 · The background service keeps running after the window closes.** A reply completes after the window closes, a second launch starts no second server, and Quit stops the server. The app registers itself to open at login. ([#49](https://github.com/otaviobarros/hobbots/issues/49), [evidence](evidence/2026-10-29-background-service.md))
- **2026-10-30 · A new installation goes from Welcome to Home.** Setup and the first hob work in a browser against a hub from source, and the hub opens on Home after a restart. A missing or signed-out Claude Code blocks setup and shows its fix. ([#70](https://github.com/otaviobarros/hobbots/issues/70), [evidence](evidence/2026-10-30-first-launch.md))
- **2026-10-31 · Several hobs chat, edit and retire independently.** Hobs on different models reply at once on their own threads. An edit mid-reply reaches only that hob's next reply, in the same thread too, on real Claude Code. A retired hob refuses messages and keeps its threads readable. ([#87](https://github.com/otaviobarros/hobbots/issues/87), [#164](https://github.com/otaviobarros/hobbots/issues/164), [evidence](evidence/2026-10-30-multi-hob.md), [evidence for the fix](evidence/2026-10-31-hob-edits-existing-threads.md))
- **2026-10-31 · Chat survives a crash, time offline and an expired cursor.** A reply cut off by a killed hub keeps its saved text, a page that reconnects replays exactly what it missed, and a page away past retention or after a restored backup loads the thread again. Each message shows once. Checked with the fake runtime, in the browser on SQLite and at hub level on SQLite and PostgreSQL. ([#118](https://github.com/otaviobarros/hobbots/issues/118), [evidence](evidence/2026-10-31-reliable-chat.md))
- **2026-11-01 · Hobs use tools within their folders, under the policy.** Under Balanced a hob edits and runs tests in its folder without asking, a read outside its folders is refused whatever the prompt says, and an Ask action holds its turn until the user allows it once or denies it in chat. Checked with the fake runtime, in the browser on SQLite and at hub level on SQLite and PostgreSQL. ([#8](https://github.com/otaviobarros/hobbots/issues/8), [#137](https://github.com/otaviobarros/hobbots/issues/137), [evidence](evidence/2026-11-01-tools-under-policy.md))
- **2026-11-01 · A hob signs commits with the user's 1Password key, when the user turns it on.** On macOS, a hob with the switch on makes signed commits inside the sandbox, one with it off makes unsigned ones, and only the signing hob reaches 1Password's agent. Linux keeps signing off. ([#234](https://github.com/otaviobarros/hobbots/issues/234), [evidence](evidence/2026-10-31-1password-signing.md))
- **2026-11-01 · Only the user decides approvals and manages grants.** A script, another web page or a hob's tool call cannot decide a request, save or remove a grant, or widen a hob's or the setup's permissions; each attempt is refused and logged. On macOS a real Claude Code hob's `curl` with a forged origin never reaches the hub. Until device tokens exist, an unsandboxed hob is not covered. ([#216](https://github.com/otaviobarros/hobbots/issues/216), [evidence](evidence/2026-11-01-agents-cannot-grant.md))
- **2026-11-01 · Threads are archived, found and restored without losing history.** An archived thread leaves the hob's list, is found in its Archived list and by search, opens read-only and comes back whole on Restore. Archiving is refused while a reply runs or an approval waits, and never interrupts either. Checked with the fake runtime, in the browser on SQLite and at hub level on SQLite and PostgreSQL. ([#252](https://github.com/otaviobarros/hobbots/issues/252), [#257](https://github.com/otaviobarros/hobbots/issues/257), [evidence](evidence/2026-11-01-archive-threads.md))

## Not proven yet

Built, but not proven end to end, or proven only in part.

- **2026-10-29 · Opening at login after a real log-out.** The log-out and log-in steps of the background service were never run on a real Mac. ([#49](https://github.com/otaviobarros/hobbots/issues/49), [evidence](evidence/2026-10-29-background-service.md#gaps))
- **2026-10-29 · The release workflow.** It packages, smoke-tests and drafts a release on a version tag, but no tag has run it yet, so the packaged checks have run only on a maintainer's Mac. ([#34](https://github.com/otaviobarros/hobbots/issues/34))
- **2026-10-29 · Required checks on `main`.** The ruleset is written but not yet required. ([#22](https://github.com/otaviobarros/hobbots/issues/22))
- **2026-10-30 · First launch on the packaged app with a real Claude Code login.** Only the browser flow with the fake runtime is recorded. ([#70](https://github.com/otaviobarros/hobbots/issues/70), [evidence](evidence/2026-10-30-first-launch.md#gaps))
- **2026-11-01 · Tools under policy on real Claude Code.** Claude Code tools run under the policy and the sandbox, and [ADR 014](decisions/014-tool-policy-and-enforcement.md#what-131-verified) records what was checked by hand on macOS before asking existed. The [manual checklist](evidence/checklists/tools-under-policy.md) for the same checks, Ask included, has not been run yet. The Push Charm, which pushes with the hub's credentials and runs no workspace hook, is not built. ([#8](https://github.com/otaviobarros/hobbots/issues/8), [#225](https://github.com/otaviobarros/hobbots/issues/225), [evidence](evidence/2026-11-01-tools-under-policy.md#gaps))

- **2026-11-01 · Switching a thread's brain.** A thread can move to another runtime or model and keep its context through a briefing the hub writes, proven with the fake runtime standing in for Claude Code and Codex. The Codex adapter is not built, so a real hub can only switch Claude Code models. ([#169](https://github.com/otaviobarros/hobbots/issues/169), [#12](https://github.com/otaviobarros/hobbots/issues/12))

Delegation, inboxes, Quests, other runtimes, the Workbench and remote access are not built yet. The [slices](https://github.com/otaviobarros/hobbots/issues?q=label%3A%22type%3A+slice%22) list them in order.

## Keep this page current

- A pull request that closes a "Prove …" issue adds its [evidence record](evidence/README.md) and moves the item here in the same change (STD-DOCS-010).
- A pull request that finds a gap adds it under "Not proven yet", with its issue.
- Each item keeps one line. The detail lives in the evidence record and the issue.
