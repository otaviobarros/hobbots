import type { AgentId } from "@hobbots/domain";
import { queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/** A hob's skills as its next turn would get them (ADR 029), which `/` in the composer offers. */
export const hobSkillsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: ["skills", "hob", agentId] as const,
    queryFn: () => call((c) => c.skills.hob({ params: { agentId } })),
    staleTime: 30_000,
  });
