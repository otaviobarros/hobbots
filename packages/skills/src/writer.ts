import { SkillWriter } from "@hobbots/agents";
import { SkillNotFound, SkillSourceUnreadable } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SkillImporter } from "./importer.ts";

/**
 * The library's writer for skills written in Hobbots (ADR 029, Import): a `SKILL.md` checked, and
 * files added, through the importer, so a skill written here meets every rule an imported one does.
 */
export const SkillWriterLive = Layer.effect(
  SkillWriter,
  Effect.gen(function* () {
    const importer = yield* SkillImporter;
    return SkillWriter.of({
      check: (files) =>
        Effect.gen(function* () {
          const scan = yield* importer.scan({ _tag: "Written", files });
          const [candidate] = scan.candidates;
          if (candidate === undefined)
            return yield* new SkillSourceUnreadable({ message: "There is no SKILL.md in it." });
          if (candidate.refusal !== null) return yield* candidate.refusal;
          if (candidate.name === null || candidate.hash === null) {
            return yield* new SkillSourceUnreadable({ message: "The SKILL.md names no skill." });
          }
          const { name, description, flags, hash, existing } = candidate;
          return { name, description: description ?? "", flags, hash, existing };
        }),
      write: (files, options) =>
        Effect.gen(function* () {
          const [added] = yield* importer.add({ _tag: "Written", files }, options);
          if (added === undefined) return yield* new SkillNotFound({ id: options.skillId ?? "SKILL.md" });
          return added;
        }),
    });
  }),
);
