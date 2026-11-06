import type { Agent, AgentId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { agentsQuery, archivedAgentsQuery } from "../api/queries.ts";

const NO_HOBS: ReadonlyArray<Agent> = [];

/**
 * The hobs a page names: `active`, the ones you have now, and `hobs`, every hob by id, retired ones
 * included, so a record from a hob you retired still shows its name.
 */
export const useHobDirectory = () => {
  const agents = useQuery(agentsQuery);
  const archived = useQuery(archivedAgentsQuery);
  const active = agents.data ?? NO_HOBS;
  const hobs: ReadonlyMap<AgentId, Agent> = new Map<AgentId, Agent>(
    [...(archived.data ?? NO_HOBS), ...active].map((hob) => [hob.id, hob]),
  );
  return { active, hobs };
};
