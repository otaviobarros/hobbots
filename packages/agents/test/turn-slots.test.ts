import { AgentId, MAX_ACTIVE_TURNS, type SlotTurn } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Deferred, Effect, Ref } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type TurnSlot, TurnSlots } from "../src/index.ts";

// Issue #1590 (OR-005): the hub's turn slots. At most a cap of turns run at once; a turn past it
// waits, is woken once a slot may be its, and waiting turns start in the order they asked.

const isSet = <A>(value: A | null): value is A => value !== null;

const work = (id: string, agentId = "aldric"): SlotTurn => ({ id, agentId: AgentId.make(agentId) });

/** What each piece of work is doing: nothing, waiting for a slot, or running in one. */
type Phase = { readonly _tag: "idle" } | { readonly _tag: "waiting" } | { readonly _tag: "running"; slot: TurnSlot };

/**
 * The work as the runners keep it: a turn asks for a slot, and waits queued when it gets none; its
 * wake asks again, as a runner's wake starts what waits. `started` keeps the order slots went in.
 */
const harness = (slots: TurnSlots["Service"], all: ReadonlyArray<SlotTurn>) =>
  Effect.gen(function* () {
    const phases = yield* Ref.make(new Map<string, Phase>(all.map((each) => [each.id, { _tag: "idle" }])));
    const started: Array<string> = [];
    const ask = (each: SlotTurn): Effect.Effect<void> =>
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
    const wake = (each: SlotTurn) =>
      Effect.flatMap(Ref.get(phases), (map) => (map.get(each.id)?._tag === "waiting" ? ask(each) : Effect.void));
    const finish = (each: SlotTurn) =>
      Effect.gen(function* () {
        const phase = (yield* Ref.get(phases)).get(each.id);
        if (phase?._tag !== "running") return;
        yield* Ref.update(phases, (map) => new Map(map).set(each.id, { _tag: "idle" }));
        yield* phase.slot.release;
      });
    const ids = (pick: Phase["_tag"]) =>
      Effect.map(Ref.get(phases), (map) => all.filter((each) => map.get(each.id)?._tag === pick).map(({ id }) => id));
    /**
     * Waits until the slots agree with the work and no waiting turn would fit: every wake the last
     * change started has run. Read again and again, never after a fixed delay.
     */
    const settled = (cap: number) =>
      Effect.gen(function* () {
        const runs = yield* ids("running");
        const waits = yield* ids("waiting");
        const report = yield* slots.report;
        const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
          [...a].sort().join() === [...b].sort().join();
        const agrees =
          same(
            report.active.map((each) => each.id),
            runs,
          ) &&
          same(
            report.waiting.map((each) => each.id),
            waits,
          ) &&
          (waits.length === 0 || runs.length === cap);
        return agrees ? { runs, waits, report } : null;
      }).pipe((read) => waitUntil(read, isSet, { what: "the slots to agree with the work", every: "1 millis" }));
    return { ask, finish, settled, started, phases };
  });

const run = <A, E>(cap: number, effect: (slots: TurnSlots["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(TurnSlots.use(effect).pipe(Effect.provide(TurnSlots.layerWith(cap))));

const ALL: ReadonlyArray<SlotTurn> = [
  work("thread:a1"),
  work("thread:a2"),
  work("step:b1", "bram"),
  work("step:b2", "bram"),
  work("member:c1", "cora"),
  work("member:c2", "cora"),
  work("thread:d1", "dain"),
];

describe("TurnSlots", () => {
  it("caps the hub's turns at four (#1590)", async () => {
    expect(MAX_ACTIVE_TURNS).toBe(4);
    const report = await Effect.runPromise(
      TurnSlots.use((slots) => slots.report).pipe(Effect.provide(TurnSlots.layer)),
    );
    expect(report).toEqual({ cap: 4, active: [], waiting: [], usage: "after-turn" });
  });

  it("keeps the cap, leaves no turn waiting while a slot is free, and starts waiting turns in order (#1590)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.record({ finish: fc.boolean(), at: fc.nat(ALL.length - 1) }), { maxLength: 30 }),
        (cap, ops) =>
          run(cap, (slots) =>
            Effect.gen(function* () {
              const h = yield* harness(slots, ALL);
              for (const op of ops) {
                const each = ALL[op.at] as SlotTurn;
                const phase = (yield* Ref.get(h.phases)).get(each.id);
                const waitingBefore = (yield* slots.report).waiting.map(({ id }) => id);
                const startedBefore = h.started.length;
                if (op.finish) yield* h.finish(each);
                else if (phase?._tag === "idle") yield* h.ask(each);
                const { runs } = yield* h.settled(cap);
                expect(runs.length).toBeLessThanOrEqual(cap);
                // What a finished turn freed goes to the turns that waited longest, in order.
                if (op.finish) {
                  const woken = h.started.slice(startedBefore);
                  expect(woken).toEqual(waitingBefore.slice(0, woken.length));
                }
              }
            }),
          ),
      ),
      { numRuns: 60 },
    );
  });

  it("passes a slot on when a woken turn no longer needs it, and frees a slot once (#1590)", async () => {
    await run(1, (slots) =>
      Effect.gen(function* () {
        const woken: Array<string> = [];
        const first = yield* slots.take(work("thread:one"), Effect.void);
        // This one's work goes away before its wake: the wake does not ask again.
        expect(
          yield* slots.take(
            work("thread:gone", "bram"),
            Effect.sync(() => woken.push("gone")),
          ),
        ).toBe(null);
        const late = work("thread:late", "cora");
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
        const report = yield* waitUntil(slots.report, (now) => now.active.length === 1 && now.waiting.length === 0, {
          what: "the late turn to hold the only slot",
          every: "1 millis",
        });
        expect(woken).toEqual(["gone", "late"]);
        expect(report.active.map((each) => each.id)).toEqual(["thread:late"]);
        expect(yield* Ref.get(lateSlot)).not.toBe(null);
      }),
    );
  });

  it("keeps a waiting turn's place when it asks again, and drops it once withdrawn (#1590)", async () => {
    await run(1, (slots) =>
      Effect.gen(function* () {
        const held = yield* slots.take(work("thread:held"), Effect.void);
        expect(held).not.toBe(null);
        expect(yield* slots.take(work("thread:first", "bram"), Effect.void)).toBe(null);
        expect(yield* slots.take(work("thread:second", "cora"), Effect.void)).toBe(null);
        expect(yield* slots.take(work("thread:third", "dain"), Effect.void)).toBe(null);
        // The first asks again while it waits: it stays ahead of the others.
        expect(yield* slots.take(work("thread:first", "bram"), Effect.void)).toBe(null);
        yield* slots.withdraw("thread:second");
        expect((yield* slots.report).waiting.map((each) => each.id)).toEqual(["thread:first", "thread:third"]);
      }),
    );
  });

  it("keeps the queue's order when several slots free at once (#1590)", async () => {
    await run(2, (slots) =>
      Effect.gen(function* () {
        const one = yield* slots.take(work("thread:one"), Effect.void);
        const two = yield* slots.take(work("thread:two", "bram"), Effect.void);
        const first = work("thread:first", "cora");
        const second = work("thread:second", "dain");
        const go = yield* Deferred.make<void>();
        const firstSlot = yield* Ref.make<TurnSlot | null>(null);
        // The first waiter's wake holds until the test lets it ask, so the second can ask before it.
        const wakeFirst: Effect.Effect<void> = Effect.gen(function* () {
          yield* Deferred.await(go);
          yield* Ref.set(firstSlot, yield* slots.take(first, wakeFirst));
        });
        expect(yield* slots.take(first, wakeFirst)).toBe(null);
        expect(yield* slots.take(second, Effect.void)).toBe(null);
        yield* (one as TurnSlot).release;
        yield* (two as TurnSlot).release;
        // Both slots are free, but the second asked after the first: it waits until the first starts.
        expect(yield* slots.take(second, Effect.void)).toBe(null);
        yield* Deferred.succeed(go, undefined);
        yield* waitUntil(Ref.get(firstSlot), isSet, { what: "the first waiter to start", every: "1 millis" });
        expect(yield* slots.take(second, Effect.void)).not.toBe(null);
      }),
    );
  });
});
