import type { HobSkills } from "@hobbots/api";
import type { AgentId, SkillId, SkillName } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";
import { watchedSetupQuery } from "./setup.ts";

/** Every hob's skills, the key the reads below share. */
const hobSkillsKey = ["skills", "hob"] as const;

/**
 * A hob's skills as its next turn would get them (ADR 029), which `/` in the composer offers. Which
 * a hob gets depends on the folders it works in, from its configuration and the setup's shared
 * folders, so `basis` names those and a change to any of them reads it again; until then the list
 * keeps what it showed.
 */
export const hobSkillsQuery = (agentId: AgentId, basis: ReadonlyArray<unknown> = []) =>
  queryOptions({
    queryKey: [...hobSkillsKey, agentId, ...basis] as const,
    queryFn: () => call((c) => c.skills.hob({ params: { agentId } })),
    staleTime: 30_000,
    placeholderData: (previous: HobSkills | undefined) => previous,
  });

/**
 * The hob's skills, read again when its configuration version changes, as a change to its folders
 * from another window makes it, or when the shared folders the setup holds do. The setup is watched,
 * since no event tells this window that another changed the shared folders.
 */
export const useHobSkills = (agentId: AgentId, configVersion: number | undefined) => {
  const setup = useQuery(watchedSetupQuery);
  const basis = [configVersion, ...(setup.data?.approvedFolders ?? [])];
  return useQuery(hobSkillsQuery(agentId, basis));
};

/**
 * A skill was added, assigned, rolled out, held, opted out of, or taken off, here or elsewhere: any
 * hob may now get other skills, so every hob's are read again, and the `/` list offers what its
 * next turn would get. A read in flight may have been taken before the change, so it is cancelled
 * first (STD-REACT-012).
 */
export const hobSkillsChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: hobSkillsKey });
  await queryClient.invalidateQueries({ queryKey: hobSkillsKey });
};

/** Turns a shared skill off for one hob, or on again (ADR 029, Scopes). */
export const setSkillOptOut = (input: {
  agentId: AgentId;
  skillId: SkillId;
  optedOut: boolean;
  /** For a set, the one of its skills to turn off or on (ADR 029, Skill sets). */
  member?: SkillName;
}) =>
  call((c) =>
    c.skills.optOut({
      params: { agentId: input.agentId, skillId: input.skillId },
      payload: { optedOut: input.optedOut, ...(input.member === undefined ? {} : { member: input.member }) },
    }),
  );
