# ADR 038 — Charm writes in Task sessions

Status: **Accepted.** Amends the uncertain writes of [ADR 020](020-github-charm.md) (a write a Task session made is settled from the Quest room or the Inbox, not from a reply step), the never-twice runner of [ADR 031](031-charm-actions-and-registry.md) (a write without a reply step waits on its Task), and the `writesOutsideChats` rule of [ADR 034](034-summoning-charm.md) (a Charm whose writes read back from an outside service may offer them outside chats too). Builds on the delegated authority of [ADR 015](015-approval-lifetimes-and-grants.md) and the Quest room of [ADR 027](027-quest-room.md). Records the design for [#1343](https://github.com/otaviobarros/hobbots/issues/1343), part of [#1342](https://github.com/otaviobarros/hobbots/issues/1342).

## Context

A party member that holds the GitHub Charm can read GitHub in its Task's session, but it cannot push, open a pull request or comment. Its lead has to do those in chat, so work that belongs to the member comes back up to the lead.

The reason is how an uncertain write is settled. When GitHub's answer to a write is lost, the hub reads GitHub back. If it still cannot tell, the call stays uncertain and you settle it from the reply step it showed as (ADR 020). A Task session has no reply and no step, so ADR 034 kept Charm writes out of Task sessions. Only a Charm whose every write reads back from the hub's own records could declare `writesOutsideChats`, and only the Summoning Charm did.

The rest is already in place:

- The never-twice runner records every write before it sends, keyed within its scope. A Task session's scope is `task:<Task id>`, and each sending has its own `attempt` (ADR 031).
- A member's authority is its own policy narrowed by every Delegation above it, so a write the member may not make answers Never.
- The tools a turn is offered, and the `git push` steering to `github_push`, come from one registry for chat and Task sessions alike (ADR 031).

## Decision

### Offer

- **The GitHub Charm offers its writes outside chats.** It declares `writesOutsideChats`, so a member's session and a step's session are offered `github_push`, `github_open_pull_request` and `github_comment` beside the reads. This works on every runtime, because the offer and the steering come from the hub.
- **Never is not offered.** Outside chats, a write whose operation the session's authority answers Never is left out of the offer. The steering that would lead to it is left out too. A call to it anyway is refused on the Task as an unknown tool and never reaches GitHub. Chat turns are unchanged: a write under Never there is still offered and refused when called, as before.
- **Ask asks, Allow runs.** A write on Ask shows one approval card in the lead's thread, as a member's other requests do, and runs once after Allow. Each write is sent once for its key.
- **The push takeover stays.** A `git push` from the member's folder goes to `github_push`, as it does in chat.

### Uncertain writes

- **Read back as before.** A write whose answer is lost is read back at once, then in the background. If GitHub shows the effect, the call settles as applied without you.
- **Settled on its Task.** A write still uncertain after the last read-back waits on the Task it was made on. You find it in two places:
  - in the Quest room, as a card in the lane of the hob that made it;
  - in the Inbox, as an entry under its Quest.
  Both offer "It went through" and "It did not go through", and say what the call was and where.
- **Named by its Task and its sending.** `POST /api/tasks/:taskId/charm-calls/:attempt/settlement` settles it, and `GET /api/charm-calls/waiting` lists every uncertain Task write with its Task. Settling needs a `UserSession`, so no hob can settle its own write. It is the same conditional update a read-back uses, so of two racing outcomes only the first lands, and a second settlement is refused with `409 CharmCallSettled`. No migration is needed: a Task's call already has its scope and attempt, and an empty thread and message.
- **The hob is told where.** An uncertain write's answer tells the hob that you can settle it from the Quest room or the Inbox, instead of from the step.

### Changes to ADR 020, 031 and 034

- ADR 020: a write a Task session made is settled from the Quest room or the Inbox. One made in chat is still settled from its step.
- ADR 031: a write without a read-back that ends uncertain in a Task session waits on its Task, through the same use case.
- ADR 034: `writesOutsideChats` no longer requires every write to read back from the hub's own records. A read-back from the outside service is enough, since an uncertain call now has a place to be settled outside chats. The hub still refuses to start when a Charm that declares it has a write with no read-back.

## Rationale

- **The lead stops doing the member's work.** A member that writes the code can push it and open the pull request itself.
- **The safety rules do not change.** The member gets only what its authority allows. Ask still asks you, Never is not even offered, and every write is sent once.
- **The settle choice goes where the work is.** A Task's work is followed in the Quest room and waits on you in the Inbox, so a write that needs you shows there.
- **No new lifecycle.** The call's states and transitions are ADR 020's. Only where you settle from is new, so no new state machine is added.

## Consequences

- The Inbox has a new kind, Unsure, and the Quest room's lanes have a card for it. Neither shows in a chat's Needs-you tray, which stays about the chat.
- The waiting list is read again every half minute, since a call turns uncertain without a journal event. An event for it would let clients follow it live and is left for later.
- Another Charm that reads its writes back can now declare `writesOutsideChats` without further changes.

## Validation

- A member is offered the writes of a Charm that offers them outside chats, and not those of one that does not. Steering goes only to writes it is offered. A write whose operation answers Never is not offered outside chats, and chat is unchanged: `[TC-PE-1343-01]` in `packages/agents/test/charms.test.ts`, and `[TC-OR-497]` in `apps/server/test/member-git-init.test.ts`.
- The store lists uncertain Task writes and finds a call by its scope and sending. A user's settle and a read-back race and land once. A second settle is refused, and a call settled on another Task is not found: `[TC-PE-1343-02]` in `packages/persistence/test/charm-calls.test.ts`.
- Through a whole hub against a fake GitHub, on SQLite and PostgreSQL (`apps/server/test/member-github-writes.test.ts`):
  - A member comments after one approval card, pushes and opens a pull request under Allow, each once, and its `git push` is steered to `github_push`. This runs on the fake runtime, and on an installed Claude Code (2.1.322) and Codex (0.167.0) driven by a stand-in model: `[TC-OR-1343-01]`.
  - A push whose answer is lost is read back as applied. A comment still uncertain waits on its Task, is listed as waiting, and is settled there once: `[TC-OR-1343-02]`.
  - A member whose authority answers Never for commenting is not offered it, and its call is refused on its Task without reaching GitHub: `[TC-OR-1343-03]`.
- An uncertain Task write is listed in the Inbox under its Quest: `[TC-IN-1343-01]` in `apps/web/src/components/inbox/inbox-entries.test.ts`. In the browser, it waits in the Inbox and in the hob's Quest room lane, passes an axe scan, and is settled once from the lane with the keyboard. A second settlement is refused: `[TC-OR-1343-04]` in `apps/web/e2e/task-charm-calls.e2e.ts`.
