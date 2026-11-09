import { type SkillDraftSource, SkillLibrary, SkillWriter } from "@hobbots/agents";
import { SkillNotFound, SkillRefused, SkillSourceUnreadable } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SkillImporter, type SkillImportSource } from "./importer.ts";
import { SkillObjects } from "./store.ts";

/**
 * The library's writer for skills written in Hobbots (ADR 029, Import): a `SKILL.md` checked, and
 * files added, through the importer, so a skill written here meets every rule an imported one does.
 * A draft to try in a chat meets the same rules, and its files go where no revision's do.
 */
export const SkillWriterLive = Layer.effect(
  SkillWriter,
  Effect.gen(function* () {
    const importer = yield* SkillImporter;
    const library = yield* SkillLibrary;
    const objects = yield* SkillObjects;

    /** The draft as a source import reads: an edit keeps every other file of its base revision. */
    const sourceOf = (draft: SkillDraftSource) =>
      Effect.gen(function* (): Effect.fn.Return<SkillImportSource, SkillNotFound | SkillRefused> {
        if (draft._tag === "Written") return draft;
        const base = yield* library.revision(draft.skillId, draft.base);
        const folder = yield* objects.folder(draft.base);
        if (base === null || folder === null) return yield* new SkillNotFound({ id: draft.base });
        if (base.set !== null) {
          return yield* new SkillRefused({
            check: "set",
            path: null,
            message: `${base.name} is a set, which changes only with a new version from its source.`,
          });
        }
        const { description, instructions } = draft;
        return {
          _tag: "Edited",
          folder,
          description,
          instructions,
          carried: { charms: base.charms, dropped: base.dropped },
        };
      });

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
      stage: (draft) =>
        Effect.gen(function* () {
          const read = yield* importer.read(yield* sourceOf(draft));
          const [found] = read.skills;
          if (found === undefined) return yield* new SkillSourceUnreadable({ message: "There is no SKILL.md in it." });
          if (found.refusal !== null) return yield* found.refusal;
          if (found.skill === null)
            return yield* new SkillSourceUnreadable({ message: "The SKILL.md names no skill." });
          const { skill } = found;
          yield* objects.putDraft(skill.hash, skill.contents);
          return { name: skill.name, description: skill.description, hash: skill.hash };
        }),
    });
  }),
);
