import {
  AgentId,
  DEFAULT_TURN_LIMITS,
  limitReached,
  type RuntimeKind,
  type TurnHolder,
  type TurnLimits,
} from "@hobbots/domain";
import { Effect, Layer, Ref, Schedule } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TurnLimitsStore, type TurnSlot, TurnSlots } from "../src/index.ts";

// Issue #1448 (OR-005): the hub's turn slots. A turn past a limit waits, is woken once a slot may
// be its, and slots go to Quests in a fair order.

/** Something that wants turns, as a thread, a step or a member's Task does. */
interface Work extends TurnHolder {
  readonly id: string;
}

const work = (id: string, agentId: string, runtime: RuntimeKind, quest: string | null): Work => ({
  id,
  agentId: AgentId.make(agentId),
  runtime,
  quest,
});

/** What each piece of work is doing: nothing, waiting for a slot, or running in one. */
type Phase = { readonly _tag: "idle" } | { readonly _tag: "waiting" } | { readonly _tag: "running"; slot: TurnSlot };

/**
 * The work as the runners keep it: a turn asks for a slot, and waits queued when it gets none; its
 * wake asks again, as a runner's wake starts what waits. `started` keeps the order slots went in.
 */
const harness = (slots: TurnSlots["Service"], all: ReadonlyArray<Work>) =>
  Effect.gen(function* () {
    const phases = yield* Ref.make(new Map<string, Phase>(all.map((each) => [each.id, { _tag: "idle" }])));
    const started: Array<string> = [];
    const ask = (each: Work): Effect.Effect<void> =>
      Effect.gen(function* () {
        const slot = yield* slots.take(
          each,
          Effect.suspend(() => wake(each)),
        );
        if (slot === null) {
          yield* Ref.update(phases, (map) => new Map(map).set(each.id, { _tag: "waiting" }));
          return;
        }
        started.push(each.id);
        yield* Ref.update(phases, (map) => new Map(map).set(each.id, { _tag: "running", slot }));
      });
    // A wake starts the work only when it still waits, as a runner finds a queued message.
    const wake = (each: Work) =>
      Effect.flatMap(Ref.get(phases), (map) => (map.get(each.id)?._tag === "waiting" ? ask(each) : Effect.void));
    const finish = (each: Work) =>
      Effect.gen(function* () {
        const phase = (yield* Ref.get(phases)).get(each.id);
        if (phase?._tag !== "running") return;
        yield* Ref.update(phases, (map) => new Map(map).set(each.id, { _tag: "idle" }));
        yield* phase.slot.release;
      });
    const running = Effect.map(Ref.get(phases), (map) => all.filter((each) => map.get(each.id)?._tag === "running"));
    const waiting = Effect.map(Ref.get(phases), (map) => all.filter((each) => map.get(each.id)?._tag === "waiting"));
    /**
     * Waits until the slots agree with the work and no waiting turn would fit: every wake the
     * last change started has run. Read again and again, never after a fixed delay.
     */
    const settled = (limits: TurnLimits) =>
      Effect.gen(function* () {
        const runs = yield* running;
        const waits = yield* waiting;
        const report = yield* slots.report;
        const agrees =
          report.active
            .map((each) => each.id)
            .sort()
            .join() ===
            runs
              .map((each) => each.id)
              .sort()
              .join() &&
          report.waiting
            .map((each) => each.id)
            .sort()
            .join() ===
            waits
              .map((each) => each.id)
              .sort()
              .join() &&
          waits.every((each) => limitReached(limits, runs, each) !== null);
        if (!agrees) return yield* Effect.fail("unsettled" as const);
        return { runs, waits, report };
      }).pipe(Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 2000 }));
    return { ask, finish, running, waiting, settled, started, phases };
  });

const slotsWith = (limits: TurnLimits) =>
  TurnSlots.layer.pipe(
    Layer.provide(Layer.succeed(TurnLimitsStore, { get: Effect.succeed(limits), set: () => Effect.void })),
  );

const run = <A, E>(limits: TurnLimits, effect: (slots: TurnSlots["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(TurnSlots.use(effect).pipe(Effect.provide(slotsWith(limits))));

const ALL: ReadonlyArray<Work> = [
  work("thread:a1", "aldric", "claude-code", null),
  work("thread:a2", "aldric", "claude-code", "q1"),
  work("step:b1", "bram", "claude-code", "q1"),
  work("step:b2", "bram", "codex", "q2"),
  work("member:c1", "cora", "codex", "q2"),
  work("member:c2", "cora", "claude-code", "q3"),
  work("thread:d1", "dain", "codex", null),
];

describe("TurnSlots", () => {
  // covers OR-005
  it("[TC-AG-1448-01] keeps every limit and leaves no turn waiting that fits, over random asks and ends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          perHob: fc.integer({ min: 1, max: 2 }),
          perQuest: fc.integer({ min: 1, max: 2 }),
          perRuntime: fc.record({
            "claude-code": fc.integer({ min: 1, max: 3 }),
            codex: fc.integer({ min: 1, max: 3 }),
          }),
        }),
        fc.array(fc.record({ finish: fc.boolean(), at: fc.nat(ALL.length - 1) }), { maxLength: 30 }),
        (limits, ops) =>
          run(limits, (slots) =>
            Effect.gen(function* () {
              const h = yield* harness(slots, ALL);
              for (const op of ops) {
                const each = ALL[op.at] as Work;
                const phase = (yield* Ref.get(h.phases)).get(each.id);
                if (op.finish) yield* h.finish(each);
                else if (phase?._tag === "idle") yield* h.ask(each);
                const { runs } = yield* h.settled(limits);
                for (const one of runs) {
                  const others = runs.filter((other) => other !== one);
                  expect(limitReached(limits, others, one)).toBe(null);
                }
              }
            }),
          ),
      ),
      { numRuns: 60 },
    );
  });

  // covers OR-005
  it("[TC-AG-1448-02] gives a freed slot to the Quest that has had none, though a busy Quest asked first", async () => {
    const limits = { ...DEFAULT_TURN_LIMITS, perRuntime: { "claude-code": 1, codex: 1 } };
    const busy = [1, 2, 3].map((n) => work(`step:busy-${n}`, `hob-${n}`, "claude-code", "busy"));
    const quiet = work("step:quiet", "hob-9", "claude-code", "quiet");
    await run(limits, (slots) =>
      Effect.gen(function* () {
        const h = yield* harness(slots, [...busy, quiet]);
        for (const each of [...busy, quiet]) yield* h.ask(each);
        const first = yield* h.settled(limits);
        expect(first.runs.map((each) => each.id)).toEqual(["step:busy-1"]);
        expect(first.report.waiting.map((each) => [each.id, each.waitingOn])).toEqual([
          ["step:quiet", "runtime"],
          ["step:busy-2", "runtime"],
          ["step:busy-3", "runtime"],
        ]);
        expect(first.report.usage).toBe("after-turn");
        // The busy Quest's turn ends: the quiet one goes next, then the busy one takes turns again.
        yield* h.finish(busy[0] as Work);
        yield* h.settled(limits);
        yield* h.finish(quiet);
        yield* h.settled(limits);
        yield* h.finish(busy[1] as Work);
        yield* h.settled(limits);
        expect(h.started).toEqual(["step:busy-1", "step:quiet", "step:busy-2", "step:busy-3"]);
      }),
    );
  });

  // covers OR-005
  it("[TC-AG-1448-03] passes a slot on when a woken turn no longer needs it, and frees a slot once", async () => {
    const limits = { ...DEFAULT_TURN_LIMITS, perHob: 1 };
    await run(limits, (slots) =>
      Effect.gen(function* () {
        const woken: Array<string> = [];
        const first = yield* slots.take(work("thread:one", "aldric", "claude-code", null), Effect.void);
        // This one's work goes away before its wake: the wake does not ask again.
        expect(
          yield* slots.take(
            work("thread:gone", "aldric", "claude-code", null),
            Effect.sync(() => woken.push("gone")),
          ),
        ).toBe(null);
        const late = work("thread:late", "aldric", "claude-code", null);
        const lateSlot = yield* Ref.make<TurnSlot | null>(null);
        const wakeLate: Effect.Effect<void> = Effect.gen(function* () {
          woken.push("late");
          yield* Ref.set(lateSlot, yield* slots.take(late, wakeLate));
        });
        expect(yield* slots.take(late, wakeLate)).toBe(null);
        expect(first).not.toBe(null);
        yield* (first as TurnSlot).release;
        // Released twice, it frees one slot: the late turn holds the only one.
        yield* (first as TurnSlot).release;
        const report = yield* Effect.retry(
          Effect.flatMap(slots.report, (now) =>
            now.active.length === 1 && now.waiting.length === 0 ? Effect.succeed(now) : Effect.fail("unsettled"),
          ),
          { schedule: Schedule.spaced("1 millis"), times: 2000 },
        );
        expect(woken).toEqual(["gone", "late"]);
        expect(report.active.map((each) => each.id)).toEqual(["thread:late"]);
        expect(yield* Ref.get(lateSlot)).not.toBe(null);
      }),
    );
  });

  // covers OR-005
  it("[TC-AG-1448-04] keeps new limits and starts the turns that fit under them", async () => {
    const kept: Array<TurnLimits> = [];
    const store = Layer.succeed(TurnLimitsStore, {
      get: Effect.succeed({ ...DEFAULT_TURN_LIMITS, perHob: 1 }),
      set: (limits) => Effect.sync(() => void kept.push(limits)),
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const slots = yield* TurnSlots;
          const h = yield* harness(slots, [
            work("thread:one", "aldric", "claude-code", null),
            work("thread:two", "aldric", "claude-code", null),
          ]);
          yield* h.ask(work("thread:one", "aldric", "claude-code", null));
          yield* h.ask(work("thread:two", "aldric", "claude-code", null));
          expect((yield* slots.report).waiting.map((each) => each.waitingOn)).toEqual(["hob"]);
          const wider = { ...DEFAULT_TURN_LIMITS, perHob: 2 };
          yield* slots.setLimits(wider);
          const { runs } = yield* h.settled(wider);
          expect(runs.map((each) => each.id)).toEqual(["thread:one", "thread:two"]);
          expect(kept).toEqual([wider]);
          expect(yield* slots.limits).toEqual(wider);
        }).pipe(Effect.provide(TurnSlots.layer.pipe(Layer.provide(store)))),
      ),
    );
  });
});
