/**
 * One way to declare a lifecycle (ADR 037, STD-ARCH-013): its states, its events and, for each
 * event, the rules it follows: the states a rule may start from, the state it leads to, an optional
 * guard and how the record changes. `transition` is pure and returns the next record or the machine's
 * own error. The table is exported, so tests, the diagram script (`scripts/machines.mjs`) and checks
 * read the same rules the code runs. A machine that leaves out a state or an event of its unions does
 * not compile, and a declaration whose rules contradict themselves fails when it is defined.
 *
 * Name a machine after the record it governs (`Task` for Task): the state-comparison check looks for
 * that name among a file's imports.
 */

/** An event a machine takes: a tagged object. */
export interface MachineEvent {
  readonly _tag: string;
}

/** One rule: the states it may start from, the state it leads to, and how the record changes. */
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
 * An event's rules: one, or several tried in order, where the first whose `from` holds the record's
 * state and whose guard passes is taken. Several rules let one event lead to different states, such as
 * a turn's end leading to idle or to the next turn.
 */
export type MachineRules<S extends string, X, E> = MachineEdge<S, X, E> | ReadonlyArray<MachineEdge<S, X, E>>;

/** The fields of a record that hold a state of `S`. */
export type StateField<X, S extends string> = {
  [K in keyof X]-?: X[K] extends S ? K : never;
}[keyof X] &
  string;

export interface MachineSpec<S extends string, E extends MachineEvent, X, Err> {
  /** The machine's name, as the diagrams and checks show it: the name of the record it governs. */
  readonly name: string;
  /**
   * Every state, each with what it means. Keyed by the state union `S`, so a state left out, or one
   * that is not in `S` written in the literal, does not compile.
   */
  readonly states: { readonly [K in S]: string };
  /** The field of the record that holds the state, which only this machine's module compares. */
  readonly field: StateField<X, S>;
  /** The rules of every event of the union `E`. */
  readonly events: { readonly [K in E["_tag"]]: MachineRules<S, X, Extract<E, { readonly _tag: K }>> };
  /** The machine's error for an event its rules refuse, with the state it would have led to. */
  readonly illegal: (record: X, event: E, to: S) => Err;
}

/** A row of the exported table: one rule of an event, where it may start and where it leads. */
export interface MachineRow<S extends string> {
  readonly event: string;
  readonly from: ReadonlyArray<S>;
  readonly to: S;
  readonly guarded: boolean;
}

export interface Machine<S extends string, E extends MachineEvent, X, Err> {
  readonly name: string;
  /** Every state, in the order the spec declares them. */
  readonly states: ReadonlyArray<S>;
  /** What each state means. */
  readonly meanings: { readonly [K in S]: string };
  readonly field: string;
  /** One row per rule, in the order the spec declares them. */
  readonly table: ReadonlyArray<MachineRow<S>>;
  readonly stateOf: (record: X) => S;
  /** The next record, or the machine's error when its rules refuse the event. */
  readonly transition: (record: X, event: E) => X | Err;
  /** Whether the event's rules, guards included, allow it now. */
  readonly can: (record: X, event: E) => boolean;
}

/**
 * A machine whose declaration or use is wrong, not an event its rules refuse: rules that contradict
 * themselves, a rule that leaves the record in a state other than its `to`, or an event of no known
 * kind. It is a bug, so it is thrown, never returned.
 */
export class MachineDefect extends Error {
  override readonly name = "MachineDefect";
}

/** Each event's rules, checked once against the states: none may be empty, unknown or unreachable. */
const checkedRules = <S extends string, X, E>(
  name: string,
  states: ReadonlyArray<S>,
  events: Readonly<Record<string, MachineRules<S, X, E>>>,
) =>
  new Map(
    Object.entries(events).map(([event, rules]) => {
      const list: ReadonlyArray<MachineEdge<S, X, E>> = Array.isArray(rules) ? rules : [rules];
      const defect = (why: string) => new MachineDefect(`${name}: ${event} ${why}`);
      if (list.length === 0) throw defect("has no rule");
      list.forEach((rule, index) => {
        if (rule.from.length === 0) throw defect("has a rule that starts from no state");
        for (const state of [...rule.from, rule.to])
          if (!states.includes(state)) throw defect(`names ${state}, which is not a state`);
        const earlier = list
          .slice(0, index)
          .find((e) => e.guard === undefined && e.from.some((s) => rule.from.includes(s)));
        if (earlier !== undefined) throw defect(`has a rule an earlier unguarded rule always takes first`);
      });
      return [event, list.map((rule) => ({ ...rule, from: Object.freeze([...rule.from]) }))] as const;
    }),
  );

export const defineMachine = <S extends string, E extends MachineEvent, X, Err>(
  spec: MachineSpec<S, E, X, Err>,
): Machine<S, E, X, Err> => {
  // The type requires every state of `S` as a key. An object literal, as every machine writes it, can
  // hold no other; one built elsewhere and passed in could, and would show as a state no rule reaches.
  const states = Object.keys(spec.states).filter((key): key is S => Object.hasOwn(spec.states, key));
  // `field` holds a state of `S` by its type, so reading it gives a state.
  const stateOf = (record: X) => record[spec.field] as S;
  const rules = checkedRules<S, X, E>(spec.name, states, spec.events);
  const rulesOf = (event: E) => {
    const list = rules.get(event._tag);
    if (list === undefined) throw new MachineDefect(`${spec.name}: no rule for an event of kind ${event._tag}`);
    return list;
  };
  /** The rule the event takes from the record's state, or the first it would have taken without its guard. */
  const choose = (record: X, event: E) => {
    const state = stateOf(record);
    const from = rulesOf(event).filter((rule) => rule.from.includes(state));
    const taken = from.find((rule) => rule.guard === undefined || rule.guard(record, event));
    // An event's first rule names where it leads when no rule starts from this state.
    const refused = (from[0] ?? rulesOf(event)[0]) as MachineEdge<S, X, E>;
    return { taken, refused };
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
      const landed = stateOf(next);
      if (landed !== taken.to)
        throw new MachineDefect(
          `${spec.name}: ${event._tag} names ${taken.to} as its next state, its rule left ${landed}`,
        );
      return next;
    },
    can: (record, event) => choose(record, event).taken !== undefined,
  };
};
