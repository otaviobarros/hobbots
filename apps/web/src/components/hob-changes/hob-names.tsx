import type { Agent, AgentId, HobChange } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { agentsQuery, archivedAgentsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";

/**
 * Every hob the changes name, live or retired, by id. The retired ones are read only when a change
 * names a hob that is not live.
 */
export const useHobsNamed = (ids: ReadonlyArray<AgentId>): ReadonlyMap<AgentId, Agent> => {
  const live = useQuery(agentsQuery);
  const missing = live.isSuccess && ids.some((id) => !live.data.some((hob) => hob.id === id));
  const retired = useQuery({ ...archivedAgentsQuery, enabled: missing });
  return new Map([...(retired.data ?? []), ...(live.data ?? [])].map((hob) => [hob.id, hob]));
};

/** The ids of the hobs a list of changes names: each target, and each hob behind a change. */
export const namedIn = (changes: ReadonlyArray<HobChange>): ReadonlyArray<AgentId> => [
  ...new Set(changes.flatMap((change) => [change.hobId, ...(change.actor._tag === "You" ? [] : [change.actor.hobId])])),
];

/** A hob's name as a link to its profile, or "another hob" for one no longer kept. */
export function HobName({ hobId, hobs }: { hobId: AgentId; hobs: ReadonlyMap<AgentId, Agent> }) {
  const hob = hobs.get(hobId);
  if (hob === undefined) return <>{messages.someHob}</>;
  return (
    <Link
      to="/hobs/$hobId/profile"
      params={{ hobId }}
      className="font-semibold text-text-strong underline-offset-2 hover:underline"
    >
      {hob.name}
    </Link>
  );
}

/** A sentence that names a hob, with the name a link to the hob's profile. */
export function NamingHob({
  hobId,
  hobs,
  line,
}: {
  hobId: AgentId;
  hobs: ReadonlyMap<AgentId, Agent>;
  /** The sentence, given the hob's name. */
  line: (name: string) => string;
}) {
  const name = hobs.get(hobId)?.name ?? messages.someHob;
  const [before, ...after] = line(name).split(name);
  return (
    <span>
      {before}
      <HobName hobId={hobId} hobs={hobs} />
      {after.join(name)}
    </span>
  );
}
