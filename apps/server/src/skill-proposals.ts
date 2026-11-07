import { SkillLibrary, SkillProposalLog, type SkillReviewError, SkillReviews } from "@hobbots/agents";
import { HobbotsApi, SkillMissing, SkillProposalDecided, SkillProposalMissing } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { importError } from "./skills.ts";

/**
 * Skill proposals over HTTP (ADR 029, Proactive hobs): your reviews, which `SkillReviews` decides,
 * and a skill's notes from hobs. Without a skills library, nothing waits and nothing is decided.
 */

/** A review error in the words of the HTTP contract. */
const reviewError = (error: SkillReviewError) => {
  switch (error._tag) {
    case "SkillProposalNotFound":
      return new SkillProposalMissing({ proposalId: error.id });
    case "SkillProposalClosed":
      return new SkillProposalDecided({ proposalId: error.id, state: error.state });
    default:
      return importError(error);
  }
};

export const SkillProposalsHandlers = HttpApiBuilder.group(HobbotsApi, "skillProposals", (handlers) =>
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillReviews),
      yield* Effect.serviceOption(SkillLibrary),
      yield* Effect.serviceOption(SkillProposalLog),
    ]);
    if (Option.isNone(services)) {
      const none = ({ params }: { readonly params: { readonly proposalId: string } }) =>
        Effect.fail(new SkillProposalMissing({ proposalId: params.proposalId }));
      return handlers.handleAll({
        list: () => Effect.succeed({ proposals: [] }),
        add: none,
        check: none,
        decline: none,
        feedback: ({ params }) => Effect.fail(new SkillMissing({ id: params.skillId })),
      });
    }
    const [reviews, library, log] = services.value;
    return handlers.handleAll({
      list: () => Effect.map(reviews.list, (proposals) => ({ proposals })),
      add: ({ params, payload }) =>
        reviews.add(params.proposalId, payload.instructions).pipe(Effect.mapError(reviewError)),
      check: ({ params, payload }) =>
        reviews.check(params.proposalId, payload.instructions).pipe(Effect.mapError(reviewError)),
      decline: ({ params }) => reviews.decline(params.proposalId).pipe(Effect.mapError(reviewError)),
      feedback: ({ params }) =>
        Effect.gen(function* () {
          if ((yield* library.get(params.skillId)) === null) return yield* new SkillMissing({ id: params.skillId });
          return { feedback: yield* log.feedback(params.skillId) };
        }),
    });
  }),
);
