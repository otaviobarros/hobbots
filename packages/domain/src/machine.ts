/**
 * One way to declare a lifecycle (ADR 037, STD-ARCH-013): its states, its events and each event's
 * rules. `transition` is pure and returns the next record or the machine's own error. The table is
 * exported, so tests, diagrams (`scripts/machines.mjs`) and checks read the rules the code runs. A
 * missing state or event does not compile, and rules that contradict themselves fail when defined.
 * Name a machine after the record it governs (`Task`): the comparison check looks for that import.
 */

/** An event a machine takes: a tagged object. */
export interface MachineEvent {
  readonly _tag: string;
}

/** One rule: the states it starts from, the state it leads to, and how the record changes. */
export interface MachineEdge<S extends string, X, E> {
  readonly from: ReadonlyArray<S>;
  readonly to: S;
  // Methods, not function properties, so an event's own rule fits the table of every event.
  /** A further condition, read from the record and the event only. */
  guard?(record: X, event: E): boolean;
  /** The record after the event; it must be in state `to`. */
  apply(record: X, event: E): X;
}

/**
 * An event's rules: one, or several tried in order, the first whose `from` and guard hold being taken,
 * so one event can lead to different states, such as a turn's end to idle or to the next turn.
 */
export type MachineRules<S extends string, X, E> = MachineEdge<S, X, E> | ReadonlyArray<MachineEdge<S, X, E>>;

/** The fields of a record that hold a state of `S`. */
export type StateField<X, S extends string> = { [K in keyof X]-?: X[K] extends S ? K : never }[keyof X] & string;

export interface MachineSpec<S extends string, E extends MachineEvent, X, Err> {
  /** The machine's name, as diagrams and checks show it: the name of the record it governs. */
  readonly name: string;
  /** Every state with what it means, keyed by `S`, so a state left out or not in `S` does not compile. */
  readonly states: { readonly [K in S]: string };
  /** The field of the record that holds the state, which only this machine's module compares. */
  readonly field: StateField<X, S>;
  readonly events: { readonly [K in E["_tag"]]: MachineRules<S, X, Extract<E, { readonly _tag: K }>> };
  /** The machine's error for an event its rules refuse, with the state it would have led to. */
  readonly illegal: (record: X, event: E, to: S) => Err;
}

/** A row of the exported table: one rule of an event. */
export interface MachineRow<S extends string> {
  readonly event: string;
  readonly from: ReadonlyArray<S>;
  readonly to: S;
  readonly guarded: boolean;
}

export interface Machine<S extends string, E extends MachineEvent, X, Err> {
  readonly name: string;
  /** Every state, in the order declared, and what each means. */
  readonly states: ReadonlyArray<S>;
  readonly meanings: { readonly [K in S]: string };
  readonly field: string;
  /** One row per rule, in the order declared. */
  readonly table: ReadonlyArray<MachineRow<S>>;
  readonly stateOf: (record: X) => S;
  /** The next record, or the machine's error when its rules refuse the event. */
  readonly transition: (record: X, event: E) => X | Err;
  /** Whether the event's rules, guards included, allow it now. */
  readonly can: (record: X, event: E) => boolean;
}

/**
 * A bug in a machine's declaration or use, not a refused event: rules that contradict themselves, a
 * rule that leaves the record in a state other than its `to`, or an event of no known kind. Thrown.
 */
export class MachineDefect extends Error {
  override readonly name = "MachineDefect";
}

/** Each event's rules, checked once: none may be empty, name an unknown state, or never run. */
const checkedRules = <S extends string, X, E>(name: string, states: ReadonlyArray<S>, events: object) =>
  new Map(
    Object.entries(events).map(([event, rules]: [string, MachineRules<S, X, E>]) => {
      const list: ReadonlyArray<MachineEdge<S, X, E>> = Array.isArray(rules) ? rules : [rules];
      const defect = (why: string) => new MachineDefect(`${name}: ${event} ${why}`);
      if (list.length === 0) throw defect("has no rule");
      const taken = new Set<S>(); // states an earlier unguarded rule always takes
      for (const rule of list) {
        if (rule.from.length === 0) throw defect("has a rule that starts from no state");
        const unknown = [...rule.from, rule.to].find((state) => !states.includes(state));
        if (unknown !== undefined) throw defect(`names ${unknown}, which is not a state`);
        if (rule.from.every((state) => taken.has(state)))
          throw defect("has a rule earlier unguarded rules always take first");
        if (rule.guard === undefined) for (const state of rule.from) taken.add(state);
      }
      return [event, list.map((rule) => ({ ...rule, from: Object.freeze([...rule.from]) }))] as const;
    }),
  );

export const defineMachine = <S extends string, E extends MachineEvent, X, Err>(
  spec: MachineSpec<S, E, X, Err>,
): Machine<S, E, X, Err> => {
  // An object literal, as every machine writes it, holds exactly the states of `S`.
  const states = Object.keys(spec.states).filter((key): key is S => Object.hasOwn(spec.states, key));
  const stateOf = (record: X) => record[spec.field] as S; // the field holds a state by its type
  const rules = checkedRules<S, X, E>(spec.name, states, spec.events);
  /** The rule the event takes now, and the one whose `to` a refusal names. */
  const choose = (record: X, event: E) => {
    const all = rules.get(event._tag);
    if (all === undefined) throw new MachineDefect(`${spec.name}: no rule for an event of kind ${event._tag}`);
    const from = all.filter((rule) => rule.from.includes(stateOf(record)));
    const taken = from.find((rule) => rule.guard === undefined || rule.guard(record, event));
    return { taken, refused: (from[0] ?? all[0]) as MachineEdge<S, X, E> }; // checkedRules allows no empty list
  };
  return {
    name: spec.name,
    states,
    meanings: spec.states,
    field: spec.field,
    table: Object.freeze(
      [...rules].flatMap(([event, list]) =>
        list.map((rule) => Object.freeze({ event, from: rule.from, to: rule.to, guarded: rule.guard !== undefined })),
      ),
    ),
    stateOf,
    transition: (record, event) => {
      const { taken, refused } = choose(record, event);
      if (taken === undefined) return spec.illegal(record, event, refused.to);
      const next = taken.apply(record, event);
      // The result must be in the state its row names, so the table stays true.
      if (stateOf(next) !== taken.to)
        throw new MachineDefect(
          `${spec.name}: ${event._tag} names ${taken.to} as its next state, its rule left ${stateOf(next)}`,
        );
      return next;
    },
    can: (record, event) => choose(record, event).taken !== undefined,
  };
};
