import * as fc from "fast-check";
import { expect } from "vitest";
import type { Machine, MachineEvent } from "../src/index.ts";

/**
 * A small, separate model of a machine: what each event does to the parts of a record the model
 * tracks, or `refused` when the machine must refuse it.
 */
export interface MachineModel<X, E, M> {
  readonly init: (record: X) => M;
  readonly step: (model: M, event: E) => M | "refused";
  /** The parts of a record the model tracks, compared after every event. */
  readonly view: (record: X) => M;
}

/**
 * The model-based test of a machine (ADR 037): random records and runs of events, applied to the
 * machine and to its model, must agree after every event. A refused event leaves the record as it
 * was, and an accepted one lands in the state its rule names.
 */
export const agreesWithModel = <S extends string, E extends MachineEvent, X, Err, M>(input: {
  readonly machine: Machine<S, E, X, Err>;
  readonly records: fc.Arbitrary<X>;
  readonly events: fc.Arbitrary<E>;
  readonly model: MachineModel<X, E, M>;
  readonly isError: (result: X | Err) => result is Err;
  readonly runs?: number;
}) =>
  fc.assert(
    fc.property(input.records, fc.array(input.events, { maxLength: 40 }), (start, events) => {
      let record = start;
      let model = input.model.init(start);
      for (const event of events) {
        const result = input.machine.transition(record, event);
        const next = input.model.step(model, event);
        expect(input.machine.can(record, event)).toBe(next !== "refused");
        if (next === "refused") {
          expect(input.isError(result)).toBe(true);
          continue;
        }
        if (input.isError(result)) throw new Error(`${input.machine.name} refused ${event._tag}, its model did not`);
        const rule = input.machine.table.find((row) => row.event === event._tag);
        expect(input.machine.stateOf(result)).toBe(rule?.to);
        expect(input.model.view(result)).toEqual(next);
        record = result;
        model = next;
      }
    }),
    { numRuns: input.runs ?? 300 },
  );
