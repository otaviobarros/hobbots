import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Schedule } from "effect";

/** Deletes journal entries past retention at startup and then hourly (ADR 013). */
export const JournalCompaction = Layer.effectDiscard(
  Effect.gen(function* () {
    const journal = yield* EventJournal;
    yield* journal.compact.pipe(
      Effect.tap((deleted) => (deleted > 0 ? Effect.logDebug(`Compacted ${deleted} journal entries`) : Effect.void)),
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped,
    );
  }),
);
