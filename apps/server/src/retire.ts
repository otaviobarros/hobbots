import { ApprovalService, HobbotsRepository, HobLifecycle, TaskRepository } from "@hobbots/agents";
import {
  AgentNotFound,
  type HandOverRefused,
  type HobUnavailable,
  type OpenWork,
  type RetireAgentPayload,
} from "@hobbots/api";
import type { Agent, AgentId, ChangeActor } from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Effect, Layer, Option, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

/** Retire as the payload asks: at once, handing the hob's open Tasks over, or once they are done (#408). */
export const retireAs = (
  agentId: AgentId,
  payload: RetireAgentPayload,
  actor?: ChangeActor,
): Effect.Effect<Agent, AgentNotFound | HobUnavailable | HandOverRefused, HobLifecycle> =>
  Effect.gen(function* () {
    const lifecycle = yield* HobLifecycle;
    if ("activeWork" in payload) return yield* lifecycle.retire(agentId, payload.activeWork, actor);
    return payload.openWork === "hand-over"
      ? yield* lifecycle.handOver(agentId, payload.handOverTo, actor)
      : yield* lifecycle.retireWhenDone(agentId, actor);
  });

/**
 * What the hob still has open, as Retire lists it before you choose (#408): its open Tasks, each
 * checked against `handOverTo` when one is named, the approvals its work waits on, and its open
 * backpack items.
 */
export const openWork = (agentId: AgentId, handOverTo: AgentId | undefined) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    if (Option.isNone(yield* repo.findAgent(agentId))) return yield* new AgentNotFound({ agentId });
    const tasks = yield* TaskRepository;
    const approvals = yield* ApprovalService;
    const backpack = yield* Backpack;
    const open = yield* tasks.listOpenTasks(agentId);
    const checked = yield* Effect.forEach(open, (task) =>
      handOverTo === undefined
        ? Effect.succeed({ id: task.id, brief: task.brief, state: task.state })
        : Effect.map(tasks.handOverRefusal(task.id, handOverTo), (refused) => ({
            id: task.id,
            brief: task.brief,
            state: task.state,
            handOver: refused === null ? null : { reason: refused.reason, message: refused.message },
          })),
    );
    const pending = (yield* approvals.listInbox).filter((each) => each.agentId === agentId && each.state === "pending");
    const items = yield* backpack.listOpen({ _tag: "Hob", agentId });
    return {
      agentId,
      tasks: checked,
      approvals: pending.map((each) => ({ id: each.id, label: each.label, threadId: each.threadId })),
      backpackItems: items.map((each) => ({ id: each.id, kind: each.kind, taskId: each.taskId })),
    } satisfies OpenWork;
  });

/**
 * Retires a hob finishing its open Tasks first once the last of them ends or leaves it, as it
 * happens, and at start for any whose last Task ended while the hub was down (#408).
 */
export const RetireWhenDone = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const lifecycle = yield* HobLifecycle;
    const repo = yield* HobbotsRepository;
    const subscription = yield* bus.subscribe;
    const check = (agentId: AgentId) =>
      Effect.gen(function* () {
        const hob = yield* repo.findAgent(agentId);
        if (Option.isSome(hob) && hob.value.retiring !== null) yield* lifecycle.finishRetiring(agentId);
      });
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "Journaled") return Effect.void;
        const payload = event.entry.payload;
        if (payload._tag !== "TaskStateChanged" && payload._tag !== "TaskCompleted") return Effect.void;
        const control = payload._tag === "TaskStateChanged" ? payload.control : undefined;
        const owners = control?._tag === "Reassigned" ? [payload.task.ownerId, control.from] : [payload.task.ownerId];
        return Effect.forEach(owners, check, { discard: true }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Could not retire a hob that finished its work", cause)),
        );
      }),
      Effect.forkScoped,
    );
    // Subscribed now: a hob whose last Task ended before this start retires here.
    const waiting = (yield* repo.listAgentsWithStatus(["active", "paused"])).filter((each) => each.retiring !== null);
    yield* Effect.forEach(waiting, (each) => lifecycle.finishRetiring(each.id), { discard: true });
  }),
);
