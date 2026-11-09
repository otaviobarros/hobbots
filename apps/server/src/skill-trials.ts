import { readSkillHealth, SkillLibrary, type SkillTrialError, SkillTrials } from "@hobbots/agents";
import { HobbotsApi, SkillDraftGone, SkillProposalMissing, SkillSourceNotRead } from "@hobbots/api";
import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { importError, workingHobSkills } from "./skills.ts";

/**
 * Try in a chat and the Overview's health checks over HTTP (ADR 029, #1099). Without a skills
 * library there is no draft to try and nothing to check.
 */

/** A trial's error in the words of the HTTP contract. */
const trialError = (error: SkillTrialError) => {
  switch (error._tag) {
    case "SkillProposalNotFound":
      return new SkillProposalMissing({ proposalId: error.id });
    case "AgentNotFound":
    case "HobUnavailable":
      return error;
    default:
      return importError(error);
  }
};

export const SkillTrialsHandlers = HttpApiBuilder.group(HobbotsApi, "skillTrials", (handlers) =>
  Effect.gen(function* () {
    const trials = yield* Effect.serviceOption(SkillTrials);
    return handlers
      .handle("start", ({ payload }) =>
        Option.isNone(trials)
          ? Effect.fail(new SkillSourceNotRead({ message: "This hub has no skills library." }))
          : trials.value.start(payload.agentId, payload.draft).pipe(Effect.mapError(trialError)),
      )
      .handle("draft", ({ params }) =>
        Option.isNone(trials)
          ? Effect.fail(new SkillDraftGone({ threadId: params.threadId }))
          : trials.value.draft(params.threadId),
      );
  }),
);

const NOTHING = { unused: [], behind: [], clashes: [], descriptions: [], loads: [] };

export const SkillHealthHandlers = HttpApiBuilder.group(HobbotsApi, "skillHealth", (handlers) =>
  Effect.gen(function* () {
    const library = yield* Effect.serviceOption(SkillLibrary);
    const working = yield* workingHobSkills;
    return handlers.handle("get", () =>
      Effect.gen(function* () {
        if (Option.isNone(library)) return NOTHING;
        const hobs = (yield* working).map(({ agent, resolved }) => ({
          agentId: agent.id,
          runtime: agent.runtime,
          resolved,
        }));
        return yield* readSkillHealth(library.value, hobs, DateTime.formatIso(yield* DateTime.now));
      }),
    );
  }),
);
