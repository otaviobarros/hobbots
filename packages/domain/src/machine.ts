/**
 * One way to declare a lifecycle (ADR 037, STD-ARCH-013): its states, its events and, for each
 * event, the states it may start from, the state it leads to, an optional guard and how the record
 * changes. `transition` is pure and returns the next record or the machine's own error. The table is
 * exported, so tests, the diagram script (`scripts/machines.mjs`) and checks read the same rules the
 * code runs. A machine that leaves out an event of its union does not compile.
 */

/** An event a machine takes: a tagged object. */
export interface MachineEvent {
  readonly _tag: string;
}

/** One event's rule: the states it may start from, the state it leads to, and how the record changes. */
export interface MachineEdge<S extends string, X, E> {
  readonly from: ReadonlyArray<S>;
  readonly to: S;
  // Methods, not function properties, so an event's own rule fits the table of every event.
  /** A further condition, read from the record and the event only. */
  guard?(record: X, event: E): boolean;
  /** The record after the event; it must be in state `to`. */
  apply(record: X, event: E): X;
}

export interface MachineSpec<S extends string, E extends MachineEvent, X, Err> {
  /** The machine's name, as the diagrams and checks show it. */
  readonly name: string;
  readonly states: ReadonlyArray<S>;
  /** The field of the record that holds the state, which only this machine's module compares. */
  readonly field: string;
  readonly stateOf: (record: X) => S;
  /** One rule for every event of the union `E`. */
  readonly events: { readonly [K in E["_tag"]]: MachineEdge<S, X, Extract<E, { readonly _tag: K }>> };
  /** The machine's error for an event its rules refuse, with the state it would have led to. */
  readonly illegal: (record: X, event: E, to: S) => Err;
}

/** A row of the exported table: an event, where it may start and where it leads. */
export interface MachineRow<S extends string> {
  readonly event: string;
  readonly from: ReadonlyArray<S>;
  readonly to: S;
  readonly guarded: boolean;
}

export interface Machine<S extends string, E extends MachineEvent, X, Err> {
  readonly name: string;
  readonly states: ReadonlyArray<S>;
  readonly field: string;
  readonly table: ReadonlyArray<MachineRow<S>>;
  readonly stateOf: (record: X) => S;
  /** The next record, or the machine's error when its rules refuse the event. */
  readonly transition: (record: X, event: E) => X | Err;
  /** Whether the event's rules, guard included, allow it now. */
  readonly can: (record: X, event: E) => boolean;
}

export const defineMachine = <S extends string, E extends MachineEvent, X, Err>(
  spec: MachineSpec<S, E, X, Err>,
): Machine<S, E, X, Err> => {
  const rules: ReadonlyMap<string, MachineEdge<S, X, E>> = new Map(Object.entries(spec.events));
  const allows = (record: X, event: E, edge: MachineEdge<S, X, E>) =>
    edge.from.includes(spec.stateOf(record)) && (edge.guard === undefined || edge.guard(record, event));
  return {
    name: spec.name,
    states: spec.states,
    field: spec.field,
    table: [...rules].map(([event, edge]) => ({
      event,
      from: edge.from,
      to: edge.to,
      guarded: edge.guard !== undefined,
    })),
    stateOf: spec.stateOf,
    transition: (record, event) => {
      const edge = rules.get(event._tag);
      if (edge === undefined) return spec.illegal(record, event, spec.stateOf(record));
      return allows(record, event, edge) ? edge.apply(record, event) : spec.illegal(record, event, edge.to);
    },
    can: (record, event) => {
      const edge = rules.get(event._tag);
      return edge !== undefined && allows(record, event, edge);
    },
  };
};
