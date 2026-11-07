import type { AgentId } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/** Every hob's skills, the key the reads below share. */
const hobSkillsKey = ["skills", "hob"] as const;

/** A hob's skills as its next turn would get them (ADR 029), which `/` in the composer offers. */
export const hobSkillsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: [...hobSkillsKey, agentId] as const,
    queryFn: () => call((c) => c.skills.hob({ params: { agentId } })),
    staleTime: 30_000,
  });

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
