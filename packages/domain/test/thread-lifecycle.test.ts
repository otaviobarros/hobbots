import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AgentId,
  IllegalThreadTransition,
  Thread,
  type ThreadId,
  type ThreadKind,
  ThreadLifecycle,
  type ThreadLifecycleEvent,
  ThreadLifecycleMachine,
  type ThreadState,
  ThreadState as ThreadStates,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = "2026-01-01T00:00:00.000Z";

const thread = (state: ThreadState, kind: ThreadKind = "chat") =>
  new Thread({
    id: "thread-1" as ThreadId,
    agentId: "hob-1" as AgentId,
    title: "Plans",
    kind,
    state,
    archivedAt: state === "archived" ? at : null,
    createdAt: at,
    updatedAt: at,
    revision: 1 as Thread["revision"],
  });

/** What the model tracks of a thread: every field a rule writes. */
interface ThreadView {
  readonly state: ThreadState;
  readonly kind: ThreadKind;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

const view = (t: Thread): ThreadView => ({
  state: t.state,
  kind: t.kind,
  archivedAt: t.archivedAt,
  updatedAt: t.updatedAt,
});

// The rules as archive and restore kept them in the chat service before the machine, plus Start
// fresh's supersede, kept apart from the machine so the two can disagree.
const blocked = (e: {
  readonly hobRetired: boolean;
  readonly approvalPending: boolean;
  readonly replyRunning: boolean;
}) => e.hobRetired || e.approvalPending || e.replyRunning;

const stepModel = (m: ThreadView, e: ThreadLifecycleEvent): ThreadView | "refused" => {
  switch (e._tag) {
    case "Archive":
      return m.state !== "open" || blocked(e) ? "refused" : { ...m, state: "archived", archivedAt: e.at };
    case "Restore":
      if (m.state !== "archived" || e.hobRetired) return "refused";
      return { ...m, state: "open", archivedAt: null, kind: e.chatOpen ? "camp" : m.kind };
    case "Supersede":
      return m.state !== "open" || m.kind !== "chat" || blocked(e)
        ? "refused"
        : { ...m, state: "superseded", archivedAt: e.at, updatedAt: e.at };
  }
};

const times = fc
  .integer({ min: 0, max: 10_000 })
  .map((minute) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString());
const blockers = { hobRetired: fc.boolean(), approvalPending: fc.boolean(), replyRunning: fc.boolean() };
const events: fc.Arbitrary<ThreadLifecycleEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Archive" as const), at: times, ...blockers }),
  fc.record({ _tag: fc.constant("Restore" as const), hobRetired: fc.boolean(), chatOpen: fc.boolean() }),
  fc.record({ _tag: fc.constant("Supersede" as const), at: times, ...blockers }),
);

const refusalOf = (result: Thread | IllegalThreadTransition) =>
  result instanceof IllegalThreadTransition ? result.refusal : "taken";

describe("ThreadLifecycleMachine", () => {
  it("agrees with a model of archive, restore and supersede over random runs of events", () => {
    agreesWithModel({
      machine: ThreadLifecycleMachine,
      records: fc
        .tuple(fc.constantFrom(...ThreadStates.literals), fc.constantFrom<ThreadKind>("chat", "camp"))
        .map(([state, kind]) => thread(state, kind)),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalThreadTransition => result instanceof IllegalThreadTransition,
    });
  });

  it("names why an archive is refused, a retired hob first, then a waiting approval, then a reply", () => {
    const archive = (blockers: Partial<Record<"hobRetired" | "approvalPending" | "replyRunning", boolean>>) =>
      refusalOf(
        ThreadLifecycle.transition(thread("open"), {
          _tag: "Archive",
          at,
          hobRetired: false,
          approvalPending: false,
          replyRunning: false,
          ...blockers,
        }),
      );
    expect(archive({ hobRetired: true, approvalPending: true, replyRunning: true })).toBe("hob-retired");
    expect(archive({ approvalPending: true, replyRunning: true })).toBe("approval-pending");
    expect(archive({ replyRunning: true })).toBe("reply-running");
    expect(archive({})).toBe("taken");
    // A thread already archived is refused by its state, with no reason to give.
    expect(
      refusalOf(
        ThreadLifecycle.transition(thread("archived"), {
          _tag: "Archive",
          at,
          hobRetired: true,
          approvalPending: false,
          replyRunning: false,
        }),
      ),
    ).toBeNull();
    expect(
      refusalOf(ThreadLifecycle.transition(thread("archived"), { _tag: "Restore", hobRetired: true, chatOpen: false })),
    ).toBe("hob-retired");
  });

  it("supersedes only an open chat, for the same reasons an archive is refused", () => {
    const supersede = (
      from: Thread,
      blockers: Partial<Record<"hobRetired" | "approvalPending" | "replyRunning", boolean>> = {},
    ) =>
      ThreadLifecycle.transition(from, {
        _tag: "Supersede",
        at: "2026-01-02T00:00:00.000Z",
        hobRetired: false,
        approvalPending: false,
        replyRunning: false,
        ...blockers,
      });
    expect(supersede(thread("open"))).toMatchObject({
      state: "superseded",
      archivedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(refusalOf(supersede(thread("open"), { approvalPending: true, replyRunning: true }))).toBe(
      "approval-pending",
    );
    expect(refusalOf(supersede(thread("open"), { replyRunning: true }))).toBe("reply-running");
    // A camp, or a chat no longer open, is refused by what it is, with no reason to give.
    expect(refusalOf(supersede(thread("open", "camp")))).toBeNull();
    expect(refusalOf(supersede(thread("archived"), { hobRetired: true }))).toBeNull();
  });

  it("brings a chat back as a camp when its hob opened another chat while it was archived", () => {
    const back = ThreadLifecycle.transition(thread("archived"), { _tag: "Restore", hobRetired: false, chatOpen: true });
    const alone = ThreadLifecycle.transition(thread("archived"), {
      _tag: "Restore",
      hobRetired: false,
      chatOpen: false,
    });
    expect(back).toMatchObject({ state: "open", kind: "camp", archivedAt: null });
    expect(alone).toMatchObject({ state: "open", kind: "chat", archivedAt: null });
    expect(ThreadLifecycle.isOpenChat(alone as Thread)).toBe(true);
  });

  it("exports one row per event, each guarded", () => {
    expect(ThreadLifecycleMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Archive", ["open"], "archived", true],
      ["Restore", ["archived"], "open", true],
      ["Supersede", ["open"], "superseded", true],
    ]);
  });
});
