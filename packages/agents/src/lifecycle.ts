import { type AgentNotFound, HandOverRefused, HobUnavailable } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  AgentTransitions,
  type ChangeActor,
  InvalidAgentTransition,
  type RetireWork,
  type Task,
  type TaskRefused,
  takesNewWork,
  YOU,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { ApprovalService } from "./approvals.ts";
import { ChatService } from "./chat.ts";
import { GrantService } from "./grants.ts";
import { foundAgent } from "./hobs.ts";
import { EventPublisher, RetiredHobGitHubApp } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";

/**
 * Pauses, wakes, retires and brings back hobs (AG-006), each journaled with who did it, you when
 * left out (ADR 034). A hob with open Tasks can also retire by handing them to another hob, or by
 * finishing them first (#408). Nothing here deletes a hob or its threads.
 */
export class HobLifecycle extends Context.Service<
  HobLifecycle,
  {
    readonly pause: (agentId: AgentId, actor?: ChangeActor) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly wake: (agentId: AgentId, actor?: ChangeActor) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    readonly retire: (
      agentId: AgentId,
      activeWork: RetireWork,
      actor?: ChangeActor,
    ) => Effect.Effect<Agent, AgentNotFound>;
    /**
     * Stops the hob's running work, gives each of its open Tasks to `to` through Reassign, and
     * retires it (#408). Each Task keeps its history and starts afresh under `to`, so none fails.
     * Refused with nothing changed when `to` does not take new work, is the hob itself, or when any
     * open Task could not go to it by Reassign's rules. A retired hob is returned unchanged.
     */
    readonly handOver: (
      agentId: AgentId,
      to: AgentId,
      actor?: ChangeActor,
    ) => Effect.Effect<Agent, AgentNotFound | HandOverRefused>;
    /**
     * Has the hob finish its open Tasks, taking no new work, and retire once the last one ends
     * (#408); with none open it retires at once, letting running replies finish. Asking again
     * changes nothing. Refused for a retired hob.
     */
    readonly retireWhenDone: (
      agentId: AgentId,
      actor?: ChangeActor,
    ) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
    /**
     * Retires a hob that waits to retire once it has no open Task left, as whoever asked for it;
     * otherwise changes nothing. Call it when one of its Tasks ends or leaves it, and at start.
     */
    readonly finishRetiring: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Brings a retired hob back, active with all its threads. The rules and the GitHub app it lost
     * on retiring stay gone (ADR 015, ADR 022). Refused for a paused hob; an active one is unchanged.
     */
    readonly bringBack: (agentId: AgentId, actor?: ChangeActor) => Effect.Effect<Agent, AgentNotFound | HobUnavailable>;
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
      const hobApp = yield* Effect.serviceOption(RetiredHobGitHubApp);
      const tasks = yield* Effect.serviceOption(TaskRepository);
      const turns = yield* Effect.serviceOption(TaskTurns);
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const openTasks = (agentId: AgentId) =>
        Option.match(tasks, { onNone: () => Effect.succeed([]), onSome: (each) => each.listOpenTasks(agentId) });

      const findAgent = (agentId: AgentId) => repo.findAgent(agentId).pipe(Effect.flatMap(foundAgent(agentId)));

      // Saves and announces a changed status; a repeated request changes nothing and stays quiet.
      // The update only applies to the status the transition was computed from, so a stale read
      // can never undo another change, even one made by another process on the same database.
      const apply = Effect.fn("HobLifecycle.apply")(function* (
        agentId: AgentId,
        transition: (agent: Agent) => Agent | InvalidAgentTransition,
        actor: ChangeActor,
      ) {
        while (true) {
          const agent = yield* findAgent(agentId);
          const next = transition(agent);
          if (next instanceof InvalidAgentTransition) {
            return yield* new HobUnavailable({ agentId, status: next.from });
          }
          if (next.status === agent.status) return next;
          const committed = yield* repo.setAgentStatus(next, agent.status, actor);
          if (Option.isSome(committed)) {
            yield* bus.publish(committed.value.entries);
            return committed.value.value;
          }
        }
      });

      const pause = (agentId: AgentId, actor: ChangeActor = YOU) =>
        admission.withHob(agentId, apply(agentId, AgentTransitions.pause, actor));
      // Messages that queued while the hob slept start once it is awake (CH-008).
      const wake = (agentId: AgentId, actor: ChangeActor = YOU) =>
        admission
          .withHob(agentId, apply(agentId, AgentTransitions.wake, actor))
          .pipe(Effect.tap(() => chat.drainAgent(agentId)));

      // Under the hob's lock, every turn admitted before the retirement is already registered and
      // none can be admitted until the hob is retired, so "stop" reaches all of its running replies.
      // Call it holding the lock.
      const retireHeld = Effect.fn("HobLifecycle.retireHeld")(function* (
        agentId: AgentId,
        activeWork: RetireWork,
        actor: ChangeActor,
      ) {
        const at = yield* nowIso;
        const retired = yield* apply(agentId, (agent) => AgentTransitions.retire(agent, at), actor).pipe(
          // Retiring is allowed from every state, so the transition cannot be refused.
          Effect.catchTag("HobUnavailable", Effect.die),
        );
        // A reply left to finish gets no approval: what it waits for is refused.
        if (Option.isSome(approvals)) yield* approvals.value.expireForAgent(agentId);
        // A retired hob keeps none of its rules, and coming back would not restore them (ADR 015).
        if (Option.isSome(grants)) yield* grants.value.revokeForAgent(agentId, "retired");
        if (activeWork === "stop") yield* chat.interruptAgent(agentId);
        return retired;
      });

      // Outside the hob's lock, since it waits on GitHub: a retired hob keeps no app that reaches
      // your repositories, and no key (ADR 022).
      const removeApp = (agentId: AgentId) => (Option.isSome(hobApp) ? hobApp.value.remove(agentId) : Effect.void);

      const retire = Effect.fn("HobLifecycle.retire")(function* (
        agentId: AgentId,
        activeWork: RetireWork,
        actor: ChangeActor = YOU,
      ) {
        const retired = yield* admission.withHob(agentId, retireHeld(agentId, activeWork, actor));
        yield* removeApp(agentId);
        return retired;
      });

      /** Why each open Task could not go to `to`, by Reassign's rules; empty when all of them can. */
      const handOverBlocks = (open: ReadonlyArray<Task>, to: AgentId) =>
        Effect.gen(function* () {
          if (Option.isNone(tasks)) return [];
          const checked = yield* Effect.forEach(open, (task) =>
            Effect.map(tasks.value.handOverRefusal(task.id, to), (refused) => ({ task, refused })),
          );
          return checked.flatMap(({ task, refused }) => (refused === null ? [] : [{ task, refused }]));
        });

      /** Gives the Task, as it is stored now that its turn has stopped, to `to`. */
      const giveTo = (task: Task, to: AgentId, at: string) =>
        Effect.gen(function* () {
          if (Option.isNone(tasks)) return;
          const found = yield* tasks.value.readTree(task.id);
          const now = Option.isSome(found) ? found.value.tasks[0] : undefined;
          if (now === undefined || now.ownerId !== task.ownerId) return;
          const committed = yield* tasks.value.reassignTask(now.id, now.revision, to, at);
          yield* bus.publish(committed.entries);
        }).pipe(
          // A Task that could not change hands after all fails with its hob, as any retired hob's does.
          Effect.catchCause((cause) => Effect.logWarning(`Could not hand Task ${task.id} over to ${to}`, cause)),
        );

      const handOver = Effect.fn("HobLifecycle.handOver")(function* (
        agentId: AgentId,
        to: AgentId,
        actor: ChangeActor = YOU,
      ) {
        const refuse = (message: string, blocked: ReadonlyArray<{ task: Task; refused: TaskRefused }> = []) =>
          new HandOverRefused({
            agentId,
            handOverTo: to,
            message,
            tasks: blocked.map(({ task, refused }) => ({
              id: task.id,
              brief: task.brief,
              block: { reason: refused.reason, message: refused.message },
            })),
          });
        const retired = yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* findAgent(agentId);
            if (agent.status === "retired") return Option.none<Agent>();
            if (to === agentId) return yield* refuse("A hob cannot hand its work to itself.");
            const target = yield* repo.findAgent(to);
            if (Option.isNone(target) || !takesNewWork(target.value)) {
              return yield* refuse(`The hob ${to} does not take new work, so it cannot take ${agent.name}'s Tasks.`);
            }
            const open = yield* openTasks(agentId);
            const blocked = yield* handOverBlocks(open, to);
            if (blocked.length > 0) {
              return yield* refuse(`Some of ${agent.name}'s open Tasks cannot go to ${target.value.name}.`, blocked);
            }
            // Stopped while the hob is still active, a member's turn leaves its Task waiting rather
            // than failed, and no new turn can start until the lock is let go.
            yield* chat.interruptAgent(agentId);
            const at = yield* nowIso;
            yield* Effect.forEach(open, (task) => giveTo(task, to, at), { discard: true });
            return Option.some(yield* retireHeld(agentId, "stop", actor));
          }),
        );
        if (Option.isNone(retired)) return yield* findAgent(agentId);
        yield* removeApp(agentId);
        // The Tasks it handed over start under their new owner.
        if (Option.isSome(turns)) yield* turns.value.reviewTasks;
        return retired.value;
      });

      const retireWhenDone = Effect.fn("HobLifecycle.retireWhenDone")(function* (
        agentId: AgentId,
        actor: ChangeActor = YOU,
      ) {
        const outcome = yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* findAgent(agentId);
            if (agent.status === "retired") return yield* new HobUnavailable({ agentId, status: "retired" });
            if (agent.retiring !== null) return { agent, retired: false };
            if ((yield* openTasks(agentId)).length === 0) {
              return { agent: yield* retireHeld(agentId, "finish", actor), retired: true };
            }
            const committed = yield* repo.setAgentRetiring(agentId, { since: yield* nowIso, by: actor }, actor);
            if (Option.isNone(committed)) return { agent: yield* findAgent(agentId), retired: false };
            yield* bus.publish(committed.value.entries);
            return { agent: committed.value.value, retired: false };
          }),
        );
        if (outcome.retired) yield* removeApp(agentId);
        return outcome.agent;
      });

      const finishRetiring = Effect.fn("HobLifecycle.finishRetiring")(function* (agentId: AgentId) {
        const retired = yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(agentId);
            if (Option.isNone(agent) || agent.value.status === "retired" || agent.value.retiring === null) return false;
            if ((yield* openTasks(agentId)).length > 0) return false;
            yield* retireHeld(agentId, "finish", agent.value.retiring.by);
            return true;
          }).pipe(Effect.catchTag("AgentNotFound", () => Effect.succeed(false))),
        );
        if (retired) yield* removeApp(agentId);
      });

      const bringBack = (agentId: AgentId, actor: ChangeActor = YOU) =>
        admission.withHob(agentId, apply(agentId, AgentTransitions.bringBack, actor));

      return HobLifecycle.of({ pause, wake, retire, handOver, retireWhenDone, finishRetiring, bringBack });
    }),
  );
}
