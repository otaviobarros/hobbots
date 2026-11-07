import type { SkillId, SkillScope } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  assignSkill,
  editSkill,
  holdAssignment,
  importSkills,
  refreshSkills,
  removeSkill,
  rollAssignment,
  rollOutSkill,
  unassignSkill,
} from "../../api/skills.ts";

/**
 * Every change the Skills page makes, each yours: import, edit, assign, hold, roll out or back,
 * unassign and remove. Each one reads the library again, so a list, a count or a skill's page shows it
 * (STD-REACT-012).
 */
export const useSkillWrites = () => {
  const queryClient = useQueryClient();
  const onSuccess = () => refreshSkills(queryClient);
  const add = useMutation({ mutationFn: importSkills, onSuccess });
  const edit = useMutation({ mutationFn: editSkill, onSuccess });
  const assign = useMutation({ mutationFn: assignSkill, onSuccess });
  const hold = useMutation({ mutationFn: holdAssignment, onSuccess });
  const roll = useMutation({ mutationFn: rollAssignment, onSuccess });
  const rollOut = useMutation({ mutationFn: rollOutSkill, onSuccess });
  const unassign = useMutation({ mutationFn: unassignSkill, onSuccess });
  const remove = useMutation({ mutationFn: removeSkill, onSuccess });
  const all = [add, edit, assign, hold, roll, rollOut, unassign, remove];
  return { add, edit, assign, hold, roll, rollOut, unassign, remove, busy: all.some((one) => one.isPending) };
};

export type SkillWrites = ReturnType<typeof useSkillWrites>;

/**
 * Gives each skill to `scope`, true once every one has it. A skill has one assignment per scope, so
 * giving it again after a failure changes only what was not given yet.
 */
export const giveAll = async (writes: SkillWrites, skillIds: ReadonlyArray<SkillId>, scope: SkillScope) => {
  try {
    for (const skillId of skillIds) await writes.assign.mutateAsync({ skillId, scope });
    return true;
  } catch {
    return false;
  }
};
