import type { SkillDetail } from "@hobbots/api";
import { skillRevisionLabel } from "@hobbots/domain";
import type { editSkill } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import type { RollOutChoice } from "./skill-rollout.tsx";

const copy = messages;

export type EditInput = Parameters<typeof editSkill>[0];

/** The holds you switched that differ from each place's now: the only ones a save changes. */
export const holdsOf = (detail: SkillDetail, choice: RollOutChoice) =>
  detail.assignments.flatMap((one) => {
    const on = choice.get(one.id);
    return on === undefined || !on === one.held ? [] : [{ assignmentId: one.id, held: !on }];
  });

/** Said once the hub answers a save: a new revision, or the same edit sent again, which finishes its rollout. */
export const savedLine = (saved: {
  added: boolean;
  revision: { number: number };
  rolledOut: ReadonlyArray<unknown>;
}) => {
  const rev = skillRevisionLabel(saved.revision);
  return saved.added || saved.rolledOut.length > 0
    ? copy.rollout.saved({ rev, count: saved.rolledOut.length })
    : copy.editor.same({ rev });
};

export const saveLabelOf = (save: { pending: boolean; finishing: boolean; moving: number; next: string }) => {
  if (save.pending) return copy.editor.saving;
  return save.finishing ? copy.editor.finish : copy.rollout.save({ count: save.moving, rev: save.next });
};
