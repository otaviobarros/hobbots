import { AgentId, SkillId, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { skillUseRecorder } from "../src/skill-turn.ts";

const R4 = SkillRevisionHash.make("4".repeat(64));
const RELEASE = { skillId: SkillId.make("release"), name: SkillName.make("release"), pin: R4, onlyWhenAsked: false };

describe("a turn's skill uses (ADR 029, The use line)", () => {
  // covers ADR 029 (Admin policy still applies, The use line)
  it("[TC-AG-146] keeps a library skill and an organization skill of the same name apart", async () => {
    const recorded = await Effect.runPromise(
      Effect.gen(function* () {
        const uses = yield* skillUseRecorder({ agentId: AgentId.make("pip"), threadId: null, messageId: null });
        uses.given([RELEASE]);
        uses.organization(["release"]);
        return [
          yield* uses.record({ source: "organization", name: "release", explicit: false }),
          yield* uses.record({ source: "library", name: "release", explicit: false }),
          // Each counts once per turn, whichever came first.
          yield* uses.record({ source: "organization", name: "release", explicit: false }),
          yield* uses.record({ source: "library", name: "release", explicit: true }),
        ];
      }),
    );
    expect(recorded).toEqual([
      { source: "organization", skillId: null, name: "release", pin: null, number: null, explicit: false },
      { source: "library", skillId: RELEASE.skillId, name: "release", pin: R4, number: null, explicit: false },
      null,
      null,
    ]);
  });

  it("[TC-AG-147] records nothing for a source the turn did not have the skill from", async () => {
    const recorded = await Effect.runPromise(
      Effect.gen(function* () {
        const uses = yield* skillUseRecorder({ agentId: AgentId.make("pip"), threadId: null, messageId: null });
        uses.given([RELEASE]);
        uses.organization(["org-steps"]);
        return [
          yield* uses.record({ source: "organization", name: "release", explicit: false }),
          yield* uses.record({ source: "library", name: "org-steps", explicit: false }),
        ];
      }),
    );
    expect(recorded).toEqual([null, null]);
  });
});
