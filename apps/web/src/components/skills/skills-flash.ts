import { useState } from "react";
import { type SkillsView, skillsSearchOf } from "./skills-model.ts";

/** A line the page shows after a change: what happened, and whether it worked. */
export interface SkillsFlash {
  readonly message: string;
  readonly tone: "done" | "failed";
}

/** Says a line on `at`, the view now when absent; another view drops it. */
export type Say = (flash: SkillsFlash, at?: SkillsView) => void;

/** Which view a line belongs to: a skill's tabs, its file and its editor share one, so Save shows its line on the skill. */
const keyOf = (view: SkillsView): string => {
  if (view._tag === "Skill" || view._tag === "Edit") return `skill:${view.skillId}`;
  return JSON.stringify(skillsSearchOf(view));
};

/** The line a change left, kept with the view it belongs to. */
export const useFlash = (view: SkillsView) => {
  const [flash, setFlash] = useState<{ readonly key: string; readonly flash: SkillsFlash } | null>(null);
  const say: Say = (next, at = view) => setFlash({ key: keyOf(at), flash: next });
  return { flash: flash?.key === keyOf(view) ? flash.flash : null, say };
};
