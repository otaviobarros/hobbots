import { useQuery } from "@tanstack/react-query";
import { skillsListQuery } from "../../api/skills.ts";
import { useHobDirectory } from "../../lib/use-hob-directory.ts";

/** What every view of the Skills page reads: the library, and the hobs it names. */
export const useSkills = () => {
  const list = useQuery(skillsListQuery);
  const { active, hobs } = useHobDirectory();
  return { list, active, hobs };
};

export type SkillsReads = ReturnType<typeof useSkills>;
