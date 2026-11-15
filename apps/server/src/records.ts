import { ArtifactContents, BriefLog, Records } from "@hobbots/agents";
import { ArtifactNotFound, ArtifactReviewChangeRefused, DecisionChangeRefused, HobbotsApi } from "@hobbots/api";
import type { ChannelId, DecisionRefused } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/** A refused decision command, as the API answers it. */
const refusedIn = (channelId: ChannelId) => (refused: DecisionRefused) =>
  Effect.fail(new DecisionChangeRefused({ channelId, reason: refused.reason, message: refused.message }));

// A chat's or camp's decisions, artifacts and brief (ADR 037), for user sessions only (PE-006). A
// hub without records or briefs, as in some tests, shows none and records none.
export const RecordsHandlers = HttpApiBuilder.group(HobbotsApi, "records", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(Records);
    const briefs = yield* Effect.serviceOption(BriefLog);
    // A hub that keeps no activity, as in some tests, has no artifact to show.
    const contents = Option.getOrElse(yield* Effect.serviceOption(ArtifactContents), () =>
      ArtifactContents.of({
        versions: (channelId, artifactId) => Effect.fail(new ArtifactNotFound({ channelId, artifactId })),
        content: (channelId, artifactId) => Effect.fail(new ArtifactNotFound({ channelId, artifactId })),
      }),
    );
    const records = Option.getOrElse(found, () =>
      Records.of({
        recordYours: () => Effect.die(new Error("This hub keeps no records.")),
        recordHobs: () => Effect.die(new Error("This hub keeps no records.")),
        crossOut: () => Effect.die(new Error("This hub keeps no records.")),
        decisionsOf: () => Effect.succeed([]),
        activeDecisions: () => Effect.succeed([]),
        artifactsOf: () => Effect.succeed([]),
        review: () => Effect.die(new Error("This hub keeps no records.")),
        waitingPullRequests: Effect.succeed([]),
        pullRequestEnded: () => Effect.succeed(null),
      }),
    );
    return handlers.handleAll({
      decisions: ({ params }) => records.decisionsOf(params.channelId),
      recordDecision: ({ params, payload }) =>
        records
          .recordYours(params.channelId, payload)
          .pipe(Effect.catchTag("DecisionRefused", refusedIn(params.channelId))),
      crossOutDecision: ({ params }) =>
        records
          .crossOut(params.channelId, params.decisionId)
          .pipe(Effect.catchTag("DecisionRefused", refusedIn(params.channelId))),
      // Read once the channel is known, so a channel that is not there is refused.
      artifacts: ({ params }) =>
        Effect.andThen(records.decisionsOf(params.channelId), records.artifactsOf(params.channelId)),
      reviewArtifact: ({ params, payload }) =>
        records.review(params.channelId, params.artifactId, payload.outcome).pipe(
          Effect.catchTag("ArtifactReviewRefused", (refused) =>
            Effect.fail(
              new ArtifactReviewChangeRefused({
                channelId: params.channelId,
                artifactId: refused.artifactId,
                reason: refused.reason,
              }),
            ),
          ),
        ),
      artifactVersions: ({ params }) => contents.versions(params.channelId, params.artifactId),
      artifactContent: ({ params }) => contents.content(params.channelId, params.artifactId, params.version),
      brief: ({ params }) =>
        Effect.andThen(
          records.decisionsOf(params.channelId),
          Option.isNone(briefs)
            ? Effect.succeed(null)
            : briefs.value.briefOf(params.channelId).pipe(Effect.map(Option.getOrNull)),
        ),
    });
  }),
);
