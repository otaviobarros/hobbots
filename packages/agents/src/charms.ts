import type { AgentId } from "@hobbots/domain";
import { Context, type Effect } from "effect";
import type { HubTools, ToolAccess } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";

/** A turn that may offer Charm tools: its hob, and how to read the hob's tool access now. */
export interface CharmTurn {
  readonly agentId: AgentId;
  /** The hob's tool access now, read again for every call so a narrower policy applies to the next (PE-008). */
  readonly currentAccess: Effect.Effect<ToolAccess | null>;
  /** Redacts secrets from what a call returns, before the hob reads it. */
  readonly redactor: Redactor;
}

/**
 * The Charms a turn offers its runtime (ADR 014), served on the hub outside the sandbox, which
 * holds their credentials. The hub decides every call under the hob's policy. Absent, a turn
 * offers none.
 */
export class CharmTools extends Context.Service<
  CharmTools,
  {
    /**
     * The Charm tools the turn offers, read at its start: none (null) for a hob without the Charm
     * or while its app is not connected, so a change applies from the next turn.
     */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/CharmTools") {}

/**
 * Every tool of several sets, as one: a call goes to the set that offers its tool. A name two sets
 * offer goes to the first. Null when no set is given.
 */
export const combineHubTools = (...sets: ReadonlyArray<HubTools | null>): HubTools | null => {
  const given = sets.filter((set): set is HubTools => set !== null);
  if (given.length <= 1) return given[0] ?? null;
  const owner = new Map<string, HubTools>();
  for (const set of given) for (const tool of set.tools) if (!owner.has(tool.name)) owner.set(tool.name, set);
  const tools = given.flatMap((set) => set.tools.filter((tool) => owner.get(tool.name) === set));
  return {
    tools,
    // A tool no set offers goes to the first, which refuses it in its own words.
    call: (name, input) => (owner.get(name) ?? (given[0] as HubTools)).call(name, input),
  };
};
