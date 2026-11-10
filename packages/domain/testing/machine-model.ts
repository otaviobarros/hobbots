import { isDeepStrictEqual } from "node:util";
import * as fc from "fast-check";
import type { Machine, MachineEvent } from "../src/machine.ts";

/**
 * A small model of a machine, written apart from it: what each event does to the parts of a record
 * the model tracks, or `refused` when the machine must refuse it.
 */
export interface MachineModel<X, E, M> {
  readonly init: (record: X) => M;
  readonly step: (model: M, event: E) => M | "refused";
  /** The parts of a record the model tracks, compared after every event. Track every field a rule writes. */
  readonly view: (record: X) => M;
}

const shown = (value: unknown) => JSON.stringify(value);

/**
 * The model-based test of a machine (ADR 037): random records and runs of events, applied to the
 * machine and to its model, must agree after every event. Generate the events' own values, such as
 * their times, so a rule that drops one is caught. It throws on the first disagreement, with the run
 * that shows it, and works in any test runner. Other packages import it from
 * `@hobbots/domain/machine-testing`; it sits outside `src` because domain code imports only effect.
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
      const { machine, model, isError } = input;
      let record = start;
      let tracked = model.init(start);
      for (const event of events) {
        const fail = (why: string) => {
          throw new Error(`${machine.name} at ${shown(machine.stateOf(record))}, on ${shown(event)}: ${why}`);
        };
        const result = machine.transition(record, event);
        const next = model.step(tracked, event);
        if (machine.can(record, event) !== (next !== "refused")) fail("`can` disagrees with the model");
        if (next === "refused") {
          if (!isError(result)) fail("the machine took an event its model refuses");
          continue;
        }
        if (isError(result)) fail("the machine refused an event its model takes");
        else if (!isDeepStrictEqual(model.view(result), next))
          fail(`the machine gave ${shown(model.view(result))}, its model ${shown(next)}`);
        else {
          record = result;
          tracked = next;
        }
      }
    }),
    { numRuns: input.runs ?? 300 },
  );
