import type { Agent } from "./agent.ts";
import type { AgentId } from "./ids.ts";

type Listed = Pick<Agent, "id" | "name" | "status" | "visibleToHobs">;

/**
 * The hobs a hob's directory lists, from the hobs as the hub holds them at the time (ADR 032):
 * every hob but the reader itself, left out when it is retired or hidden from other hobs. A hidden
 * hob still sees the others, since the switch is about being seen.
 */
export const listedForHob = <A extends Listed>(agents: ReadonlyArray<A>, reader: AgentId): ReadonlyArray<A> =>
  agents.filter((agent) => agent.id !== reader && agent.status !== "retired" && agent.visibleToHobs);

/**
 * The hobs a directory lookup by name or id finds for the reader, matched as `delegate_task` matches
 * a hob: an id first, then a name ignoring case and surrounding spaces, every hob of a shared name.
 * A hidden or retired hob is found as a name no hob has, except that the reader always finds itself.
 */
export const findInDirectory = <A extends Listed>(
  agents: ReadonlyArray<A>,
  reader: AgentId,
  hob: string,
): ReadonlyArray<A> => {
  const own = agents.filter((agent) => agent.id === reader && agent.status !== "retired");
  const seen = [...own, ...listedForHob(agents, reader)];
  const byId = seen.filter((agent) => agent.id === hob);
  if (byId.length > 0) return byId;
  const wanted = hob.trim().toLowerCase();
  return seen.filter((agent) => agent.name.trim().toLowerCase() === wanted);
};
