import {
  type ApprovalService,
  accessNow,
  type CarriedEnd,
  type CarriedWork,
  type CarryingTurn,
  type HobAdmission,
  type HobbotsRepository,
  type HobTools,
  type MemberContinuations,
  type MemberWorkWaiting,
  type Redactor,
  type runtimeAdapters,
  type TaskRepository,
  type ToolAccess,
  type ToolStartedEvent,
} from "@hobbots/agents";
import {
  type Agent,
  type AgentConfiguration,
  type AttemptId,
  AttemptId as AttemptIdSchema,
  ancestorsOf,
  type Committed,
  isTerminalTask,
  ledgerRefusal,
  ResponsibilityLedger,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { DateTime, Effect, FiberMap, Option, Semaphore } from "effect";
import { type PathSeparator, sharedFolders } from "./authority.ts";
import { memberPrompt, memberReminder } from "./briefs.ts";
import { newId } from "./call-scope.ts";
import { type Ending, type Running, runSessionTurn, STOPPED } from "./session.ts";
import type { TaskTools } from "./task-tools.ts";

/** What the member runner shares with the step runner it runs beside. */
export interface MemberDeps {
  readonly tasks: TaskRepository["Service"];
  readonly repo: HobbotsRepository["Service"];
  readonly tools: TaskTools["Service"];
  readonly hobTools: HobTools["Service"];
  readonly admission: HobAdmission["Service"];
  readonly adapters: Effect.Success<typeof runtimeAdapters>;
  readonly redactor: Redactor;
  readonly approvals: Option.Option<ApprovalService["Service"]>;
  readonly continuations: MemberContinuations["Service"];
  readonly separator: PathSeparator;
  /** The sessions running now, steps and members alike, by Task. */
  readonly running: Map<TaskId, Running>;
  readonly fibers: FiberMap.FiberMap<TaskId>;
  /** Taken while a session's tools are read and it registers, and while authority is reviewed (PE-008). */
  readonly authority: Semaphore.Semaphore;
  readonly maxRunningPerHob: number;
  readonly announce: <A>(committed: Committed<A>) => Effect.Effect<A>;
  /** A change the records may refuse: logged, never fatal. */
  readonly attempt: <A, E>(change: Effect.Effect<Committed<A>, E>, what: string) => Effect.Effect<Option.Option<A>>;
  readonly recordToolStart: (task: Task) => (event: ToolStartedEvent) => Effect.Effect<boolean>;
  /** Records why a Task cannot go on as a blocker on it. */
  readonly explain: (taskId: TaskId, reason: string, at: string) => Effect.Effect<unknown>;
  readonly confirmCancelsAbove: (task: Task) => Effect.Effect<void>;
  readonly notify: Effect.Effect<void>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * A member's tools, narrowed by every Delegation on the way down to its Task (ADR 018): each adds
 * its decisions as a restriction, and the member keeps only the folders each one allows.
 */
export const delegatedAccess = (
  access: ToolAccess | null,
  task: Task,
  tree: TaskTree,
  separator: PathSeparator,
): ToolAccess | null => {
  if (access === null) return null;
  const path = new Set<string>([task.id, ...ancestorsOf(task, tree.tasks).map((each) => each.id)]);
  const given = tree.delegations.filter((delegation) => path.has(delegation.childTaskId));
  return {
    ...access,
    policy: {
      ...access.policy,
      restrictions: [...access.policy.restrictions, ...given.map((delegation) => delegation.authority.overrides)],
    },
    folders: given.reduce<ReadonlyArray<string>>(
      (folders, delegation) =>
        delegation.authority.folders === null
          ? folders
          : sharedFolders(folders, delegation.authority.folders, separator),
      access.folders,
    ),
  };
};

/** The session the member's last turn on the Task ran in, to resume, or null before its first. */
const lastSession = (task: Task, tree: TaskTree): string | null =>
  tree.attempts
    .filter((each) => each.taskId === task.id && each.agentId === task.ownerId && each.sessionId !== null)
    .reduce<string | null>((_, each) => each.sessionId, null);

/**
 * Runs party members' Tasks (ADR 018, ADR 019). A member works on its Task in a session of its
 * own, under its own policy narrowed by the delegation, with the Task tools on its Task. Each turn
 * carries the work its owner holds under the Task, starting with the Task itself, through the
 * dispatcher, and is an Attempt of the Task. A turn that ends without the Task's result leaves it
 * waiting for what comes next, such as a hand-off from its lead or an answer, which starts the
 * next turn in the same session. A member's tool calls that need approval ask you directly, in the
 * thread of the request (PE-006).
 */
export const makeMemberRunner = (deps: MemberDeps) => {
  const { tasks, repo, running } = deps;

  /** The Task and the whole tree it sits in, as they are now. */
  const read = (taskId: TaskId) =>
    Effect.gen(function* () {
      const own = yield* tasks.readTree(taskId);
      const task = Option.isSome(own) ? own.value.tasks[0] : undefined;
      if (task === undefined) return Option.none<{ readonly task: Task; readonly tree: TaskTree }>();
      const whole = yield* tasks.readTree(task.rootId);
      return Option.map(whole, (tree) => ({ task, tree }));
    });

  const leadName = (task: Task, tree: TaskTree) =>
    Effect.gen(function* () {
      const parent = tree.tasks.find((each) => each.id === task.parentId);
      const lead = parent === undefined ? Option.none() : yield* repo.findAgent(parent.ownerId);
      return Option.match(lead, { onNone: () => "your lead", onSome: (agent) => agent.name });
    });

  /**
   * After a turn: the Attempt ends with it. Unless the turn returned the result itself, its final
   * reply completes the Task once nothing keeps it open; the first turn of a Task that comes after
   * others never does, since what it needs from them comes later, through its lead. A Task still
   * open waits, or is blocked when only its own unreported milestones keep it open, which its lead
   * then hears about.
   */
  const settle = (
    taskId: TaskId,
    attemptId: AttemptId,
    ending: Ending,
    work: CarriedWork,
    first: boolean,
  ): Effect.Effect<CarriedEnd> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const failed = ending._tag === "Failed";
      yield* deps.attempt(
        tasks.updateAttempt(attemptId, {
          state: failed ? "failed" : "completed",
          outcome: failed ? ending.reason : "The turn finished.",
          at,
        }),
        "end a member's turn",
      );
      if (ending._tag === "Failed") {
        return {
          _tag: "EndedEarly",
          end: ending.limited ? "limited" : "failed",
          diagnostic: ending.reason,
        } as CarriedEnd;
      }
      const found = yield* read(taskId);
      if (Option.isNone(found) || isTerminalTask(found.value.task.state)) return { _tag: "Handled" } as CarriedEnd;
      const { task } = found.value;
      if (task.state === "cancelling") {
        yield* deps.attempt(tasks.moveTask(task.id, task.revision, "cancelled", at), "confirm a member's cancel");
        return { _tag: "Handled" } as CarriedEnd;
      }
      if (!first || task.dependsOn.length === 0) {
        const done = yield* tasks
          .completeTask(task.id, task.revision, {
            summary: deps.redactor.text(ending.text).trim() || "The Task finished without a reply.",
            attemptId,
            artifacts: [],
            at,
            carried: work.holding,
          })
          .pipe(Effect.flatMap(deps.announce), Effect.option);
        if (Option.isSome(done)) return { _tag: "Handled" } as CarriedEnd;
      }
      yield* holdOpen(taskId, at, new Set(work.holding.map((each) => each.itemId as string)));
      return { _tag: "Handled" } as CarriedEnd;
    });

  /**
   * Leaves a Task its turn did not finish waiting, or blocked when only its own milestones keep it
   * open. The items the turn carries settle with it, so they keep nothing open.
   */
  const holdOpen = (taskId: TaskId, at: string, carried: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const found = yield* read(taskId);
      const ledger = yield* tasks.readLedger(taskId);
      if (Option.isNone(found) || Option.isNone(ledger)) return;
      const { task } = found.value;
      if (task.state !== "active" && task.state !== "waiting") return;
      const open = ledger.value.open.filter((entry) => entry._tag !== "Item" || !carried.has(entry.item.id));
      if (open.length > 0 && open.every((entry) => entry._tag === "Milestone")) {
        const refusal = ledgerRefusal(new ResponsibilityLedger({ taskId: task.id, open }));
        yield* deps.explain(task.id, refusal?.message ?? "Its milestones were not reported.", at);
        const latest = yield* read(taskId);
        if (Option.isSome(latest)) {
          const now = latest.value.task;
          yield* deps.attempt(tasks.moveTask(now.id, now.revision, "blocked", at), "block a member's Task");
        }
        return;
      }
      if (task.state === "active") {
        yield* deps.attempt(tasks.moveTask(task.id, task.revision, "waiting", at), "leave a member's Task waiting");
      }
    });

  /** A turn stopped before it ended: cancelled with its Task when that was asked for; otherwise the Task goes on later. */
  const stopped = (taskId: TaskId, attemptId: AttemptId, run: Running) =>
    Effect.gen(function* () {
      // Stopped with the hub: the next start finds the Attempt live and ends it.
      if (run.stop === null) return;
      const at = yield* nowIso;
      const found = yield* read(taskId);
      const cancelling = Option.isSome(found) && found.value.task.state === "cancelling";
      yield* deps.attempt(
        tasks.updateAttempt(attemptId, {
          state: cancelling ? "cancelled" : "interrupted",
          outcome: cancelling ? STOPPED.cancel : STOPPED[run.stop],
          at,
        }),
        "end a stopped member's turn",
      );
      const latest = yield* read(taskId);
      if (Option.isSome(latest) && latest.value.task.state === "cancelling") {
        const task = latest.value.task;
        yield* deps.attempt(tasks.moveTask(task.id, task.revision, "cancelled", at), "confirm a member's cancel");
      }
    });

  /** One turn of the member's session on its Task, carrying the work that waits there. */
  const turnOn = (taskId: TaskId, agent: Agent, config: AgentConfiguration, run: Running): CarryingTurn<AttemptId> => ({
    plan: Effect.gen(function* () {
      const found = yield* read(taskId);
      if (Option.isNone(found) || found.value.task.state === "cancelling") return null;
      const hob = yield* repo.findAgent(agent.id);
      if (Option.isNone(hob) || hob.value.status !== "active") return null;
      // A Task that ended still takes the turn's claims, so the dispatcher settles its items as late.
      return AttemptIdSchema.make(newId());
    }),
    run: (attemptId, work) =>
      Effect.gen(function* () {
        const found = yield* read(taskId);
        if (Option.isNone(found))
          return { _tag: "EndedEarly", end: "unavailable", diagnostic: "Its Task no longer exists." } as CarriedEnd;
        const { task, tree } = found.value;
        if (isTerminalTask(task.state) || task.state === "cancelling") return { _tag: "Handled" } as CarriedEnd;
        const previous = lastSession(task, tree);
        const started = yield* deps.attempt(
          tasks.startAttempt(task.id, task.revision, {
            id: attemptId,
            runtime: config.runtime,
            sessionId: previous,
            configVersion: config.version,
            policyVersion: null,
            startedAt: yield* nowIso,
          }),
          "start a member's turn",
        );
        if (Option.isNone(started)) {
          return {
            _tag: "EndedEarly",
            end: "not-accepted",
            diagnostic: "Its Task changed before the turn could start.",
          } as CarriedEnd;
        }
        const lead = yield* leadName(task, tree);
        const handle =
          Option.isNone(deps.approvals) || task.threadId === null
            ? null
            : yield* deps.approvals.value.forTurn(
                // The member's requests show in the thread of the request, as its own (PE-006).
                { agentId: agent.id, threadId: task.threadId, messageId: null, taskId: task.id },
                run.accessNow ?? Effect.succeed(run.access),
              );
        const ending = yield* runSessionTurn(deps.adapters, deps.redactor, {
          agent,
          config,
          prompt:
            previous === null
              ? memberPrompt(task, tree, lead)
              : `${work.text("prompt")}\n\n${memberReminder(task, lead)}`,
          sessionId: previous,
          access: run.access,
          approvals: handle?.approvals ?? null,
          recordToolStart: deps.recordToolStart(task),
          hubTools: deps.tools.forTurn({ agentId: agent.id, taskId: task.id, carried: work.holding }),
          started: (sessionId) =>
            work.accepted(sessionId).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((at) =>
                deps.attempt(
                  tasks.updateAttempt(attemptId, { state: "running", sessionId, at }),
                  "record a member's session",
                ),
              ),
              Effect.asVoid,
            ),
        }).pipe(Effect.ensuring(handle === null ? Effect.void : handle.close));
        return yield* settle(task.id, attemptId, ending, work, previous === null);
      }).pipe(Effect.onInterrupt(() => stopped(taskId, attemptId, run))),
  });

  /** Starts the member's turns on its Task under its hob's lock, so a retirement sees every one admitted before it. */
  const start = ({ taskId, agentId }: MemberWorkWaiting) =>
    deps.admission.withHob(
      agentId,
      Effect.gen(function* () {
        const agent = yield* repo.findAgent(agentId);
        // A paused hob's work waits until it wakes; a retired hob's never starts.
        if (Option.isNone(agent) || agent.value.status !== "active") return;
        const config = yield* repo.findAgentConfig(agent.value.id, agent.value.configVersion);
        const found = yield* read(taskId);
        if (Option.isNone(config) || Option.isNone(found)) return;
        const { task, tree } = found.value;
        const narrowed = (own: ToolAccess | null) => delegatedAccess(own, task, tree, deps.separator);
        // Registered and forked under one permit, so a narrower policy either sees neither or can
        // stop the fiber it finds (PE-008).
        yield* Semaphore.withPermit(
          deps.authority,
          Effect.gen(function* () {
            const run: Running = {
              agentId,
              rootId: task.rootId,
              access: narrowed(yield* deps.hobTools.access(agent.value)),
              accessNow: Effect.map(accessNow(repo, deps.hobTools, agentId), narrowed),
              stop: null,
            };
            running.set(taskId, run);
            yield* FiberMap.run(
              deps.fibers,
              taskId,
              deps.continuations.deliver(taskId, agentId, turnOn(taskId, agent.value, config.value, run)).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Could not run a member's turn", cause)),
                Effect.ensuring(
                  Effect.sync(() => running.delete(taskId)).pipe(
                    Effect.andThen(deps.confirmCancelsAbove(task)),
                    Effect.andThen(deps.notify),
                  ),
                ),
              ),
            );
          }),
        );
      }),
    );

  const runningFor = (agentId: string) => Array.from(running.values()).filter((run) => run.agentId === agentId).length;

  /** Starts a turn on each member's Task where work waits, one at a time per Task, within the per-hob limit. */
  const round = Effect.gen(function* () {
    for (const waiting of yield* deps.continuations.waiting) {
      if (running.has(waiting.taskId) || runningFor(waiting.agentId) >= deps.maxRunningPerHob) continue;
      yield* start(waiting);
    }
  });

  return { round };
};
