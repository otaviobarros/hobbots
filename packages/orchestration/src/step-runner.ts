import {
  ActivityRecorder,
  ApprovalService,
  accessNow,
  type ChatTurn,
  EventPublisher,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  MemberContinuations,
  makeRedactor,
  narrows,
  type RecoveryStep,
  recordRecovery,
  runtimeAdapters,
  SecretRedaction,
  TaskRepository,
  TaskTurns,
  type ToolAccess,
  type ToolStartedEvent,
  type TurnApprovals,
  workHeld,
} from "@hobbots/agents";
import {
  type Agent,
  type AgentConfiguration,
  type AttemptId,
  AttemptId as AttemptIdSchema,
  type CarriedItem,
  CheckpointId,
  type Committed,
  carriedFrom,
  isTerminalTask,
  type Task,
  type TaskId,
  TaskReadiness,
  type TaskToolName,
  type TaskTree,
  type TurnEnding,
} from "@hobbots/domain";
import { DateTime, Effect, FiberMap, Layer, Option, Semaphore } from "effect";
import type { PathSeparator } from "./authority.ts";
import { cut, RESULT_LIMIT, stepPrompt, stepPromptShows } from "./briefs.ts";
import { newId } from "./call-scope.ts";
import { makeCancelSettler } from "./cancels.ts";
import { delegatedAccess, makeMemberRunner } from "./members.ts";
import { type Ending, type Running, runSessionTurn, STOPPED, type StopReason } from "./session.ts";
import { TaskSignal } from "./signal.ts";
import { TaskTools } from "./task-tools.ts";
import { endTurn } from "./turn-end.ts";

/**
 * How many steps run at once (orchestration contract): per hob, and per request's tree, which is
 * its Quest's when it has one. Steps past either limit wait their turn in order.
 */
export interface StepLimits {
  readonly maxRunningStepsPerHob: number;
  readonly maxRunningStepsPerTree: number;
  /**
   * How long, in milliseconds, a session asked to stop for a cancel has to end before the cancel is
   * left unresolved (OR-006).
   */
  readonly cancelTimeoutMs: number;
}

export const DEFAULT_STEP_LIMITS: StepLimits = {
  maxRunningStepsPerHob: 2,
  maxRunningStepsPerTree: 3,
  cancelTimeoutMs: 30_000,
};

/** What a step's session may call: it reports and returns its result. It never plans, delegates or asks. */
const STEP_TOOLS: ReadonlyArray<TaskToolName> = ["report_checkpoint", "complete_task"];

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** How a step that ends without a result ends: cancelled when its cancel was asked for, failed otherwise. */
const endOf = (step: Task) => (step.state === "cancelling" ? "cancelled" : "failed");

/**
 * Runs a Task's steps (ADR 018), each in a fresh runtime session that starts from its brief alone
 * and returns checkpoints and a result to its Task, never its session. Steps start in order of
 * creation once the steps they come after have completed, within the step limits, while their hob
 * keeps answering in chat. Also serves chat turns the Task tools (`TaskTurns`).
 */
export const StepRunnerLive = (limits: StepLimits = DEFAULT_STEP_LIMITS, separator: PathSeparator = "/") =>
  Layer.effect(
    TaskTurns,
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const repo = yield* HobbotsRepository;
      const tools = yield* TaskTools;
      const signal = yield* TaskSignal;
      const held = yield* workHeld;
      const hobTools = yield* HobTools;
      const admission = yield* HobAdmission;
      const publisher = yield* EventPublisher;
      const adapters = yield* runtimeAdapters;
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      // Records what each session's turn runs and changes for the Workbench (ADR 023).
      const recorder = yield* Effect.serviceOption(ActivityRecorder);
      // Steps ask nothing, but the hob's grants answer their calls. Absent, nothing answers an Ask.
      const approvalService = yield* Effect.serviceOption(ApprovalService);
      const fibers = yield* FiberMap.make<TaskId>();
      const scope = yield* Effect.scope;
      const running = new Map<TaskId, Running>();
      const rounds = yield* Semaphore.make(1);
      // Reading a step's tools and registering it take turns with reviewing them, so a narrower
      // policy saved meanwhile never misses a step that is starting (PE-008).
      const authority = yield* Semaphore.make(1);

      const announce = <A>(committed: Committed<A>) =>
        publisher.publish(committed.entries).pipe(
          Effect.as(committed.value),
          Effect.tap(() => signal.notify),
        );
      /** A change the records may refuse, as when a step was cancelled meanwhile: logged, never fatal. */
      const attempt = <A, E>(change: Effect.Effect<Committed<A>, E>, what: string) =>
        change.pipe(
          Effect.flatMap(announce),
          Effect.asSome,
          Effect.catchCause((cause) => Effect.logWarning(`Could not ${what}`, cause).pipe(Effect.as(Option.none()))),
        );
      /** A step of startup recovery: as `attempt`, and a failure is kept for Settings › Diagnostics (ADR 026). */
      const recover = <A, E>(
        change: Effect.Effect<Committed<A>, E>,
        what: string,
        step: RecoveryStep,
        ids: { readonly taskId: TaskId; readonly attemptId: AttemptId | null },
      ) =>
        change.pipe(
          Effect.flatMap(announce),
          Effect.asSome,
          Effect.catchCause((cause) =>
            Effect.logWarning(`Could not ${what}`, cause).pipe(
              Effect.andThen(recordRecovery(step, cause, ids)),
              Effect.as(Option.none()),
            ),
          ),
        );
      const currentTask = (id: TaskId) =>
        Effect.map(
          tasks.readTree(id),
          Option.flatMap((tree) => Option.fromNullishOr(tree.tasks[0])),
        );

      // A tool call the policy allowed is recorded before it runs (EX-004), as routine progress
      // that updates the screens and never wakes anyone (IN-005).
      const recordToolStart = (step: Task) => (event: ToolStartedEvent) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          const recorded = yield* attempt(
            tasks.recordCheckpoint({
              id: CheckpointId.make(newId()),
              taskId: step.id,
              source: "unplanned",
              kind: "progress",
              milestoneId: null,
              summary: redactor.text(event.label),
              createdAt: at,
            }),
            "record a step's tool call",
          );
          return Option.isSome(recorded);
        });

      /**
       * What a step's session starts from: the tree its prompt is made from, read after the step's
       * ledger, and the items it carries, which are those of its own Task item and hand-offs that
       * prompt shows (ADR 019). A hand-off made after the ledger was read is shown but not carried,
       * so it stays open rather than settling unread.
       */
      const startingPoint = (step: Task, before: TaskTree) =>
        Effect.gen(function* () {
          const ledger = yield* tasks.readLedger(step.id);
          const tree = Option.getOrElse(yield* tasks.readTree(step.rootId), () => before);
          const carried = Option.match(ledger, {
            onNone: () => [],
            onSome: (read) => carriedFrom(read, stepPromptShows(step, tree)),
          });
          return { tree, carried };
        });

      /** The session's final reply, or why it ended without one. */
      const runSession = (
        agent: Agent,
        config: AgentConfiguration,
        step: Task,
        tree: TaskTree,
        access: ToolAccess | null,
        attemptId: AttemptId,
        carried: ReadonlyArray<CarriedItem>,
        approvals: TurnApprovals | null,
      ) =>
        runSessionTurn(
          adapters,
          redactor,
          {
            agent,
            config,
            prompt: stepPrompt(step, tree),
            attemptId,
            // A fresh session: nothing of the hob's chat or of other steps.
            sessionId: null,
            access,
            // A call the policy answers Ask for is refused, since a step has no conversation to ask in,
            // unless a grant answers it: This Task's cover every step of the Task (ADR 018).
            approvals,
            recordToolStart: recordToolStart(step),
            hubTools: tools.forTurn({ agentId: agent.id, taskId: step.id, carried }, STEP_TOOLS),
            started: (sessionId) =>
              Effect.asVoid(
                Effect.flatMap(nowIso, (at) =>
                  attempt(
                    tasks.updateAttempt(attemptId, { _tag: "Running", sessionId, at }),
                    "record a step's session",
                  ),
                ),
              ),
          },
          recorder,
        );

      /**
       * Records how the step's session ended, by the one turn-end decision (#674). A step that
       * replied completes with that reply first, unless it returned a result itself, and its Attempt
       * ends after: a restart in between finds the Attempt live and keeps the result. One that
       * replied after reporting a finding or blocker is blocked instead, so the steps after it wait
       * (#667). One that failed, was stopped or could not complete ends its Attempt, then fails, or
       * is cancelled when its cancel was asked for; a restart in between leaves it to `endStranded`.
       */
      const settle = (stepId: TaskId, attemptId: AttemptId, ending: TurnEnding, carried: ReadonlyArray<CarriedItem>) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* endTurn({ tasks, attempt }, { runner: "step", taskId: stepId, attemptId, ending, carried, at });
        });

      /** How a step's session ended, for the turn-end decision: its reply cut to a result's length. */
      const endingOf = (ending: Ending): TurnEnding =>
        ending._tag === "Failed"
          ? { _tag: "Failed", reason: ending.reason }
          : { _tag: "Replied", text: cut(redactor.text(ending.text), RESULT_LIMIT) };

      /** A stopped step: cancelled when its cancel was asked for, failed when Hobbots stopped it. */
      const stopped = (stepId: TaskId, attemptId: AttemptId, reason: StopReason | null) =>
        // Stopped with the hub: the next start finds the Attempt live and ends it.
        reason === null ? Effect.void : settle(stepId, attemptId, { _tag: "Stopped", reason: STOPPED[reason] }, []);

      // Confirms every cancel asked for once nothing runs in its Task or under it, one pass at a time.
      const cancels = yield* Semaphore.make(1);
      const settleCancels = Semaphore.withPermit(
        cancels,
        makeCancelSettler({
          tasks,
          attempt,
          timeoutMs: limits.cancelTimeoutMs,
          wake: signal.notify,
          scope,
        }),
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not confirm the cancels asked for", cause)));

      /**
       * Ends the steps left open with no live Attempt (EX-004): one Hobbots stopped while it ran,
       * or just after its session ended, fails, since what it did is not known, and one being
       * cancelled is cancelled. A step ends only once the steps under it have, so each pass ends
       * the deepest, and the passes go on until one ends nothing.
       */
      const endStranded = Effect.gen(function* () {
        for (let ending = true; ending; ) {
          ending = false;
          for (const step of yield* tasks.listStrandedSteps) {
            const tree = yield* tasks.readTree(step.rootId);
            if (
              Option.isSome(tree) &&
              tree.value.tasks.some((each) => each.parentId === step.id && !isTerminalTask(each.state))
            ) {
              continue;
            }
            const at = yield* nowIso;
            const ended = yield* recover(
              tasks.moveTask(step.id, step.revision, endOf(step), at),
              "end a step left from before a restart",
              "endStep",
              { taskId: step.id, attemptId: null },
            );
            if (Option.isNone(ended)) continue;
            ending = true;
            yield* settleCancels;
          }
        }
      });

      /** Starts one step under its hob's lock, so a retirement sees every step admitted before it. */
      const start = (queued: Task, tree: TaskTree) =>
        admission.withHob(
          queued.ownerId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(queued.ownerId);
            // A paused hob's steps wait until it wakes; a retired hob's never start.
            if (Option.isNone(agent) || agent.value.status !== "active") return;
            const config = yield* repo.findAgentConfig(agent.value.id, agent.value.configVersion);
            if (Option.isNone(config)) return;
            const attemptId = AttemptIdSchema.make(newId());
            // The step is registered and its fiber forked under one permit, so a narrower policy
            // either sees neither or can stop the fiber it finds (PE-008).
            yield* Semaphore.withPermit(
              authority,
              Effect.gen(function* () {
                // A step of a party member's Task works under every Delegation above it, as the
                // member does (ADR 018).
                const narrowed = (own: ToolAccess | null) => delegatedAccess(own, queued, tree, separator);
                const access = narrowed(yield* hobTools.access(agent.value));
                const started = yield* attempt(
                  tasks.startAttempt(queued.id, queued.revision, {
                    id: attemptId,
                    runtime: config.value.runtime,
                    sessionId: null,
                    configVersion: config.value.version,
                    policyVersion: null,
                    startedAt: yield* nowIso,
                  }),
                  "start a step",
                );
                if (Option.isNone(started)) return;
                const step = started.value.task;
                const { tree: shown, carried } = yield* startingPoint(step, tree);
                const run: Running = {
                  agentId: step.ownerId,
                  rootId: step.rootId,
                  access,
                  accessNow: Effect.map(accessNow(repo, hobTools, step.ownerId), narrowed),
                  stop: null,
                };
                running.set(step.id, run);
                const grants = Option.isSome(approvalService)
                  ? approvalService.value.forStep(step.ownerId, step.rootId, run.accessNow ?? Effect.succeed(access))
                  : null;
                yield* FiberMap.run(
                  fibers,
                  step.id,
                  runSession(agent.value, config.value, step, shown, access, attemptId, carried, grants).pipe(
                    Effect.flatMap((ending) => settle(step.id, attemptId, endingOf(ending), carried)),
                    Effect.onInterrupt(() => stopped(step.id, attemptId, run.stop)),
                    Effect.ensuring(
                      Effect.sync(() => running.delete(step.id)).pipe(
                        Effect.andThen(settleCancels),
                        Effect.andThen(signal.notify),
                      ),
                    ),
                  ),
                );
              }),
            );
          }),
        );

      const count = (pick: (run: Running) => string, value: string) =>
        Array.from(running.values()).filter((run) => pick(run) === value).length;

      // Party members' Tasks run beside the steps, in sessions this runner holds the same way.
      const memberContinuations = yield* Effect.serviceOption(MemberContinuations);
      const members = Option.isNone(memberContinuations)
        ? null
        : makeMemberRunner({
            tasks,
            repo,
            tools,
            hobTools,
            admission,
            adapters,
            redactor,
            recorder,
            approvals: approvalService,
            continuations: memberContinuations.value,
            separator,
            running,
            fibers,
            authority,
            maxRunningPerHob: limits.maxRunningStepsPerHob,
            announce,
            attempt,
            recordToolStart,
            settleCancels,
            notify: signal.notify,
          });

      /**
       * Stops running steps and members' turns whose cancel was asked for and confirms the cancels
       * that nothing runs in any more, then starts the steps that are ready and a turn on each
       * member's Task where work waits. A step that returned its result keeps running until its
       * session ends.
       */
      const round = Effect.gen(function* () {
        for (const [id, run] of running) {
          const task = yield* currentTask(id);
          if (Option.isSome(task) && task.value.state === "cancelling" && run.stop === null) {
            run.stop = "cancel";
            yield* Effect.forkIn(FiberMap.remove(fibers, id), scope);
          }
        }
        yield* settleCancels;
        // After a restore no queued step or member's turn starts until you resume work (ADR 026).
        if (yield* held) return;
        const trees = new Map<TaskId, TaskTree>();
        for (const step of yield* tasks.listQueuedSteps) {
          if (running.has(step.id)) continue;
          if (count((run) => run.agentId, step.ownerId) >= limits.maxRunningStepsPerHob) continue;
          if (count((run) => run.rootId, step.rootId) >= limits.maxRunningStepsPerTree) continue;
          const tree = trees.get(step.rootId) ?? Option.getOrUndefined(yield* tasks.readTree(step.rootId));
          if (tree === undefined) continue;
          trees.set(step.rootId, tree);
          // A step starts once every step it comes after has completed (ADR 018).
          if (TaskReadiness.of(step, tree.tasks)._tag === "Ready") yield* start(step, tree);
        }
        if (members !== null) yield* members.round;
      }).pipe(
        Semaphore.withPermit(rounds),
        Effect.catchCause((cause) => Effect.logError("Could not start or stop steps and members' turns", cause)),
      );

      // After a restart nothing runs (EX-004): every Attempt left live ends as interrupted, and
      // then every step left open without one ends, so its lead hears of it.
      for (const live of yield* tasks.listLiveAttempts) {
        const at = yield* nowIso;
        yield* recover(
          tasks.updateAttempt(live.id, {
            _tag: "Ended",
            end: { _tag: "Stopped", reason: "Hobbots stopped while this ran." },
            at,
          }),
          "end an Attempt left from before a restart",
          "endAttempt",
          { taskId: live.taskId, attemptId: live.id },
        );
      }
      yield* endStranded;

      yield* Effect.forkScoped(Effect.forever(Effect.andThen(signal.next, round)));
      yield* signal.notify;

      const stopWhere = (reason: StopReason, matches: (run: Running) => Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          const chosen = yield* Semaphore.withPermit(
            authority,
            Effect.suspend(() => Effect.filter(Array.from(running), ([, run]) => matches(run))).pipe(
              Effect.tap((found) =>
                Effect.sync(() => {
                  for (const [, run] of found) run.stop = reason;
                }),
              ),
            ),
          );
          yield* Effect.forEach(chosen, ([id]) => FiberMap.remove(fibers, id), { discard: true });
        });

      return TaskTurns.of({
        forChat: (turn: ChatTurn) => tools.forChat(turn),
        drainAgent: () => signal.notify,
        reviewTasks: signal.notify,
        interruptAgent: (agentId) => stopWhere("hob", (run) => Effect.succeed(run.agentId === agentId)),
        reviewAuthority: (agentId) =>
          stopWhere("authority", (run) =>
            agentId !== undefined && run.agentId !== agentId
              ? Effect.succeed(false)
              : Effect.map(run.accessNow ?? accessNow(repo, hobTools, run.agentId), (access) =>
                  narrows(run.access, access),
                ),
          ),
      });
    }),
  );
