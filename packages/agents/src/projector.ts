import type { EventEnvelope } from "@hobbots/domain";
import { Effect, Layer, Option, Schedule } from "effect";
import { byRule, HubDecider, type Judgment } from "./hub-decider.ts";

// What the hub's cursor projectors share (ADR 037, STD-ARCH-016): the brain they ask, or its rules
// under No AI, and a round that reads the journal after the cursor page by page until it is caught
// up, each page written with the cursor in one transaction by the projector's own store.

/** How many journal entries one page of a round reads. */
const PAGE = 200;

/** The hub's brain's `decide`, or under No AI, with no brain in the hub, every judgment's rule. */
export const hubDecide = Effect.map(Effect.serviceOption(HubDecider), (decider) =>
  Option.match(decider, {
    onNone:
      () =>
      <A>(judgment: Judgment<A>) =>
        Effect.succeed(byRule(judgment)),
    onSome: (found) => found.decide,
  }),
);

/** Where a projector reads the journal from. */
export interface ProjectorJournal {
  /** The journal sequence the projector has read through. */
  readonly cursor: Effect.Effect<number>;
  /** Committed journal entries after `sequence`, in order, at most `limit` of them. */
  readonly readAfter: (sequence: number, limit: number) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
}

/**
 * One round: each page after the cursor, until a page comes back short. `project` writes a page's
 * results and moves the cursor to `sequence`, the page's last entry, in one transaction. Answers
 * whether it caught up; whatever went wrong, the cursor did not move past it, so the next round
 * reads it again.
 */
export const projectorRound = <R>(
  name: string,
  journal: ProjectorJournal,
  project: (entries: ReadonlyArray<EventEnvelope>, sequence: number) => Effect.Effect<void, never, R>,
): Effect.Effect<boolean, never, R> => {
  const page = (cursor: number) =>
    Effect.gen(function* () {
      const entries = yield* journal.readAfter(cursor, PAGE);
      const last = entries.at(-1);
      if (last === undefined) return { cursor, caughtUp: true };
      yield* project(entries, last.sequence);
      return { cursor: last.sequence, caughtUp: entries.length < PAGE };
    });
  return Effect.gen(function* () {
    let at = { cursor: yield* journal.cursor, caughtUp: false };
    while (!at.caughtUp) at = yield* page(at.cursor);
    return true;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning(`${name} stopped a round`, cause).pipe(Effect.as(false))));
};

/** A projector's rounds, run every few seconds for as long as the layer's scope is open. */
export const runEvery = <I, E, R>(round: Effect.Effect<boolean, never, I>, make: Layer.Layer<I, E, R>) =>
  Layer.effectDiscard(round.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped, Effect.asVoid)).pipe(
    Layer.provideMerge(make),
  );
