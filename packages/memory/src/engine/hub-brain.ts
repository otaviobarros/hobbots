import { byRule, decodeJudgment, HubDecider, type Judgment, judgmentText } from "@hobbots/agents";
import {
  hubTaskModel,
  MEMORY_RUNTIMES,
  type MemorySettings,
  NO_MEMORY_MODEL,
  otherMemoryProvider,
  type RuntimeKind,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { MemoryModelEndpoint } from "./model-endpoint.ts";

/** A runtime to ask, and the model on it: null for its smallest. */
interface Asked {
  readonly runtime: RuntimeKind;
  readonly model: string | null;
}

/**
 * The runtimes a judgment asks in turn: the task's model on its provider's runtime, then, with the
 * `other` fallback, the other provider's smallest. Empty with No AI, for the brain or the task.
 */
export const judgmentRuntimes = (settings: MemorySettings, judgment: Judgment<unknown>): ReadonlyArray<Asked> => {
  const chosen = hubTaskModel(settings, judgment.task);
  if (chosen === NO_MEMORY_MODEL) return [];
  const own = { runtime: MEMORY_RUNTIMES[chosen.provider], model: chosen.model };
  if (settings.fallback !== "other") return [own];
  return [own, { runtime: MEMORY_RUNTIMES[otherMemoryProvider(chosen.provider)], model: null }];
};

/**
 * `HubDecider` on the hub's brain (ADR 037): each judgment is one turn through the hub's model
 * endpoint, on the sign-in its runtime already has, as a memory task is. `settings` is read on every
 * judgment, so a change in Settings applies to the next one without a restart. A runtime that cannot
 * run the turn passes it to the fallback; a reply that does not decode, or none at all, leaves the
 * caller's rule standing.
 */
export const HubBrainDecider = (settings: Effect.Effect<MemorySettings>) =>
  Layer.effect(
    HubDecider,
    Effect.gen(function* () {
      const endpoint = yield* MemoryModelEndpoint;
      return HubDecider.of({
        decide: <A>(judgment: Judgment<A>) =>
          Effect.gen(function* () {
            const chosen = yield* settings;
            const text = judgmentText(judgment);
            for (const { runtime, model } of judgmentRuntimes(chosen, judgment)) {
              const reply = yield* endpoint.ask(runtime, model, chosen.effort, text);
              if (Option.isNone(reply)) continue;
              return Option.match(decodeJudgment(judgment, reply.value), {
                onNone: () => byRule(judgment),
                onSome: ({ choice, confidence }) => ({ choice, confidence, by: "brain" as const }),
              });
            }
            return byRule(judgment);
          }),
      });
    }),
  );
