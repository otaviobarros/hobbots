import { describe, expect, it } from "vitest";
import { defineMachine, MachineDefect } from "../src/index.ts";

type Light = "off" | "on" | "broken";
type LightEvent =
  | { readonly _tag: "Switch" }
  | { readonly _tag: "Break"; readonly hard: boolean }
  | { readonly _tag: "Fix"; readonly by: string };
interface Lamp {
  readonly state: Light;
  readonly fixedBy: string | null;
}
class Refused {
  constructor(
    readonly from: Light,
    readonly to: Light,
  ) {}
}

const LampMachine = defineMachine<Light, LightEvent, Lamp, Refused>({
  name: "Lamp",
  states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
  field: "state",
  events: {
    Switch: { from: ["off"], to: "on", apply: (lamp) => ({ ...lamp, state: "on" }) },
    Break: {
      from: ["off", "on"],
      to: "broken",
      guard: (_, e) => e.hard,
      apply: (lamp) => ({ ...lamp, state: "broken" }),
    },
    Fix: { from: ["broken"], to: "off", apply: (_, e) => ({ state: "off", fixedBy: e.by }) },
  },
  illegal: (lamp, _, to) => new Refused(lamp.state, to),
});

const off: Lamp = { state: "off", fixedBy: null };

describe("defineMachine", () => {
  it("moves a record by its event's rule", () => {
    expect(LampMachine.transition(off, { _tag: "Switch" })).toEqual({ state: "on", fixedBy: null });
  });

  it("refuses an event from a state its rule does not start from, with the state it would lead to", () => {
    expect(LampMachine.transition({ state: "on", fixedBy: null }, { _tag: "Switch" })).toEqual(new Refused("on", "on"));
  });

  it("refuses an event whose guard fails", () => {
    expect(LampMachine.transition(off, { _tag: "Break", hard: false })).toBeInstanceOf(Refused);
    expect(LampMachine.can(off, { _tag: "Break", hard: false })).toBe(false);
    expect(LampMachine.can(off, { _tag: "Break", hard: true })).toBe(true);
  });

  it("passes the event to its rule", () => {
    expect(LampMachine.transition({ state: "broken", fixedBy: null }, { _tag: "Fix", by: "Ada" })).toEqual({
      state: "off",
      fixedBy: "Ada",
    });
  });

  it("exports its table for tests, diagrams and checks", () => {
    expect(LampMachine.table).toEqual([
      { event: "Switch", from: ["off"], to: "on", guarded: false },
      { event: "Break", from: ["off", "on"], to: "broken", guarded: true },
      { event: "Fix", from: ["broken"], to: "off", guarded: false },
    ]);
    expect(LampMachine.field).toBe("state");
  });

  it("does not compile when an event has no rule", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
      field: "state",
      // @ts-expect-error Fix has no rule.
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });

  it("does not compile when a rule leads to a state the machine does not have", () => {
    const define = () =>
      defineMachine<Light, LightEvent, Lamp, Refused>({
        name: "Lamp",
        states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
        field: "state",
        events: {
          // @ts-expect-error "dimmed" is not a state.
          Switch: { from: ["off"], to: "dimmed", apply: (lamp) => lamp },
          Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
          Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
        },
        illegal: (lamp, _, to) => new Refused(lamp.state, to),
      });
    // It fails at run time too, when the declaration is made.
    expect(define).toThrow(MachineDefect);
  });

  it("does not compile when a state is left out", () => {
    const define = () =>
      defineMachine<Light, LightEvent, Lamp, Refused>({
        name: "Lamp",
        // @ts-expect-error "broken" is left out.
        states: { off: "Dark", on: "Lit" },
        field: "state",
        events: {
          Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
          Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
          Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
        },
        illegal: (lamp, _, to) => new Refused(lamp.state, to),
      });
    // It fails at run time too, when the declaration is made.
    expect(define).toThrow(MachineDefect);
  });

  it("does not compile when it declares a state outside its union", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      // @ts-expect-error "dimmed" is not a state.
      states: { off: "Dark", on: "Lit", broken: "Needs a fix", dimmed: "Half lit" },
      field: "state",
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
        Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });

  it("lists its states in the order declared, with their meanings", () => {
    expect(LampMachine.states).toEqual(["off", "on", "broken"]);
    expect(LampMachine.meanings.broken).toBe("Needs a fix");
  });

  it("throws a defect when a rule leaves the record in a state other than the one it names", () => {
    const Misdeclared = defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
      field: "state",
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
        Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
    expect(() => Misdeclared.transition(off, { _tag: "Switch" })).toThrow(
      new MachineDefect("Lamp: Switch names on as its next state, its rule left off"),
    );
  });

  describe("an event with several rules", () => {
    type Run = "idle" | "running";
    type RunEvent = { readonly _tag: "Start" } | { readonly _tag: "End"; readonly pending: boolean };
    interface Thread {
      readonly run: Run;
      readonly turns: number;
    }
    const RunMachine = defineMachine<Run, RunEvent, Thread, string>({
      name: "Thread",
      states: { idle: "No turn", running: "A turn runs" },
      field: "run",
      events: {
        Start: { from: ["idle"], to: "running", apply: (t) => ({ run: "running", turns: t.turns + 1 }) },
        End: [
          {
            from: ["running"],
            to: "running",
            guard: (_, e) => e.pending,
            apply: (t) => ({ run: "running", turns: t.turns + 1 }),
          },
          { from: ["running"], to: "idle", apply: (t) => ({ ...t, run: "idle" }) },
        ],
      },
      illegal: (t, e, to) => `${e._tag}: ${t.run} to ${to}`,
    });
    const running: Thread = { run: "running", turns: 1 };

    it("takes the first rule whose state and guard hold", () => {
      expect(RunMachine.transition(running, { _tag: "End", pending: true })).toEqual({ run: "running", turns: 2 });
      expect(RunMachine.transition(running, { _tag: "End", pending: false })).toEqual({ run: "idle", turns: 1 });
    });

    it("refuses with the first rule's next state when none starts from the record's state", () => {
      expect(RunMachine.transition({ run: "idle", turns: 0 }, { _tag: "End", pending: true })).toBe(
        "End: idle to running",
      );
    });

    it("exports one row per rule", () => {
      expect(RunMachine.table.filter((row) => row.event === "End")).toEqual([
        { event: "End", from: ["running"], to: "running", guarded: true },
        { event: "End", from: ["running"], to: "idle", guarded: false },
      ]);
    });

    it("throws a defect when an unguarded rule hides a later one", () => {
      const define = () =>
        defineMachine<Run, RunEvent, Thread, string>({
          name: "Thread",
          states: { idle: "No turn", running: "A turn runs" },
          field: "run",
          events: {
            Start: { from: ["idle"], to: "running", apply: (t) => ({ ...t, run: "running" }) },
            End: [
              { from: ["running"], to: "idle", apply: (t) => ({ ...t, run: "idle" }) },
              { from: ["running"], to: "running", guard: () => true, apply: (t) => t },
            ],
          },
          illegal: (t, e, to) => `${e._tag}: ${t.run} to ${to}`,
        });
      expect(define).toThrow(new MachineDefect("Thread: End has a rule an earlier unguarded rule always takes first"));
    });
  });

  it("throws a defect for a rule that starts from no state", () => {
    const define = () =>
      defineMachine<Light, LightEvent, Lamp, Refused>({
        name: "Lamp",
        states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
        field: "state",
        events: {
          Switch: { from: [], to: "on", apply: (lamp) => ({ ...lamp, state: "on" }) },
          Break: { from: ["off"], to: "broken", apply: (lamp) => ({ ...lamp, state: "broken" }) },
          Fix: { from: ["broken"], to: "off", apply: (lamp) => ({ ...lamp, state: "off" }) },
        },
        illegal: (lamp, _, to) => new Refused(lamp.state, to),
      });
    expect(define).toThrow(new MachineDefect("Lamp: Switch has a rule that starts from no state"));
  });

  it("throws a defect for an event of no known kind", () => {
    // @ts-expect-error Not an event of the machine.
    expect(() => LampMachine.transition(off, { _tag: "Dim" })).toThrow(MachineDefect);
  });

  it("keeps its table apart from its rules", () => {
    const row = LampMachine.table[0];
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row?.from)).toBe(true);
  });

  it("does not compile when its field does not hold a state", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
      // @ts-expect-error fixedBy does not hold a Light.
      field: "fixedBy",
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
        Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });
});
