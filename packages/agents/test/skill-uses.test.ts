import {
  AgentId,
  Message,
  MessageId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  SkillUse,
  SkillUseId,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { skillUseRecorder, withRecordedUses } from "../src/skill-turn.ts";
import { SkillLibrary, type SkillLibraryShape } from "../src/skills.ts";

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

  // covers ADR 029 (The use line), STD-DATA-001
  it("[TC-AG-148] gives an unfinished reply back the line of each use its turn saved before the process died", async () => {
    const reply = new Message({
      id: MessageId.make("reply"),
      threadId: ThreadId.make("t"),
      role: "assistant",
      content: "",
      status: "streaming",
      error: null,
      configVersion: 1,
      createdAt: "2026-11-06T10:00:00.000Z",
    });
    const saved = (id: string, at: string) =>
      new SkillUse({
        id: SkillUseId.make(id),
        source: "library",
        skillId: RELEASE.skillId,
        name: "release",
        pin: R4,
        number: 4,
        explicit: false,
        agentId: AgentId.make("pip"),
        threadId: reply.threadId,
        messageId: reply.id,
        at,
      });
    const asked: Array<unknown> = [];
    const library = Layer.succeed(
      SkillLibrary,
      SkillLibrary.of({
        uses: (filter) => {
          asked.push(filter);
          return Effect.succeed([saved("u2", "2026-11-06T10:00:02.000Z"), saved("u1", "2026-11-06T10:00:01.000Z")]);
        },
      } as Partial<SkillLibraryShape> as SkillLibraryShape),
    );
    const recovered = await Effect.runPromise(withRecordedUses(reply).pipe(Effect.provide(library)));
    expect(asked).toEqual([{ messageId: reply.id }]);
    expect(recovered.skillsUsed).toEqual([
      { source: "library", skillId: RELEASE.skillId, name: "release", pin: R4, number: 4, explicit: false },
    ]);
    // Once the line is there, it is not added again.
    expect(await Effect.runPromise(withRecordedUses(recovered).pipe(Effect.provide(library)))).toBe(recovered);
    // Without a library, nothing was counted, so there is nothing to put back.
    expect(await Effect.runPromise(withRecordedUses(reply))).toBe(reply);
  });
});
