import { type AgentNotFound, HobUnavailable } from "@hobbots/api";
import { type Agent, type AgentId, AgentTransitions, InvalidAgentTransition, type RetireWork } from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { ApprovalService } from "./approvals.ts";
import { ChatService } from "./chat.ts";
import { GrantService } from "./grants.ts";
import { foundAgent } from "./hobs.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/** Pauses, wakes and retires hobs (AG-006). Nothing here deletes a hob or its threads. */
export class HobLifecycle extends Context.Service<
  HobLifecycle,
  {
    readonly pause: (agentId: AgentId) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly wake: (agentId: AgentId) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly retire: (agentId: AgentId, activeWork: RetireWork) => Effect.Effect<Agent, AgentNotFound>;
  }
>()("@hobbots/agents/HobLifecycle") {
  static readonly layer = Layer.effect(
    HobLifecycle,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventPublisher;
      const chat = yield* ChatService;
      const admission = yield* HobAdmission;
      const approvals = yield* Effect.serviceOption(ApprovalService);
      const grants = yield* Effect.serviceOption(GrantService);

      const findAgent = (agentId: AgentId) => repo.findAgent(agentId).pipe(Effect.flatMap(foundAgent(agentId)));

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
          const committed = yield* repo.setAgentStatus(next, agent.status);
          if (Option.isSome(committed)) {
            yield* bus.publish(committed.value.entries);
            return committed.value.value;
          }
        }
      });

      const pause = (agentId: AgentId) => admission.withHob(agentId, apply(agentId, AgentTransitions.pause));
      // Messages that queued while the hob slept start once it is awake (CH-008).
      const wake = (agentId: AgentId) =>
        admission
          .withHob(agentId, apply(agentId, AgentTransitions.wake))
          .pipe(Effect.tap(() => chat.drainAgent(agentId)));

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
            // A reply left to finish gets no approval: what it waits for is refused.
            if (Option.isSome(approvals)) yield* approvals.value.expireForAgent(agentId);
            // A retired hob keeps none of its rules, and coming back would not restore them (ADR 015).
            if (Option.isSome(grants)) yield* grants.value.revokeForAgent(agentId, "retired");
            if (activeWork === "stop") yield* chat.interruptAgent(agentId);
            return retired;
          }),
        );
      });

      return HobLifecycle.of({ pause, wake, retire });
    }),
  );
}
