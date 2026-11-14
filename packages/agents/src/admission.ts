import type { AgentId, Thread } from "@hobbots/domain";
import { Context, type Effect, Layer, Semaphore } from "effect";

/**
 * One lock per hob, held while anything reads a hob's status and acts on it: starting a turn or
 * a thread, changing its status, editing it. A retirement therefore sees every turn admitted
 * before it, no turn is admitted after it, and the hob's AgentUpserted events go out in the order
 * its changes were stored. The lock is in-process, as the turns it guards are.
 */
export class HobAdmission extends Context.Service<
  HobAdmission,
  { readonly withHob: <A, E, R>(agentId: AgentId, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
>()("@hobbots/agents/HobAdmission") {
  static readonly layer = Layer.sync(HobAdmission, () => {
    const locks = new Map<AgentId, Semaphore.Semaphore>();
    const lock = (agentId: AgentId) => {
      let semaphore = locks.get(agentId);
      if (semaphore === undefined) {
        semaphore = Semaphore.makeUnsafe(1);
        locks.set(agentId, semaphore);
      }
      return semaphore;
    };
    return HobAdmission.of({ withHob: (agentId, effect) => Semaphore.withPermit(lock(agentId), effect) });
  });
}

/**
 * Runs `effect` under the lock of the hob `thread` belongs to, which every turn and message there is
 * admitted under (ADR 039), whichever hob speaks. The one place a thread's lock is named.
 */
export const withThreadLock = <A, E, R>(
  admission: HobAdmission["Service"],
  thread: Pick<Thread, "agentId">,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  // standards-allow STD-ARCH-021: a thread's lock is the hob's it belongs to
  admission.withHob(thread.agentId, effect);
