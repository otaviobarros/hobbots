import { MessageId } from "@hobbots/domain";
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
  type ThreadRun,
  type ThreadRunEvent,
  ThreadRunMachine,
} from "../src/thread-run.ts";

// The machine compares replies by identity only, so plain objects stand in for them.
const replies = [0, 1, 2].map((n) => ({ n }) as unknown as Reply);
const replyIndex = (reply: Reply | null) => (reply === null ? null : replies.indexOf(reply));
const messages = ["m-1", "m-2", "m-3"].map((id) => MessageId.make(id));

/** What the model tracks of a run: every field, with the reply as its place in `replies`. */
interface RunView {
  readonly run: RunState;
  readonly reply: number | null;
  readonly chosen: MessageId | null;
  readonly held: boolean;
  readonly wakePending: boolean;
}

const view = (run: ThreadRun): RunView => ({
  run: run.run,
  reply: replyIndex(run.reply),
  chosen: run.chosen,
  held: run.held,
  wakePending: run.wakePending,
});

type Rule<T extends ThreadRunEvent["_tag"]> = (
  m: RunView,
  event: Extract<ThreadRunEvent, { readonly _tag: T }>,
) => RunView | "refused";

/** The rules of ADR 037's run, written apart from the machine's table. */
const rules: { readonly [T in ThreadRunEvent["_tag"]]: Rule<T> } = {
  Dispatch: (m) => (m.run === "idle" ? { ...m, run: "dispatching", wakePending: false } : "refused"),
  Launch: (m, e) => {
    if (m.run === "idle") return { ...m, run: "running", reply: replyIndex(e.reply) };
    return m.run === "dispatching" ? { ...m, run: "carrying", reply: replyIndex(e.reply) } : "refused";
  },
  // Only the turn that runs now can end; a stale reply is refused.
  TurnEnded: (m, e) => {
    if (m.reply !== replyIndex(e.reply)) return "refused";
    if (m.run === "running") return { ...m, run: "draining", reply: null };
    return m.run === "carrying" ? { ...m, run: "dispatching", reply: null } : "refused";
  },
  Drained: (m) => {
    if (m.run === "draining") return { ...m, run: "idle" };
    return m.run === "idle" ? m : "refused";
  },
  Delivered: (m) => (m.run === "dispatching" ? { ...m, run: "idle", wakePending: false } : "refused"),
  WakeLater: (m) => (m.run === "idle" ? "refused" : { ...m, wakePending: true }),
  Choose: (m, e) => ({ ...m, chosen: e.messageId }),
  Unchoose: (m, e) => (e.messageId === null || m.chosen === e.messageId ? { ...m, chosen: null } : m),
  Hold: (m) => ({ ...m, held: true }),
  Release: (m) => ({ ...m, held: false }),
};

const step = (m: RunView, event: ThreadRunEvent) =>
  (rules[event._tag] as Rule<ThreadRunEvent["_tag"]>)(m, event as never);

const reply = fc.constantFrom(...replies);
const messageId = fc.constantFrom(...messages);

const events: fc.Arbitrary<ThreadRunEvent> = fc.oneof(
  fc.constant({ _tag: "Dispatch" } as const),
  reply.map((r) => ({ _tag: "Launch", reply: r }) as const),
  reply.map((r) => ({ _tag: "TurnEnded", reply: r }) as const),
  fc.constant({ _tag: "Drained" } as const),
  fc.constant({ _tag: "Delivered" } as const),
  fc.constant({ _tag: "WakeLater" } as const),
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
      reply,
      chosen: fc.option(messageId, { nil: null }),
      held: fc.boolean(),
      wakePending: fc.boolean(),
    })
    .map((r) => ({
      ...r,
      reply: r.run === "running" || r.run === "carrying" ? r.reply : null,
      wakePending: r.run === "idle" ? false : r.wakePending,
    })),
);

const apply = (run: ThreadRun, ...events: ReadonlyArray<ThreadRunEvent>) =>
  events.reduce((current, event) => {
    const next = ThreadRunMachine.transition(current, event);
    if (typeof next === "string") throw new Error(next);
    return next;
  }, run);

describe("ThreadRunMachine", () => {
  it("agrees with its model over random runs of sends, Send now, wakes, stops and turn ends", () => {
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
    const run = apply(idleRun, { _tag: "Launch", reply: r });
    expect(isBusy(run)).toBe(true);
    const ended = apply(run, { _tag: "TurnEnded", reply: r }, { _tag: "Drained" });
    expect(isBusy(ended)).toBe(false);
    expect(isAtRest(ended)).toBe(true);
  });

  it("refuses the end of a turn that another turn already replaced", () => {
    const [first, second] = replies as [Reply, Reply];
    const run = apply(idleRun, { _tag: "Launch", reply: second });
    expect(ThreadRunMachine.can(run, { _tag: "TurnEnded", reply: first })).toBe(false);
  });

  it("goes back to dispatching when a carried turn ends, so the dispatcher frees the thread", () => {
    const r = replies[0] as Reply;
    const run = apply(idleRun, { _tag: "Dispatch" }, { _tag: "Launch", reply: r }, { _tag: "TurnEnded", reply: r });
    expect(run.run).toBe("dispatching");
    expect(apply(run, { _tag: "Delivered" }).run).toBe("idle");
  });

  it("keeps a wake that arrives while busy until the dispatcher next looks", () => {
    const r = replies[0] as Reply;
    const woken = apply(idleRun, { _tag: "Launch", reply: r }, { _tag: "WakeLater" });
    expect(woken.wakePending).toBe(true);
    expect(isAtRest(apply(woken, { _tag: "TurnEnded", reply: r }, { _tag: "Drained" }))).toBe(false);
    expect(apply(woken, { _tag: "TurnEnded", reply: r }, { _tag: "Drained" }, { _tag: "Dispatch" }).wakePending).toBe(
      false,
    );
    expect(ThreadRunMachine.can(idleRun, { _tag: "WakeLater" })).toBe(false);
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
