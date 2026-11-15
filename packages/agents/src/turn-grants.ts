import type { Agent, AgentId, ChannelId } from "@hobbots/domain";
import { Effect, Semaphore } from "effect";
import type { HobbotsRepository } from "./repository.ts";
import type { ToolAccess } from "./runtime.ts";
import { accessNow, type HobTools, narrows } from "./tools.ts";

/**
 * What each running chat turn was given to work with, so a narrower policy stops it. Reading a grant
 * and reviewing them take turns, so no change to the policy lands between the two unseen.
 */
export const makeTurnGrants = (repo: HobbotsRepository["Service"], hobTools: HobTools["Service"]) =>
  Effect.gen(function* () {
    const authority = yield* Semaphore.make(1);
    const granted = new Map<ChannelId, { readonly agentId: AgentId; readonly access: ToolAccess | null }>();
    const currentAccess = (agentId: AgentId) => accessNow(repo, hobTools, agentId);

    const grant = (channelId: ChannelId, agent: Agent) =>
      Semaphore.withPermit(
        authority,
        // The turn starts here, so a question about it goes to this chat (#741).
        accessNow(repo, hobTools, agent.id, { chat: { agentId: agent.id, channelId } }).pipe(
          Effect.tap((access) => Effect.sync(() => granted.set(channelId, { agentId: agent.id, access }))),
        ),
      );

    const release = (channelId: ChannelId) => Effect.sync(() => granted.delete(channelId));

    /** The channels whose turn was granted more than the hob's policy now allows. */
    const narrowed = (agentId?: AgentId) =>
      // The grants are listed once the permit is held, so a grant that was being read is listed too.
      Semaphore.withPermit(
        authority,
        Effect.suspend(() =>
          Effect.filter(
            Array.from(granted).filter(([, turn]) => agentId === undefined || turn.agentId === agentId),
            ([, turn]) => Effect.map(currentAccess(turn.agentId), (access) => narrows(turn.access, access)),
          ),
        ),
      ).pipe(Effect.map((turns) => turns.map(([channelId]) => channelId)));

    return { currentAccess, grant, release, narrowed } as const;
  });
