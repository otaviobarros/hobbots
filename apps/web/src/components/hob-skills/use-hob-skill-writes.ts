import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hobSkillsChanged, setSkillOptOut } from "../../api/hob-skills.ts";
import { assignSkill, refreshSkills } from "../../api/skills.ts";

/**
 * What a hob's Skills tab, its profile and Summon change: give a library skill to the hob, or turn a
 * shared one off or on for it. Each reads the hob's skills and the library again (STD-REACT-012).
 */
export const useHobSkillWrites = () => {
  const queryClient = useQueryClient();
  const onSuccess = () => Promise.all([hobSkillsChanged(queryClient), refreshSkills(queryClient)]);
  const give = useMutation({ mutationFn: assignSkill, onSuccess });
  const optOut = useMutation({ mutationFn: setSkillOptOut, onSuccess });
  return { give, optOut, busy: give.isPending || optOut.isPending };
};

export type HobSkillWrites = ReturnType<typeof useHobSkillWrites>;
