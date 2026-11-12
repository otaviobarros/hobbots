import { BriefLog, Records } from "@hobbots/agents";
import { DecisionChangeRefused, HobbotsApi } from "@hobbots/api";
import type { DecisionRefused, ThreadId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/** A refused decision command, as the API answers it. */
const refusedIn = (threadId: ThreadId) => (refused: DecisionRefused) =>
  Effect.fail(new DecisionChangeRefused({ threadId, reason: refused.reason, message: refused.message }));

// A chat's or camp's decisions, artifacts and brief (ADR 037), for user sessions only (PE-006). A
// hub without records or briefs, as in some tests, shows none and records none.
export const RecordsHandlers = HttpApiBuilder.group(HobbotsApi, "records", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(Records);
    const briefs = yield* Effect.serviceOption(BriefLog);
    const records = Option.getOrElse(found, () =>
      Records.of({
        recordYours: () => Effect.die(new Error("This hub keeps no records.")),
        recordHobs: () => Effect.die(new Error("This hub keeps no records.")),
        crossOut: () => Effect.die(new Error("This hub keeps no records.")),
        decisionsOf: () => Effect.succeed([]),
        activeDecisions: () => Effect.succeed([]),
        artifactsOf: () => Effect.succeed([]),
      }),
    );
    return handlers.handleAll({
      decisions: ({ params }) => records.decisionsOf(params.threadId),
      recordDecision: ({ params, payload }) =>
        records
          .recordYours(params.threadId, payload)
          .pipe(Effect.catchTag("DecisionRefused", refusedIn(params.threadId))),
      crossOutDecision: ({ params }) =>
        records
          .crossOut(params.threadId, params.decisionId)
          .pipe(Effect.catchTag("DecisionRefused", refusedIn(params.threadId))),
      // Read once the thread is known, so a thread that is not there is refused.
      artifacts: ({ params }) =>
        Effect.andThen(records.decisionsOf(params.threadId), records.artifactsOf(params.threadId)),
      brief: ({ params }) =>
        Effect.andThen(
          records.decisionsOf(params.threadId),
          Option.isNone(briefs)
            ? Effect.succeed(null)
            : briefs.value.briefOf(params.threadId).pipe(Effect.map(Option.getOrNull)),
        ),
    });
  }),
);
