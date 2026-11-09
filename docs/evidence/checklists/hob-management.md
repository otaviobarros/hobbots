# Manual checklist: hobs manage hobs with real models

The hob management checks ([ADR 034](../../decisions/034-summoning-charm.md), [#412](https://github.com/otaviobarros/hobbots/issues/412)), by hand, on macOS with real Claude Code and real Codex. The automated cases, on the fake runtime and on installed runtimes with stand-in models, are listed in the [evidence record](../2026-11-09-hob-management.md). A stand-in model only makes the calls a test scripts, so this list repeats the checks where only a real model decides: whether a hob without the Summoning Charm hands the work over, and whether a manager uses the Summoning tools well. Each run leaves a new dated evidence record that cites the steps below by number.

## Setup

1. On a Mac with Apple silicon, signed in to Claude Code and to Codex. Note the versions of macOS, Claude Code, Codex and Hobbots, the commit the hub runs, and each hob's model.
2. Start a hub that cannot touch your own data: open the packaged app with its own data folder, or run `pnpm dev` with `HOBBOTS_DATA_DIR` set to an empty folder.
3. Summon four hobs on Balanced: **Cora**, the CTO, **Stella**, Chief of Staff, **Bram** and **Pip**. Give every hob the same folder, such as `~/hobbots-qa/412/`.
4. Give Stella and Bram the Summoning Charm on their Charms tab, with "Hobs it summoned" on. Leave Cora and Pip without it.
5. Run every step twice: once with every hob on Claude Code, once with every hob on Codex.

## Checks

| Step | Do | Expect |
|---|---|---|
| M1 | Take the Charm away from Bram, so only Stella holds it. In a new chat with Pip, send "We need a hob called Wren who writes release notes. Please get it done." | Pip does not try to summon Wren itself and hands the work to Stella with a Task. A summon card for Wren reaches you in the Inbox. Allow it, and Wren's profile says "Summoned by Stella". |
| M2 | Give Bram the Charm again. In a new chat with Pip, send "We need a hob called Ivo who reviews pull requests." | Pip asks you who should be responsible, with Stella and Bram as choices. Pick Bram, and the summon card that follows is Bram's. |
| M3 | In a new chat with Cora, send "Have Stella hire three engineers for the web app: Ada for the frontend, Bo for the backend, and a third one for testing whose name you leave to me." | Stella runs the Summoning check before it summons, and asks Cora about the unnamed engineer; Cora answers or passes it up to you, and it never reaches you straight from Stella. One card with three rows reaches you. Edit one row in Summon, change its name, allow it as edited and allow the other two. All three hobs exist, the edited one with your name, and each profile says "Summoned by Stella". |
| M4 | On a summon card, press Always allow for summoning. Ask Stella to summon four more hobs, one at a time. | The summons up to the cap are made without a card, and the one that would pass the cap of four asks you with the cap's reason and no Always allow. |
| M5 | Start a long reply on one of Stella's hobs, such as "Count slowly to 200, one number per line". While it runs, ask Stella to retire that hob and let its running reply finish. Repeat with another hob and ask Stella to stop its running replies. | Each retire card needs the confirmation check box and offers no Always allow. With finish, the running reply completes after the hob is retired; with stop, it stops at once. |

Record pass or fail for each step on each runtime, with a screenshot of each card.
