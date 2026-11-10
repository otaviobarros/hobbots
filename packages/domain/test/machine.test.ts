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
  stateOf: (lamp) => lamp.state,
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
      stateOf: (lamp) => lamp.state,
      // @ts-expect-error Fix has no rule.
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });

  it("does not compile when a rule leads to a state the machine does not have", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      states: { off: "Dark", on: "Lit", broken: "Needs a fix" },
      field: "state",
      stateOf: (lamp) => lamp.state,
      events: {
        // @ts-expect-error "dimmed" is not a state.
        Switch: { from: ["off"], to: "dimmed", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
        Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });

  it("does not compile when a state is left out", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      // @ts-expect-error "broken" is left out.
      states: { off: "Dark", on: "Lit" },
      field: "state",
      stateOf: (lamp) => lamp.state,
      events: {
        Switch: { from: ["off"], to: "on", apply: (lamp) => lamp },
        Break: { from: ["off"], to: "broken", apply: (lamp) => lamp },
        Fix: { from: ["broken"], to: "off", apply: (lamp) => lamp },
      },
      illegal: (lamp, _, to) => new Refused(lamp.state, to),
    });
  });

  it("does not compile when it declares a state outside its union", () => {
    defineMachine<Light, LightEvent, Lamp, Refused>({
      name: "Lamp",
      // @ts-expect-error "dimmed" is not a state.
      states: { off: "Dark", on: "Lit", broken: "Needs a fix", dimmed: "Half lit" },
      field: "state",
      stateOf: (lamp) => lamp.state,
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
      stateOf: (lamp) => lamp.state,
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
});
