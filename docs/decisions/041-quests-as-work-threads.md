# ADR 041 — Quests as work threads

Status: **Accepted.** Supersedes [ADR 018](018-tasks-and-quests.md). Amends [ADR 037](037-chat-and-camps.md) (Quests in camps, the claims register and claims beyond the repository) and [ADR 039](039-shared-camps.md) (Asking for a delivery in a shared camp, the collision note). Builds on the reply threads, the floor and who answers of ADR 039, the chapters and context pack of ADR 037, the GitHub Charm of [ADR 020](020-github-charm.md) and the migration names of [ADR 040](040-parallel-pull-requests.md). Records the design for the slice Quests as work threads ([#1472](https://github.com/otaviobarros/hobbots/issues/1472), [#1594](https://github.com/otaviobarros/hobbots/issues/1594)).

## Context

ADR 018 built big work as a tree. A Task had one owner; a Quest was a Task that brought in other hobs; the lead delegated Tasks to its party, planned steps, waited on them, took hand-offs and reported checkpoints. ADR 037 added a claims register so two Tasks would not write the same files, and takeover to settle a clash.

That machinery grew past what the work needs. A lead had nine tools to coordinate its party. Each member worked in a session of its own and only saw what was handed to it. The claims register guarded one shared checkout with sandbox rules on both runtimes, held commits and taken writes. Most of it exists to keep several hobs apart in one place, which a person in Slack never has to think about: they talk in a channel, branch into a thread, ping a colleague, and each piece of work lives on its own branch.

ADR 039 already decided reply threads, the floor that lets one hob speak at a time in a conversation, mentions as the way a hob is called, and the relay budget that stops hob-to-hob loops. With those, a Quest no longer needs a tree to bring other hobs in.

## Decision

### Words

- A **camp** is a channel. In code, `Channel` with the kinds `direct` (the UI's chat) and `camp` ([#1610](https://github.com/otaviobarros/hobbots/issues/1610)).
- A **thread** is a side conversation on one message, as in Slack (ADR 039 › Reply threads). In code, a thread is a conversation with a `rootMessageId`.
- A **Quest** is work being done. It runs in a chat's or camp's main line, or inside a thread. A Quest started in the main line moves into a thread when someone replies to its card or its messages, and the reply reaches it as a steer. A thread can become a Quest. A conversation holds at most one running Quest, so the floor and the worktree never serve two pieces of work at once.

The words Task, step, party, lead, delegation, hand-off and checkpoint go with the code that holds them.

### The record

One record, written with its journal event in one transaction:

| Field | What it is |
| --- | --- |
| channel and thread | The chat or camp, and the thread it runs in, or none while it is in the main line |
| title, goal | What it is for, in one line each |
| "Done when" | Plain lines that say when it ends |
| expected by | An optional date the person or the hob gives |
| owner | The hob that runs it and answers replies that mention no one |
| requester | The actor who asked: decides its approvals and reviews (ADR 039 › Cards every thread shares) |
| workspace | Repository, worktree, branch and base commit, or none |
| state | `active`, `waiting`, `done` or `stopped` |
| started from | The message or chapter it was started from, for the link back |

Its states, kept to four, are held by one `defineMachine` machine:

- **active:** someone is working, or a reply is owed. A reply that wakes the owner moves `waiting` or `done` back here.
- **waiting:** the owner asked the requester something, or needs an approval. The card shows "Needs you".
- **done:** the owner said the "Done when" lines hold, with a short result. The card becomes the review card.
- **stopped:** the requester or the camp's owner pressed Stop. Reopen moves it back to `active`.

There is no queued, blocked, paused or failed state. A failed turn is a turn that failed, shown in the conversation; the Quest stays `active` until someone acts.

Messages, artifacts, usage and approvals are already records that point at their channel and conversation, so the Quest holds none of them.

### Tools

Two hub tools, `start_work` and `finish_work`, replace `start_quest`, `delegate_task`, `plan_steps`, `wait_for`, `hand_off`, `report_checkpoint`, `complete_task`, `claim` and `give_back`. A third, `switch_branch`, goes back to an earlier PR of the same Quest (see Worktrees). All of them are offered on every runtime: Claude Code, Codex and the fake.

- `start_work` takes a title, a goal, "Done when" lines, an optional date and, for code, a repository from the hob's folders. The hub posts the Quest card where the hob is talking.
- `finish_work` takes a short result and what the work made. It moves the Quest to `done` and posts one line to the camp, such as "Aldric finished Winter market page · PR #12". The hub refuses it while the worktree has uncommitted changes, unless the hob says why.
- Stop on the card stays `stop_quest`, for the requester and the camp's owner. Replying is the steer.
- A long piece of work starts a fresh session with `start_chapter` (ADR 037), which is what steps did.

### Who works on it

- Hobs bring each other in by mention. A mention is an ordinary `TurnRequest`: it answers in the open, under the relay budget, and the floor lets one hob write at a time. There is no party, delegation or hand-off.
- A hob picks whom to mention by reading the camp's members with their role and "Good at" line (ADR 032) and the camp's instructions. Nothing is matched by code.
- Any hob in the Quest may mention another. A person's mention wins over the owner's choice.
- Mentioning a hob already in the camp needs no ask. A hob from outside the camp goes through Summoning (ADR 034), which asks the person.
- In a Quest's thread, a reply that mentions no one goes to the owner.
- Work that should run in parallel is a second Quest, linked from the first.

### Starting

A hob may start a Quest on its own or suggest one first. A new permission, **Start a Quest**, decides which, with Always allow, Ask or Never, like the other permissions. When it is Ask, the first ask offers an Always allow button. A person can also start one from any message.

### Worktrees

- The hub owns every worktree; a hob never runs `git worktree` or picks a branch name. A Quest with no repository gets no worktree.
- One worktree and branch per Quest, in the hub's own files. Every turn of the Quest runs there, and it is the only writable folder of that repository for the turn, on both runtimes.
- One name makes both the branch and the folder. The pattern is set per hub in Settings; a Quest may name its own branch. Every name is checked with `git check-ref-format --branch`, and a taken name gets a short suffix.
- The hub removes a worktree once it is clean and its branch is merged, or a number of days after Stop, set in Settings (7 by default). It never removes a dirty worktree or a remote branch.
- **One PR per Quest is the goal.** New work after a PR is opened gets a "Start a new Quest for this?" suggestion. When the person declines, the work stays in the same worktree on a new branch, from the default branch or stacked on the open PR. Exactly one branch is checked out at a time, and the card marks which PR is being worked on. `switch_branch` goes back to an earlier PR once the worktree is clean, and starts a new chapter seeded from that PR's records. A Quest never has parallel worktrees.
- Push and PR go through the GitHub Charm and its approval, unchanged.

### What goes

The Task tree, steps, delegation, the party, `depends_on`, waits, hand-offs, task notes, checkpoints, milestones, the question escalation chain, the claims register with takeover, give back, held commits and taken writes. Claims beyond the repository ([#1413](https://github.com/otaviobarros/hobbots/issues/1413)) are dropped. The supervisor and the camp brief projector stay until their own replacements exist.

What stays: memory and skills, chapters, the context pack, Summoning, the hub's brain, the turn cap, `answerersFor`, `TurnRequest`, the floor, pass, the relay budget, `stop_quest` and `QuestSummary`.

### Migration

- No conversion. Old Quests are not turned into new ones. Until the Task plumbing is removed, both live side by side and old Quests are left alone.
- The migration that removes the plumbing marks any old Quest still running as `stopped`, keeps its messages readable as ordinary history, and drops the old tables. Anything that pointed at them, such as an artifact's or a usage record's origin, becomes null.
- No shims or dual paths: each step replaces the old code outright. An upgrade never stops the app from booting.

### Rollout

In order, each a small pull request, under [#1472](https://github.com/otaviobarros/hobbots/issues/1472):

1. The record, its machine, `start_work` and `finish_work` on every runtime, and the card.
2. The Start a Quest permission; moving a Quest into a thread.
3. New work starts only as Quests; `start_quest` and `delegate_task` leave the tool lists.
4. A worktree and branch per Quest; the claims register, takeover and give back go.
5. One PR per Quest and `switch_branch`.
6. The Task tree, delegation and steps go, with the migration above.

The contracts ([orchestration](../architecture/orchestration.md), the [agent model](../architecture/agent-model.md), [chat and camps](../architecture/chat-and-camps.md)) change with the step that changes their part.

## Rationale

- A mention is how people bring each other into work, and the floor and relay budget already make it safe between hobs. Nine coordination tools gave the model more ways to go wrong than to help.
- A worktree per Quest keeps writes apart the way Git already does, so clashes move to the merge, where Git and the PR show them. The claims register solved the same problem with sandbox rules and takeovers.
- Four states fit what a person needs to see: someone is on it, it needs you, it is done, or it was stopped.
- Keeping the word Quest keeps the product's voice; the record under it is what changes.

## Not chosen

- **Keeping the Task tree under the new record.** It would keep every cost this ADR removes.
- **Several worktrees in one Quest.** Each turn would need to know which one it runs in, the floor would no longer keep writes apart, and the context would mix pieces of work. Parallel work is a second Quest.
- **Structured roles to pick who works on what.** Camp instructions in plain words and "Good at" do the same with nothing to keep in sync.
- **Converting old Quests.** Only one person runs Hobbots today; stopping them keeps the history readable at a fraction of the cost.

## Consequences

- Until step 6 lands, the code holds both the ADR 018 Quest and the new one. The new one is the only one new work uses once step 3 lands.
- Every runtime gains the new tools in the same pull request, and loses the old ones together.
- A hob's work on code is only ever in its own worktree, so the claims register's sandbox rules and their tests go.
- The Quest card, its thread and the review card come from the design source for this slice.
