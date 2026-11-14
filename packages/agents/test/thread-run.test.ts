import { AgentId, MessageId, mainLine, type ReplyActivity, ThreadId } from "@hobbots/domain";
import { agreesWithModel } from "@hobbots/domain/machine-testing";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  idleRun,
  isAtRest,
  isBusy,
  type Reply,
  RUN_STATES,
  type RunState,
  runStatus,
  type ThreadRun,
  type ThreadRunEvent,
  ThreadRunMachine,
} from "../src/thread-run.ts";

// The machine compares replies by identity only, so plain objects stand in for them.
const replies = [0, 1, 2].map((n) => ({ n }) as unknown as Reply);
const replyIndex = (reply: Reply | null) => (reply === null ? null : replies.indexOf(reply));
const messages = ["m-1", "m-2", "m-3"].map((id) => MessageId.make(id));
const threadId = ThreadId.make("t-1");
const line = mainLine(threadId);
const hobs = ["quill", "pip", "rook"].map((id) => AgentId.make(id));

/** What the model tracks of a run: every field, with the reply as its place in `replies`. */
interface RunView {
  readonly run: RunState;
  readonly speaking: AgentId | null;
  readonly next: ReadonlyArray<AgentId>;
  readonly reply: number | null;
  readonly activity: ReplyActivity | null;
  readonly chosen: MessageId | null;
  readonly held: boolean;
}

const view = (run: ThreadRun): RunView => ({
  run: run.run,
  speaking: run.speaking,
  next: run.next,
  reply: replyIndex(run.reply),
  activity: run.activity,
  chosen: run.chosen,
  held: run.held,
});

type Rule<T extends ThreadRunEvent["_tag"]> = (
  m: RunView,
  event: Extract<ThreadRunEvent, { readonly _tag: T }>,
) => RunView | "refused";

/** The rules of ADR 037's run, written apart from the machine's table. */
const rules: { readonly [T in ThreadRunEvent["_tag"]]: Rule<T> } = {
  Dispatch: (m) => (m.run === "idle" ? { ...m, run: "dispatching" } : "refused"),
  Launch: (m, e) => {
    const launched = { speaking: e.hobId, reply: replyIndex(e.reply), activity: e.activity };
    if (m.run === "idle") return { ...m, ...launched, run: "running" };
    return m.run === "dispatching" ? { ...m, ...launched, run: "carrying" } : "refused";
  },
  // Only the reply that runs now reports what it does, and only a change is a transition.
  ReplyChanged: (m, e) =>
    (m.run === "running" || m.run === "carrying") && m.reply === replyIndex(e.reply) && m.activity !== e.activity
      ? { ...m, activity: e.activity }
      : "refused",
  // Only the turn that runs now can end; a stale reply is refused.
  TurnEnded: (m, e) => {
    if (m.reply !== replyIndex(e.reply)) return "refused";
    const ended = { speaking: null, reply: null, activity: null };
    if (m.run === "running") return { ...m, ...ended, run: "draining" };
    return m.run === "carrying" ? { ...m, ...ended, run: "dispatching" } : "refused";
  },
  Drained: (m) => {
    if (m.run === "draining") return { ...m, run: "idle" };
    return m.run === "idle" ? m : "refused";
  },
  Delivered: (m) => (m.run === "dispatching" ? { ...m, run: "idle" } : "refused"),
  // Only a change of who is next is a transition.
  Lined: (m, e) => (JSON.stringify(m.next) === JSON.stringify(e.next) ? "refused" : { ...m, next: e.next }),
  Choose: (m, e) => ({ ...m, chosen: e.messageId }),
  Unchoose: (m, e) => (e.messageId === null || m.chosen === e.messageId ? { ...m, chosen: null } : m),
  Hold: (m) => ({ ...m, held: true }),
  Release: (m) => ({ ...m, held: false }),
};

const step = (m: RunView, event: ThreadRunEvent) =>
  (rules[event._tag] as Rule<ThreadRunEvent["_tag"]>)(m, event as never);

const reply = fc.constantFrom(...replies);
const messageId = fc.constantFrom(...messages);
const activity = fc.constantFrom<ReplyActivity | null>("thinking", "working", "waiting", null);
const hob = fc.constantFrom(...hobs);
const next = fc.array(hob, { maxLength: 3 }).map((ids) => [...new Set(ids)]);

const events: fc.Arbitrary<ThreadRunEvent> = fc.oneof(
  fc.constant({ _tag: "Dispatch" } as const),
  fc.tuple(hob, reply, activity).map(([h, r, a]) => ({ _tag: "Launch", hobId: h, reply: r, activity: a }) as const),
  fc.tuple(reply, activity).map(([r, a]) => ({ _tag: "ReplyChanged", reply: r, activity: a }) as const),
  reply.map((r) => ({ _tag: "TurnEnded", reply: r }) as const),
  fc.constant({ _tag: "Drained" } as const),
  fc.constant({ _tag: "Delivered" } as const),
  next.map((ids) => ({ _tag: "Lined", next: ids }) as const),
  messageId.map((id) => ({ _tag: "Choose", messageId: id }) as const),
  fc.option(messageId, { nil: null }).map((id) => ({ _tag: "Unchoose", messageId: id }) as const),
  fc.constant({ _tag: "Hold" } as const),
  fc.constant({ _tag: "Release" } as const),
);

/** Any run a thread can be in: a turn's reply only while one runs. A restart starts from `idleRun`. */
const records: fc.Arbitrary<ThreadRun> = fc.oneof(
  fc.constant(idleRun),
  fc
    .record({
      run: fc.constantFrom(...RUN_STATES),
      speaking: hob,
      next,
      reply,
      activity,
      chosen: fc.option(messageId, { nil: null }),
      held: fc.boolean(),
    })
    .map((r) => {
      const turning = r.run === "running" || r.run === "carrying";
      return {
        ...r,
        speaking: turning ? r.speaking : null,
        reply: turning ? r.reply : null,
        activity: turning ? r.activity : null,
      };
    }),
);

const apply = (run: ThreadRun, ...events: ReadonlyArray<ThreadRunEvent>) =>
  events.reduce((current, event) => {
    const next = ThreadRunMachine.transition(current, event);
    if (typeof next === "string") throw new Error(next);
    return next;
  }, run);

describe("ThreadRunMachine", () => {
  it("agrees with its model over random runs of sends, Send now, who is next, stops and turn ends", () => {
    agreesWithModel({
      machine: ThreadRunMachine,
      records,
      events,
      model: { init: view, step, view },
      isError: (result): result is string => typeof result === "string",
      runs: 1000,
    });
  });

  it("frees a thread once its turn ends and drains", () => {
    const r = replies[0] as Reply;
    const run = apply(idleRun, { _tag: "Launch", hobId: hobs[0] as AgentId, reply: r, activity: "thinking" });
    expect(isBusy(run)).toBe(true);
    const ended = apply(run, { _tag: "TurnEnded", reply: r }, { _tag: "Drained" });
    expect(isBusy(ended)).toBe(false);
    expect(isAtRest(ended)).toBe(true);
  });

  it("follows what the running reply does, and publishes it with the run", () => {
    const [first, second] = replies as [Reply, Reply];
    const run = apply(idleRun, { _tag: "Launch", hobId: hobs[0] as AgentId, reply: first, activity: "thinking" });
    const writing = apply(run, { _tag: "ReplyChanged", reply: first, activity: "working" });
    expect(runStatus(line, writing, 4)).toEqual({
      threadId,
      rootMessageId: null,
      run: "running",
      reply: "working",
      speaking: hobs[0],
      next: [],
      revision: 4,
    });
    // No change, or a reply that no longer runs, is no transition, so nothing is published for it.
    expect(ThreadRunMachine.can(writing, { _tag: "ReplyChanged", reply: first, activity: "working" })).toBe(false);
    expect(ThreadRunMachine.can(writing, { _tag: "ReplyChanged", reply: second, activity: "waiting" })).toBe(false);
    const ended = apply(writing, { _tag: "TurnEnded", reply: first });
    expect(runStatus(line, ended, 5)).toEqual({
      threadId,
      rootMessageId: null,
      run: "draining",
      reply: null,
      speaking: null,
      next: [],
      revision: 5,
    });
  });

  it("refuses the end of a turn that another turn already replaced", () => {
    const [first, second] = replies as [Reply, Reply];
    const run = apply(idleRun, { _tag: "Launch", hobId: hobs[0] as AgentId, reply: second, activity: "thinking" });
    expect(ThreadRunMachine.can(run, { _tag: "TurnEnded", reply: first })).toBe(false);
  });

  it("goes back to dispatching when a carried turn ends, so the dispatcher frees the thread", () => {
    const r = replies[0] as Reply;
    const run = apply(
      idleRun,
      { _tag: "Dispatch" },
      { _tag: "Launch", hobId: hobs[0] as AgentId, reply: r, activity: "thinking" },
      { _tag: "TurnEnded", reply: r },
    );
    expect(run.run).toBe("dispatching");
    expect(apply(run, { _tag: "Delivered" }).run).toBe("idle");
  });

  it("says who speaks while a turn runs, and keeps who is next until nobody waits", () => {
    const r = replies[0] as Reply;
    const [quill, pip, rook] = hobs as [AgentId, AgentId, AgentId];
    const lined = apply(idleRun, { _tag: "Lined", next: [pip, rook] });
    expect(isAtRest(lined)).toBe(false);
    const speaking = apply(lined, { _tag: "Launch", hobId: quill, reply: r, activity: "thinking" });
    expect(speaking.speaking).toBe(quill);
    // The same line-up again is no transition, so nothing is published for it.
    expect(ThreadRunMachine.can(speaking, { _tag: "Lined", next: [pip, rook] })).toBe(false);
    const ended = apply(speaking, { _tag: "TurnEnded", reply: r }, { _tag: "Drained" });
    expect(ended.speaking).toBeNull();
    expect(isAtRest(apply(ended, { _tag: "Lined", next: [] }))).toBe(true);
  });

  it("keeps a hold set when the stopped turn ended before the stop was saved", () => {
    const held = apply(idleRun, { _tag: "Hold" });
    expect(held.held).toBe(true);
    expect(isAtRest(held)).toBe(false);
    expect(isAtRest(apply(held, { _tag: "Release" }))).toBe(true);
  });

  it("forgets the chosen message only when that message, or any, is taken", () => {
    const [a, b] = messages as [MessageId, MessageId];
    const chosen = apply(idleRun, { _tag: "Choose", messageId: a });
    expect(apply(chosen, { _tag: "Unchoose", messageId: b }).chosen).toBe(a);
    expect(apply(chosen, { _tag: "Unchoose", messageId: a }).chosen).toBeNull();
    expect(apply(chosen, { _tag: "Unchoose", messageId: null }).chosen).toBeNull();
  });
});
