import {
  accessNow,
  type ChatTurn,
  EventPublisher,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  makeRedactor,
  narrows,
  runtimeAdapters,
  SecretRedaction,
  TaskRepository,
  TaskTurns,
  type ToolAccess,
  type ToolStartedEvent,
} from "@hobbots/agents";
import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type AttemptId,
  AttemptId as AttemptIdSchema,
  type CarriedItem,
  CheckpointId,
  type Committed,
  carriedFrom,
  descendantsOf,
  isLiveAttempt,
  isTerminalTask,
  RUNTIME_NAMES,
  systemInstructions,
  type Task,
  type TaskId,
  type TaskToolName,
  type TaskTree,
} from "@hobbots/domain";
import { DateTime, Effect, FiberMap, Layer, Option, Semaphore, Stream } from "effect";
import { cut, RESULT_LIMIT, stepPrompt, stepPromptShows } from "./briefs.ts";
import { newId } from "./call-scope.ts";
import { TaskSignal } from "./signal.ts";
import { TaskTools } from "./task-tools.ts";

/**
 * How many steps run at once (orchestration contract): per hob, and per request's tree, which is
 * its Quest's when it has one. Steps past either limit wait their turn in order.
 */
export interface StepLimits {
  readonly maxRunningStepsPerHob: number;
  readonly maxRunningStepsPerTree: number;
}

export const DEFAULT_STEP_LIMITS: StepLimits = { maxRunningStepsPerHob: 2, maxRunningStepsPerTree: 3 };

/** What a step's session may call: it reports and returns its result. It never plans, delegates or asks. */
const STEP_TOOLS: ReadonlyArray<TaskToolName> = ["report_checkpoint", "complete_task"];

/** Why a running step was stopped, which decides what its Task becomes. */
type StopReason = "cancel" | "authority" | "hob";

const STOPPED: Record<StopReason, string> = {
  cancel: "Cancelled.",
  authority: "Stopped because its hob's permissions were narrowed.",
  hob: "Stopped by Hobbots before it finished, with its hob's other work.",
};

interface Running {
  readonly agentId: AgentId;
  readonly rootId: TaskId;
  readonly access: ToolAccess | null;
  stop: StopReason | null;
}

/** How a step's session ended: with a final reply, or failed with a reason. */
type Ending =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** How a step that ends without a result ends: cancelled when its cancel was asked for, failed otherwise. */
const endOf = (step: Task) => (step.state === "cancelling" ? "cancelled" : "failed");

/** Every Task `step` comes after has completed. */
const ready = (step: Task, tree: TaskTree) =>
  step.dependsOn.every((id) => tree.tasks.find((each) => each.id === id)?.state === "completed");

/**
 * Runs a Task's steps (ADR 018), each in a fresh runtime session that starts from its brief alone
 * and returns checkpoints and a result to its Task, never its session. Steps start in order of
 * creation once the steps they come after have completed, within the step limits, while their hob
 * keeps answering in chat. Also serves chat turns the Task tools (`TaskTurns`).
 */
export const StepRunnerLive = (limits: StepLimits = DEFAULT_STEP_LIMITS) =>
  Layer.effect(
    TaskTurns,
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const repo = yield* HobbotsRepository;
      const tools = yield* TaskTools;
      const signal = yield* TaskSignal;
      const hobTools = yield* HobTools;
      const admission = yield* HobAdmission;
      const publisher = yield* EventPublisher;
      const adapters = yield* runtimeAdapters;
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
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
      ) =>
        Effect.gen(function* () {
          const adapter = adapters(config.runtime);
          if (adapter === undefined) {
            return {
              _tag: "Failed",
              reason: `Hobbots cannot run ${RUNTIME_NAMES[config.runtime]} on this hub.`,
            } as Ending;
          }
          let ending: Ending = { _tag: "Failed", reason: "The runtime ended without a result." };
          yield* adapter
            .sendPrompt({
              prompt: stepPrompt(step, tree),
              briefing: null,
              // A fresh session: nothing of the hob's chat or of other steps.
              sessionId: null,
              instructions: systemInstructions(agent.name, config),
              instructionsChanged: false,
              model: config.model,
              effort: config.effort,
              tools: access,
              // A call the policy answers Ask for is refused: a step has no conversation to ask in.
              approvals: null,
              redaction: redactor,
              recordToolStart: recordToolStart(step),
              hubTools: tools.forTurn({ agentId: agent.id, taskId: step.id, carried }, STEP_TOOLS),
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event._tag === "SessionStarted") {
                    const at = yield* nowIso;
                    yield* attempt(
                      tasks.updateAttempt(attemptId, { state: "running", sessionId: event.sessionId, at }),
                      "record a step's session",
                    );
                  } else if (event._tag === "Completed") {
                    ending = { _tag: "Replied", text: event.text };
                  }
                }),
              ),
              Effect.catchTags({
                RuntimeError: (error) =>
                  Effect.sync(() => {
                    ending = { _tag: "Failed", reason: redactor.text(error.message) };
                  }),
                RuntimeLimitReached: (error) =>
                  Effect.sync(() => {
                    ending = {
                      _tag: "Failed",
                      reason: `The usage limit was reached; it resets at ${error.resetsAt}.`,
                    };
                  }),
              }),
            );
          return ending;
        });

      /** Records why a step could not complete as a blocker on it, so its failure says what was left open. */
      const explain = (stepId: TaskId, reason: string, at: string) =>
        attempt(
          tasks.recordCheckpoint({
            id: CheckpointId.make(newId()),
            taskId: stepId,
            source: "unplanned",
            kind: "blocker",
            milestoneId: null,
            summary: cut(reason, RESULT_LIMIT),
            createdAt: at,
          }),
          "record why a step could not complete",
        );

      /**
       * Records how the step's session ended. A step that replied completes with that reply first,
       * unless it returned a result itself, and its Attempt ends after: a restart in between finds
       * the Attempt live and keeps the result. A step that failed ends its Attempt first, as ending
       * a Task needs, and then fails; a restart in between leaves it to `endStranded`.
       */
      const settle = (stepId: TaskId, attemptId: AttemptId, ending: Ending, carried: ReadonlyArray<CarriedItem>) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          const completed =
            ending._tag === "Replied" ? yield* complete(stepId, attemptId, ending.text, carried, at) : false;
          yield* attempt(
            tasks.updateAttempt(attemptId, {
              state: ending._tag === "Failed" ? "failed" : "completed",
              outcome: ending._tag === "Failed" ? ending.reason : "The step's session finished.",
              at,
            }),
            "end a step's Attempt",
          );
          if (completed) return;
          const latest = yield* currentTask(stepId);
          if (Option.isNone(latest) || isTerminalTask(latest.value.state)) return;
          yield* attempt(tasks.moveTask(stepId, latest.value.revision, endOf(latest.value), at), "end a step");
        });

      /**
       * Completes a step with its session's final reply, unless it has ended or is being cancelled.
       * Whether the step has ended now, by this completion or before it.
       */
      const complete = (
        stepId: TaskId,
        attemptId: AttemptId,
        text: string,
        carried: ReadonlyArray<CarriedItem>,
        at: string,
      ) =>
        Effect.gen(function* () {
          const task = yield* currentTask(stepId);
          if (Option.isNone(task) || isTerminalTask(task.value.state)) return true;
          const step = task.value;
          if (step.state === "cancelling") return false;
          const done = yield* attempt(
            tasks
              .completeTask(step.id, step.revision, {
                summary: cut(redactor.text(text), RESULT_LIMIT) || "The step finished without a reply.",
                attemptId,
                artifacts: [],
                at,
                carried,
              })
              .pipe(
                Effect.tapError((error) =>
                  error._tag === "TaskRefused" ? explain(step.id, error.message, at) : Effect.void,
                ),
              ),
            "complete a step",
          );
          return Option.isSome(done);
        });

      /** A stopped step: cancelled when its cancel was asked for, failed when Hobbots stopped it. */
      const stopped = (stepId: TaskId, attemptId: AttemptId, reason: StopReason | null) =>
        Effect.gen(function* () {
          // Stopped with the hub: the next start finds the Attempt live and ends it.
          if (reason === null) return;
          const at = yield* nowIso;
          const task = yield* currentTask(stepId);
          const cancelling = Option.isSome(task) && task.value.state === "cancelling";
          yield* attempt(
            tasks.updateAttempt(attemptId, {
              state: cancelling ? "cancelled" : "interrupted",
              outcome: cancelling ? STOPPED.cancel : STOPPED[reason],
              at,
            }),
            "end a stopped step's Attempt",
          );
          const latest = yield* currentTask(stepId);
          if (Option.isNone(latest) || isTerminalTask(latest.value.state)) return;
          yield* attempt(tasks.moveTask(stepId, latest.value.revision, endOf(latest.value), at), "end a stopped step");
        });

      /**
       * Confirms the cancel of each Task above `step` that is cancelling and has nothing left
       * running: no live Attempt and nothing open under it.
       */
      const confirmCancelsAbove = (step: Task): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (let parentId = step.parentId; parentId !== null; ) {
            const found = yield* tasks.readTree(step.rootId);
            if (Option.isNone(found)) return;
            const { tasks: tree, attempts } = found.value;
            const above = tree.find((each) => each.id === parentId);
            if (above === undefined || above.state !== "cancelling") return;
            const live = attempts.some((each) => each.id === above.currentAttemptId && isLiveAttempt(each.state));
            if (live || descendantsOf(above, tree).some((each) => !isTerminalTask(each.state))) return;
            const at = yield* nowIso;
            const confirmed = yield* attempt(
              tasks.moveTask(above.id, above.revision, "cancelled", at),
              "confirm a cancel above a step",
            );
            if (Option.isNone(confirmed)) return;
            parentId = above.parentId;
          }
        });

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
            const ended = yield* attempt(
              tasks.moveTask(step.id, step.revision, endOf(step), at),
              "end a step left from before a restart",
            );
            if (Option.isNone(ended)) continue;
            ending = true;
            yield* confirmCancelsAbove(step);
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
                const access = yield* hobTools.access(agent.value);
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
                const run: Running = { agentId: step.ownerId, rootId: step.rootId, access, stop: null };
                running.set(step.id, run);
                yield* FiberMap.run(
                  fibers,
                  step.id,
                  runSession(agent.value, config.value, step, shown, access, attemptId, carried).pipe(
                    Effect.flatMap((ending) => settle(step.id, attemptId, ending, carried)),
                    Effect.onInterrupt(() => stopped(step.id, attemptId, run.stop)),
                    Effect.ensuring(
                      Effect.sync(() => running.delete(step.id)).pipe(
                        Effect.andThen(confirmCancelsAbove(step)),
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

      /**
       * Stops running steps whose cancel was asked for, then starts the steps that are ready. A step
       * that returned its result keeps running until its session ends.
       */
      const round = Effect.gen(function* () {
        for (const [id, run] of running) {
          const task = yield* currentTask(id);
          if (Option.isSome(task) && task.value.state === "cancelling" && run.stop === null) {
            run.stop = "cancel";
            yield* Effect.forkIn(FiberMap.remove(fibers, id), scope);
          }
        }
        const trees = new Map<TaskId, TaskTree>();
        for (const step of yield* tasks.listQueuedSteps) {
          if (running.has(step.id)) continue;
          if (count((run) => run.agentId, step.ownerId) >= limits.maxRunningStepsPerHob) continue;
          if (count((run) => run.rootId, step.rootId) >= limits.maxRunningStepsPerTree) continue;
          const tree = trees.get(step.rootId) ?? Option.getOrUndefined(yield* tasks.readTree(step.rootId));
          if (tree === undefined) continue;
          trees.set(step.rootId, tree);
          if (ready(step, tree)) yield* start(step, tree);
        }
      }).pipe(
        Semaphore.withPermit(rounds),
        Effect.catchCause((cause) => Effect.logError("Could not start or stop steps", cause)),
      );

      // After a restart nothing runs (EX-004): every Attempt left live ends as interrupted, and
      // then every step left open without one ends, so its lead hears of it.
      for (const live of yield* tasks.listLiveAttempts) {
        const at = yield* nowIso;
        yield* attempt(
          tasks.updateAttempt(live.id, { state: "interrupted", outcome: "Hobbots stopped while this ran.", at }),
          "end an Attempt left from before a restart",
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
        interruptAgent: (agentId) => stopWhere("hob", (run) => Effect.succeed(run.agentId === agentId)),
        reviewAuthority: (agentId) =>
          stopWhere("authority", (run) =>
            agentId !== undefined && run.agentId !== agentId
              ? Effect.succeed(false)
              : Effect.map(accessNow(repo, hobTools, run.agentId), (access) => narrows(run.access, access)),
          ),
      });
    }),
  );
