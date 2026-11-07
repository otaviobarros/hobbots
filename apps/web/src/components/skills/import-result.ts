import type { SkillScan } from "@hobbots/api";
import type { SkillId } from "@hobbots/domain";
import type { GiveTo } from "./give-choice.tsx";
import { messages } from "./messages.ts";
import { type HobDirectory, type SkillsView, scopeName, skillView } from "./skills-model.ts";

const copy = messages;

type Candidate = SkillScan["candidates"][number];

/** What a scan found, in a line: its commit and how many skills, or that a plugin comes in as one set. */
export const foundLine = (scan: SkillScan) => {
  const sets = scan.candidates.filter((one) => one.set !== null);
  if (sets.length === 1 && scan.candidates.length === 1)
    return copy.import.foundSet({ label: sets[0]?.label ?? null, commit: scan.commit });
  const found = copy.import.found({ count: scan.candidates.length, commit: scan.commit });
  return sets.length === 0 ? found : `${found} ${copy.import.setIntro}`;
};

/** What the import button says: Give again once added, Add a set by name, or how many skills it imports. */
export const importLabel = (added: boolean, onlySet: Candidate | undefined, count: number) => {
  if (added) return copy.import.giveAgain;
  if (onlySet?.set != null)
    return copy.import.addSet({ name: onlySet.name ?? onlySet.folder, count: onlySet.set.skills.length });
  return copy.import.importN({ count });
};

/**
 * What an import says once done, and where it goes: a single set opens on its page; anything else
 * opens the overview, with what an export gave out when the source was one.
 */
export const doneOf = ({
  ids,
  onlySet,
  give,
  hobs,
  fromExport,
}: {
  ids: ReadonlyArray<SkillId>;
  onlySet: Candidate | undefined;
  give: GiveTo;
  hobs: HobDirectory;
  fromExport: { readonly assigned: number; readonly leftOut: number } | null;
}): { readonly message: string; readonly at: SkillsView } => {
  const count = ids.length;
  const who = give === null ? null : scopeName(give, hobs);
  const [setId] = ids;
  if (onlySet?.set != null && count === 1 && setId !== undefined) {
    const named = { name: onlySet.name ?? onlySet.folder, count: onlySet.set.skills.length };
    const message = who === null ? copy.import.addedSet(named) : copy.import.addedSetGiven({ ...named, who });
    return { message, at: skillView(setId) };
  }
  const message =
    fromExport !== null
      ? copy.import.importedSet({ count, given: fromExport.assigned, left: fromExport.leftOut })
      : who === null
        ? copy.import.imported({ count })
        : copy.import.importedGiven({ count, who });
  return { message, at: { _tag: "Overview" } };
};
