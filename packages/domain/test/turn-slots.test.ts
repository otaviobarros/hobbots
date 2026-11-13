import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  admitInOrder,
  DEFAULT_TURN_LIMITS,
  fairOrder,
  IllegalTurnTicketTransition,
  limitReached,
  type TurnHolder,
  type TurnLimits,
  type TurnTicket,
  type TurnTicketEvent,
  TurnTicketMachine,
  TurnTicketState,
  TurnWait,
  turnGroup,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1448 (OR-005): turns past a limit per hob, Quest or runtime wait, and slots go to the
// Quests in a fair order.

const HOBS = ["aldric", "bram", "cora"].map((id) => AgentId.make(id));
const RUNTIMES = ["claude-code", "codex"] as const;
const QUESTS = [null, "q1", "q2", "q3"] as const;

const ticket = (overrides: Partial<TurnTicket> = {}): TurnTicket => ({
  id: "thread:shire",
  agentId: HOBS[0] as AgentId,
  runtime: "claude-code",
  quest: null,
  state: "waiting",
  waitingOn: null,
  asked: 0,
  ...overrides,
});

// The rules of #1448, written apart from the machine: a waiting turn waits again, starts or goes
// away; only one that runs is released.
type View = Pick<TurnTicket, "state" | "waitingOn">;
const stepModel = (model: View, event: TurnTicketEvent): View | "refused" => {
  switch (event._tag) {
    case "Wait":
      return model.state === "waiting" ? { state: "waiting", waitingOn: event.reason } : "refused";
    case "Admit":
      return model.state === "waiting" ? { state: "active", waitingOn: null } : "refused";
    case "Release":
      return model.state === "active" ? { state: "released", waitingOn: model.waitingOn } : "refused";
    case "Withdraw":
      return model.state === "waiting" ? { state: "withdrawn", waitingOn: null } : "refused";
  }
};
const view = ({ state, waitingOn }: TurnTicket): View => ({ state, waitingOn });

const events: fc.Arbitrary<TurnTicketEvent> = fc.oneof(
  fc.constantFrom(...TurnWait.literals).map((reason): TurnTicketEvent => ({ _tag: "Wait", reason })),
  fc.constantFrom<TurnTicketEvent>({ _tag: "Admit" }, { _tag: "Release" }, { _tag: "Withdraw" }),
);

const holders: fc.Arbitrary<TurnHolder> = fc.record({
  agentId: fc.constantFrom(...HOBS),
  runtime: fc.constantFrom(...RUNTIMES),
  quest: fc.constantFrom(...QUESTS),
});

const limits: fc.Arbitrary<TurnLimits> = fc.record({
  perHob: fc.integer({ min: 1, max: 3 }),
  perQuest: fc.integer({ min: 1, max: 3 }),
  perRuntime: fc.record({ "claude-code": fc.integer({ min: 1, max: 4 }), codex: fc.integer({ min: 1, max: 4 }) }),
});

const count = (all: ReadonlyArray<TurnHolder>, pick: (holder: TurnHolder) => unknown, value: unknown) =>
  all.filter((each) => pick(each) === value).length;

/** Whether every turn in `all` keeps within the limits. */
const withinLimits = (bounds: TurnLimits, all: ReadonlyArray<TurnHolder>) =>
  all.every(
    (each) =>
      count(all, (h) => h.agentId, each.agentId) <= bounds.perHob &&
      (each.quest === null || count(all, (h) => h.quest, each.quest) <= bounds.perQuest) &&
      count(all, (h) => h.runtime, each.runtime) <= bounds.perRuntime[each.runtime],
  );

describe("TurnTicketMachine", () => {
  // covers OR-005
  it("[TC-DM-1448-01] agrees with a model of waiting, starting, ending and going away over random runs", () => {
    agreesWithModel({
      machine: TurnTicketMachine,
      records: fc
        .record({ state: fc.constantFrom(...TurnTicketState.literals), waitingOn: fc.constantFrom(null, "hob") })
        .map(({ state, waitingOn }) => ticket({ state, waitingOn: state === "waiting" ? waitingOn : null })),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalTurnTicketTransition => result instanceof IllegalTurnTicketTransition,
    });
  });

  // covers OR-005
  it("[TC-DM-1448-02] names the turn it refuses and lists its rules", () => {
    const refused = TurnTicketMachine.transition(ticket({ state: "released" }), { _tag: "Admit" });
    expect(refused).toBeInstanceOf(IllegalTurnTicketTransition);
    expect(refused).toMatchObject({ id: "thread:shire", from: "released", to: "active" });
    expect(TurnTicketMachine.table.map((row) => [row.event, row.from, row.to])).toEqual([
      ["Wait", ["waiting"], "waiting"],
      ["Admit", ["waiting"], "active"],
      ["Release", ["active"], "released"],
      ["Withdraw", ["waiting"], "withdrawn"],
    ]);
  });
});

describe("turn limits", () => {
  const active = (holder: Partial<TurnHolder>): TurnHolder => ({
    agentId: HOBS[0] as AgentId,
    runtime: "claude-code",
    quest: null,
    ...holder,
  });

  // covers OR-005
  it("[TC-DM-1448-03] names the limit a turn would go past: its hob's, its Quest's, then its runtime's", () => {
    const bounds = { perHob: 1, perQuest: 1, perRuntime: { "claude-code": 2, codex: 1 } };
    expect(limitReached(bounds, [active({})], active({}))).toBe("hob");
    expect(limitReached(bounds, [active({ quest: "q1" })], active({ agentId: HOBS[1], quest: "q1" }))).toBe("quest");
    expect(
      limitReached(bounds, [active({}), active({ agentId: HOBS[1] })], active({ agentId: HOBS[2], quest: "q2" })),
    ).toBe("runtime");
    // A turn outside any Quest counts against no Quest, and each runtime counts only its own turns.
    expect(limitReached(bounds, [active({ quest: "q1" })], active({ agentId: HOBS[1], runtime: "codex" }))).toBe(null);
    expect(limitReached(DEFAULT_TURN_LIMITS, [], active({}))).toBe(null);
  });

  // covers OR-005
  it("[TC-DM-1448-04] starts waiting turns only within every limit, the Quest served least recently first", () => {
    fc.assert(
      fc.property(
        limits,
        fc.array(holders, { maxLength: 6 }),
        fc.array(holders, { maxLength: 8 }),
        fc.dictionary(fc.constantFrom("quest:q1", "quest:q2", "quest:q3"), fc.nat(50)),
        (bounds, running, asking, servedAt) => {
          const served = new Map(Object.entries(servedAt));
          const waiting = asking.map((holder, asked) => ticket({ ...holder, id: `thread:${asked}`, asked }));
          const planned = admitInOrder(bounds, running, waiting, served);
          const started = planned.filter((each) => each.wait === null).map((each) => each.ticket);
          // Nothing starts past a limit that held before it: the running turns may already be past one.
          if (withinLimits(bounds, running)) expect(withinLimits(bounds, [...running, ...started])).toBe(true);
          // Every turn that waits could not start beside the turns that run and those that started.
          for (const { ticket: each, wait } of planned) {
            if (wait === null) continue;
            expect(limitReached(bounds, [...running, ...started], each)).not.toBe(null);
            if (wait === "fair-order") expect(limitReached(bounds, running, each)).toBe(null);
            else expect(limitReached(bounds, running, each)).toBe(wait);
          }
          // The order is the Quest served least recently, then the turn that asked first.
          const order = fairOrder(waiting, served).map((each) => [served.get(turnGroup(each)) ?? -1, each.asked]);
          expect(order).toEqual(
            [...order].sort(
              ([servedA = 0, askedA = 0], [servedB = 0, askedB = 0]) => servedA - servedB || askedA - askedB,
            ),
          );
          expect(planned.map((each) => each.ticket)).toEqual(fairOrder(waiting, served));
        },
      ),
      { numRuns: 300 },
    );
  });

  // covers OR-005
  it("[TC-DM-1448-05] gives a free slot to the Quest that waited without a turn, not the busy one that asked first", () => {
    const bounds = { perHob: 4, perQuest: 4, perRuntime: { "claude-code": 1, codex: 1 } };
    const busy = ticket({ id: "step:busy-2", quest: "busy", asked: 1 });
    const quiet = ticket({ id: "step:quiet-1", agentId: HOBS[1], quest: "quiet", asked: 2 });
    // The busy Quest started a turn at 0; the quiet one never has.
    const planned = admitInOrder(bounds, [], [busy, quiet], new Map([["quest:busy", 0]]));
    expect(planned.map(({ ticket: each, wait }) => [each.id, wait])).toEqual([
      ["step:quiet-1", null],
      ["step:busy-2", "fair-order"],
    ]);
  });
});
