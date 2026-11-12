import { describe, expect, it } from "vitest";
import { AgentId, ThreadId } from "../src/ids.ts";
import type { MessageStatus, ReplyStep } from "../src/message.ts";
import {
  type HobPresence,
  hobPresenceState,
  leadsNeedingYou,
  noStatus,
  replyActivity,
  type StatusEvent,
  type StatusSnapshot,
  shownStatus,
  type ThreadRunStatus,
  withSnapshot,
  withStatusEvent,
} from "../src/presence.ts";

// A command the reply waits on once it has answered (#1056).
const waitedCommand: ReplyStep = {
  id: "c1",
  kind: "tool",
  label: "Running pnpm test",
  state: "running",
  waitedOn: true,
};

const reply = (status: MessageStatus, content: string, steps: ReadonlyArray<ReplyStep> = []) => ({
  status,
  content,
  steps,
});

describe("replyActivity", () => {
  it("thinks before the first words", () => expect(replyActivity(reply("streaming", ""))).toBe("thinking"));
  it("works once it writes, stopping included", () => {
    expect(replyActivity(reply("streaming", "Hel"))).toBe("working");
    expect(replyActivity(reply("stopping", "Hel"))).toBe("working");
  });
  it("waits once it only waits on commands it started", () =>
    expect(replyActivity(reply("streaming", "Done, tests run", [waitedCommand]))).toBe("waiting"));
  it("does nothing once it ended", () => expect(replyActivity(reply("complete", "Hello"))).toBeNull());
});

describe("hobPresenceState", () => {
  const active = { status: "active", needsYou: false, replies: [] } as const;

  it("puts its lifecycle first", () =>
    expect(hobPresenceState({ ...active, status: "paused", needsYou: true, replies: ["working"] })).toBe("paused"));
  it("needs you over what its replies do", () =>
    expect(hobPresenceState({ ...active, needsYou: true, replies: ["working"] })).toBe("needs-you"));
  it("works, then thinks, then waits on a command", () => {
    expect(hobPresenceState({ ...active, replies: ["waiting", "thinking", "working"] })).toBe("working");
    expect(hobPresenceState({ ...active, replies: ["waiting", "thinking"] })).toBe("thinking");
    expect(hobPresenceState({ ...active, replies: ["waiting"] })).toBe("on-command");
  });
  it("rests with nothing running", () => expect(hobPresenceState(active)).toBe("idle"));
});

describe("the status a client holds", () => {
  const thread = ThreadId.make("t1");
  const hob = AgentId.make("a1");
  const run = (run: ThreadRunStatus["run"], revision: number): ThreadRunStatus => ({
    threadId: thread,
    run,
    reply: run === "running" ? "working" : null,
    revision,
  });
  const presence = (state: HobPresence["state"], revision: number): HobPresence => ({ agentId: hob, state, revision });
  const snapshot = (over: Partial<StatusSnapshot>): StatusSnapshot => ({
    runsRevision: 0,
    runs: [],
    presenceRevision: 0,
    hobs: [],
    ...over,
  });

  it("starts again from a restarted hub's revisions, however high the ones it held", () => {
    const before = withSnapshot(noStatus, {
      runsRevision: 100,
      runs: [run("running", 100)],
      presenceRevision: 80,
      hobs: [presence("working", 80)],
    });
    // The restarted hub's connection starts with `Ready`: the client drops what it held.
    const after = withSnapshot(withStatusEvent(noStatus, { _tag: "ThreadRunChanged", run: run("running", 1) }), {
      runsRevision: 0,
      runs: [],
      presenceRevision: 1,
      hobs: [presence("thinking", 1)],
    });
    expect(shownStatus(before).hobs).toEqual([presence("working", 80)]);
    expect(shownStatus(after)).toEqual({ runs: [run("running", 1)], hobs: [presence("thinking", 1)] });
  });

  it("keeps an event that arrived while the snapshot was read, and drops an older one", () => {
    const early = withStatusEvent(noStatus, { _tag: "ThreadRunChanged", run: run("idle", 5) });
    const fresh = withStatusEvent(early, { _tag: "ThreadRunChanged", run: run("running", 9) });
    expect(shownStatus(withSnapshot(early, snapshot({ runsRevision: 7, runs: [run("running", 7)] }))).runs).toEqual([
      run("running", 7),
    ]);
    expect(shownStatus(withSnapshot(fresh, snapshot({ runsRevision: 7 }))).runs).toEqual([run("running", 9)]);
    // Once the snapshot is in, an event from before it changes nothing.
    const held = withSnapshot(noStatus, snapshot({ runsRevision: 7, runs: [run("running", 7)] }));
    expect(withStatusEvent(held, { _tag: "ThreadRunChanged", run: run("idle", 6) })).toBe(held);
  });

  it("shows a hob brought back after its removal, even when a snapshot from before both arrives last", () => {
    // The snapshot is read at revision 3; the hob retires at 4 and comes back at 5 before it arrives.
    const events: ReadonlyArray<StatusEvent> = [
      { _tag: "HobPresenceRemoved", agentId: hob, revision: 4 },
      { _tag: "HobPresenceChanged", presence: presence("idle", 5) },
    ];
    const live = events.reduce(withStatusEvent, noStatus);
    const late = withSnapshot(live, snapshot({ presenceRevision: 3, hobs: [presence("working", 3)] }));
    expect(shownStatus(late).hobs).toEqual([presence("idle", 5)]);
    // And a removal after it comes back still wins over the older presence.
    const gone = withStatusEvent(late, { _tag: "HobPresenceRemoved", agentId: hob, revision: 6 });
    expect(
      shownStatus(withSnapshot(gone, snapshot({ presenceRevision: 5, hobs: [presence("idle", 5)] }))).hobs,
    ).toEqual([]);
  });

  it("drops a retired hob's presence, and keeps it dropped against an older snapshot or change", () => {
    const held = withSnapshot(noStatus, snapshot({ presenceRevision: 3, hobs: [presence("idle", 3)] }));
    const removed = withStatusEvent(held, { _tag: "HobPresenceRemoved", agentId: hob, revision: 4 });
    expect(shownStatus(removed).hobs).toEqual([]);
    expect(
      shownStatus(withStatusEvent(removed, { _tag: "HobPresenceChanged", presence: presence("working", 3) })).hobs,
    ).toEqual([]);
    const reread = withSnapshot(
      withStatusEvent(noStatus, { _tag: "HobPresenceRemoved", agentId: hob, revision: 4 }),
      snapshot({ presenceRevision: 3, hobs: [presence("idle", 3)] }),
    );
    expect(shownStatus(reread).hobs).toEqual([]);
  });
});

describe("leadsNeedingYou", () => {
  const ada = AgentId.make("ada");
  const aldric = AgentId.make("aldric");
  const pip = AgentId.make("pip");
  const thread = ThreadId.make("t1");
  const leadOf = (id: ThreadId) => (id === thread ? aldric : undefined);

  // covers UX-002, OR-005
  it("[TC-UX-191] marks only the lead whose chat a member's request, question, stuck work or failed Task waits in", () => {
    const needs = leadsNeedingYou({
      approvals: [
        { agentId: ada, threadId: thread, state: "pending" },
        { agentId: pip, threadId: ThreadId.make("t9"), state: "approved" },
      ],
      blockers: [{ recipientId: ada, threadId: thread }],
      questions: [{ question: { askerId: ada, chain: [aldric] } }],
      failed: [{ task: { id: "build", ownerId: ada, threadId: thread } as never, leadId: aldric }],
      leadOf,
    });
    expect([...needs]).toEqual([aldric]);
  });

  it("marks the hob itself when its chat is not known, and nobody for decided requests", () => {
    const needs = leadsNeedingYou({
      approvals: [{ agentId: pip, threadId: ThreadId.make("t9"), state: "pending" }],
      blockers: [],
      questions: [{ question: { askerId: ada, chain: [] } }],
      failed: [],
      leadOf,
    });
    expect([...needs].sort()).toEqual([ada, pip]);
  });
});
