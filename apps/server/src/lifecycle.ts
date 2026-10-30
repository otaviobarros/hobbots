import { AgentNotFound, HobUnavailable } from "@hobbots/api";
import { type Agent, type AgentId, AgentTransitions, InvalidAgentTransition, type RetireWork } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { ChatService } from "./chat.ts";
import { EventBus } from "./event-bus.ts";

/** Pauses, wakes and retires hobs (AG-006). Nothing here deletes a hob or its threads. */
export class HobLifecycle extends Context.Service<
  HobLifecycle,
  {
    readonly pause: (agentId: AgentId) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly wake: (agentId: AgentId) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly retire: (agentId: AgentId, activeWork: RetireWork) => Effect.Effect<Agent, AgentNotFound>;
  }
>()("@hobbots/server/HobLifecycle") {
  static readonly layer = Layer.effect(
    HobLifecycle,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventBus;
      const chat = yield* ChatService;
      const admission = yield* HobAdmission;

      const findAgent = (agentId: AgentId) =>
        repo.findAgent(agentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new AgentNotFound({ agentId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      // Saves and announces a changed status; a repeated request changes nothing and stays quiet.
      // The update only applies to the status the transition was computed from, so a stale read
      // can never undo another change, even one made by another process on the same database.
      const apply = Effect.fn("HobLifecycle.apply")(function* (
        agentId: AgentId,
        transition: (agent: Agent) => Agent | InvalidAgentTransition,
      ) {
        while (true) {
          const agent = yield* findAgent(agentId);
          const next = transition(agent);
          if (next instanceof InvalidAgentTransition) {
            return yield* new HobUnavailable({ agentId, status: next.from });
          }
          if (next.status === agent.status) return next;
          if (yield* repo.setAgentStatus(next, agent.status)) {
            yield* bus.publish({ _tag: "AgentUpserted", agent: next });
            return next;
          }
        }
      });

      const pause = (agentId: AgentId) => admission.withHob(agentId, apply(agentId, AgentTransitions.pause));
      const wake = (agentId: AgentId) => admission.withHob(agentId, apply(agentId, AgentTransitions.wake));

      // Under the hob's lock, every turn admitted before the retirement is already registered and
      // none can be admitted until the hob is retired, so "stop" reaches all of its running replies.
      const retire = Effect.fn("HobLifecycle.retire")(function* (agentId: AgentId, activeWork: RetireWork) {
        return yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* DateTime.now);
            const retired = yield* apply(agentId, (agent) => AgentTransitions.retire(agent, at)).pipe(
              // Retiring is allowed from every state, so the transition cannot be refused.
              Effect.catchTag("HobUnavailable", Effect.die),
            );
            if (activeWork === "stop") yield* chat.interruptAgent(agentId);
            return retired;
          }),
        );
      });

      return HobLifecycle.of({ pause, wake, retire });
    }),
  );
}
