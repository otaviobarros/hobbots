import {
  type ActivityRecorder,
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
  type AgentId,
  type AttemptId,
  AttemptId as AttemptIdSchema,
  ancestorsOf,
  type Committed,
  isTerminalTask,
  liveAttemptOn,
  type Task,
  type TaskId,
  TaskReadiness,
  type TaskTree,
  type TurnEnding,
  taskChat,
} from "@hobbots/domain";
import { DateTime, Effect, FiberMap, Option, Semaphore } from "effect";
import { type PathSeparator, sharedFolders } from "./authority.ts";
import { memberPrompt, memberReminder, sendBackPrompt } from "./briefs.ts";
import { newId } from "./call-scope.ts";
import { emptyQuestFinding } from "./empty-quests.ts";
import { currentAccessOf, type Ending, type Running, runSessionTurn, STOPPED } from "./session.ts";
import type { TaskTools } from "./task-tools.ts";
import { endTurn } from "./turn-end.ts";

/** What the member runner shares with the step runner it runs beside. */
export interface MemberDeps {
  readonly tasks: TaskRepository["Service"];
  readonly repo: HobbotsRepository["Service"];
  readonly tools: TaskTools["Service"];
  readonly hobTools: HobTools["Service"];
  readonly admission: HobAdmission["Service"];
  readonly adapters: Effect.Success<typeof runtimeAdapters>;
  readonly redactor: Redactor;
  /** Records what each turn runs and changes for the Workbench (ADR 023). */
  readonly recorder: Option.Option<ActivityRecorder["Service"]>;
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
  /** Confirms every cancel asked for that nothing runs in any more. */
  readonly settleCancels: Effect.Effect<void>;
  readonly notify: Effect.Effect<void>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * A member's tools, narrowed by every Delegation on the way down to its Task (ADR 018): each adds
 * the answers it gives as a restriction, and the member keeps only the folders each one allows. A
 * Delegation holds only the answers given on purpose, so a restriction's Ask is never answered by
 * a grant, while the member's own preset Ask still can be (ADR 015).
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
  const restrictions = [...access.policy.restrictions, ...given.map((delegation) => delegation.authority.overrides)];
  const narrowing = given.flatMap((delegation) =>
    delegation.authority.folders === null ? [] : [delegation.authority.folders],
  );
  if (narrowing.length === 0) return { ...access, policy: { ...access.policy, restrictions } };
  const folders = narrowing.reduce((kept, allowed) => sharedFolders(kept, allowed, separator), access.folders);
  // The policy engine reads its folders from the policy, not from the access: the member's
  // folders become the only ones it may reach, its own and hidden ones folded into them.
  return {
    ...access,
    policy: {
      ...access.policy,
      restrictions,
      sharedFolders: folders,
      hob: { ...access.policy.hob, ownFolders: [], hiddenSharedFolders: [] },
    },
    folders,
  };
};

/**
 * The session the member's last turn on the Task ran in, to resume, or null before its first. Only
 * the Task's current Attempt counts, and only when its owner ran it: a reassignment leaves it none,
 * so a hob the Task comes back to starts afresh rather than in the session it had before. Each turn
 * starts in the session it resumes, so the current Attempt carries it even if it ended early.
 */
const lastSession = (task: Task, tree: TaskTree): string | null => {
  const current = tree.attempts.find((each) => each.id === task.currentAttemptId);
  return current !== undefined && current.agentId === task.ownerId ? current.sessionId : null;
};

/** A turn whose reply did not complete its Task, and whose session goes on once in the same Attempt (#1086). */
const SENT_BACK = "sent-back" as const;

/** Why a turn that broke on a bug in Hobbots failed, as its lead and the Quest room show it. */
const TURN_BROKE = "Hobbots hit an internal error during this turn.";

/**
 * The Attempt the member's next turn on the Task goes on in, as a lead's later turns do (#577,
 * #668): its current one, when its owner's last turn there finished, or was stopped by Hobbots, on
 * the same brain and configuration. A failed turn, a cancel, a retry and a reassignment end it, so
 * the next turn starts a new one. The hub refuses a resume it would not allow, which leaves the work
 * waiting for the next try.
 */
const resumableAttempt = (task: Task, tree: TaskTree, config: AgentConfiguration): AttemptId | null => {
  const current = tree.attempts.find((each) => each.id === task.currentAttemptId);
  return task.state !== "queued" &&
    current !== undefined &&
    current.agentId === task.ownerId &&
    (current.state === "completed" || current.state === "interrupted") &&
    current.runtime === config.runtime &&
    current.configVersion === config.version
    ? current.id
    : null;
};

/**
 * Runs party members' Tasks (ADR 018, ADR 019). A member works on its Task in a session of its
 * own, under its own policy narrowed by the delegation, with the Task tools on its Task. Each turn
 * carries the work its owner holds under the Task, starting with the Task itself, through the
 * dispatcher, and goes on in the Task's current Attempt (#668). A turn that ends without the Task's result leaves it
 * waiting for what comes next, such as a hand-off from its lead or an answer, which starts the
 * next turn in the same session. A member's tool calls that need approval ask you directly, in the
 * Inbox, under the lead's thread (PE-006).
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

  /** Ends a member's turn on its Task by the one turn-end decision (#669). */
  const endMemberTurn = (taskId: TaskId, attemptId: AttemptId, ending: TurnEnding, carried: CarriedWork["holding"]) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      return yield* endTurn(deps, { runner: "member", taskId, attemptId, ending, carried, at });
    });

  /**
   * After a turn: the Attempt ends with it, until the next turn resumes it. A turn that did not
   * return the result itself, with nothing keeping its Task open, is sent back once to return it or
   * report a blocker, and a second such turn blocks the Task with its reply as why (#1086). A Task that
   * comes after others starts only once they have completed, with what they returned, so nothing
   * more from them is to come. A Task still open waits, or is blocked when only its own unreported
   * milestones keep it open, which its lead then hears about, as it does of a Quest the turn left
   * with nobody in it (#576). A failed turn leaves its work to be delivered again.
   */
  const settle = (
    taskId: TaskId,
    attemptId: AttemptId,
    ending: Ending,
    work: CarriedWork,
    { sentBack = false, startedAt }: { readonly sentBack?: boolean; readonly startedAt?: string } = {},
  ): Effect.Effect<CarriedEnd | typeof SENT_BACK> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const result = yield* endTurn(deps, {
        runner: "member",
        taskId,
        attemptId,
        ending:
          ending._tag === "Failed"
            ? { _tag: "Failed", reason: ending.reason }
            : { _tag: "Replied", text: deps.redactor.text(ending.text) },
        carried: work.holding,
        sentBack,
        ...(startedAt === undefined ? {} : { startedAt }),
        at,
      });
      if (result.sentBack) return SENT_BACK;
      const { decided, completed } = result;
      if (ending._tag === "Failed") {
        return {
          _tag: "EndedEarly",
          end: ending.limited ? "limited" : "failed",
          diagnostic: ending.reason,
        } as CarriedEnd;
      }
      if (!completed && decided !== null) yield* flagEmptyQuest(taskId, yield* nowIso);
      return { _tag: "Handled" } as CarriedEnd;
    });

  /** Tells the lead above when the turn left a Quest the member leads with nobody in it (#576). */
  const flagEmptyQuest = (taskId: TaskId, at: string) =>
    Effect.gen(function* () {
      const found = yield* read(taskId);
      if (Option.isNone(found) || isTerminalTask(found.value.task.state) || found.value.task.state === "cancelling")
        return;
      const empty = emptyQuestFinding(found.value.task, found.value.tree, at);
      if (empty !== null) yield* deps.attempt(tasks.recordCheckpoint(empty), "flag an empty Quest");
    });

  /**
   * A member's Task its hob can no longer work on, since the hob was retired: it fails with a
   * blocker that says why, so its lead hears of it and can hand the work to another hob.
   */
  const retire = (taskId: TaskId, agentId: AgentId, at: string) =>
    Effect.gen(function* () {
      const found = yield* read(taskId);
      // A Task given to another hob meanwhile is no longer the retired hob's to fail.
      if (Option.isNone(found) || found.value.task.ownerId !== agentId || isTerminalTask(found.value.task.state))
        return;
      if (found.value.task.state === "cancelling") {
        const task = found.value.task;
        yield* deps.attempt(tasks.moveTask(task.id, task.revision, "cancelled", at), "confirm a member's cancel");
        return;
      }
      const task = found.value.task;
      yield* deps.attempt(
        tasks.moveTask(task.id, task.revision, "failed", at, {
          reason: "Its hob was retired before the Task was done.",
        }),
        "fail a retired member's Task",
      );
    });

  /**
   * A turn stopped before it ended: cancelled with its Task when that was asked for, failed when its
   * hob was retired; otherwise the Task waits and goes on once work arrives again.
   */
  const stopped = (taskId: TaskId, attemptId: AttemptId, run: Running) =>
    Effect.gen(function* () {
      // Stopped with the hub: the next start finds the Attempt live and ends it.
      if (run.stop === null) return;
      yield* endMemberTurn(taskId, attemptId, { _tag: "Stopped", reason: STOPPED[run.stop] }, []);
      // A retired hob's Task fails rather than wait, once its Attempt has ended.
      const hob = yield* repo.findAgent(run.agentId);
      if (Option.isNone(hob) || hob.value.status === "retired") yield* retire(taskId, run.agentId, yield* nowIso);
    });

  /** One turn of the member's session on its Task, carrying the work that waits there. */
  const turnOn = (taskId: TaskId, agent: Agent, config: AgentConfiguration, run: Running): CarryingTurn<AttemptId> => ({
    // Routine progress rides along work that needs the member, and alone starts no turn (IN-005).
    plan: (routineOnly) =>
      Effect.gen(function* () {
        if (routineOnly) return null;
        const found = yield* read(taskId);
        if (Option.isNone(found) || found.value.task.state === "cancelling") return null;
        // One that went live since the turn was started: a second could not start, so the work
        // waits for that one to end instead of spending its tries (ADR 019).
        if (liveAttemptOn(found.value.task, found.value.tree)) return null;
        const hob = yield* repo.findAgent(agent.id);
        if (Option.isNone(hob) || hob.value.status !== "active") return null;
        // A Task that ended still takes the turn's claims, so the dispatcher settles its items as late.
        return resumableAttempt(found.value.task, found.value.tree, config) ?? AttemptIdSchema.make(newId());
      }),
    run: (attemptId, work) =>
      Effect.gen(function* () {
        const found = yield* read(taskId);
        if (Option.isNone(found))
          return { _tag: "EndedEarly", end: "unavailable", diagnostic: "Its Task no longer exists." } as CarriedEnd;
        const { task, tree } = found.value;
        if (isTerminalTask(task.state) || task.state === "cancelling") return { _tag: "Handled" } as CarriedEnd;
        const previous = lastSession(task, tree);
        const at = yield* nowIso;
        const started = yield* deps.attempt(
          attemptId === task.currentAttemptId
            ? tasks.resumeAttempt(task.id, task.revision, {
                runtime: config.runtime,
                configVersion: config.version,
                at,
              })
            : tasks.startAttempt(task.id, task.revision, {
                id: attemptId,
                runtime: config.runtime,
                sessionId: previous,
                configVersion: config.version,
                policyVersion: null,
                startedAt: at,
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
                // The member's requests reach you in the Inbox under its lead's thread, as its own (PE-006).
                { agentId: agent.id, threadId: task.threadId, messageId: null, taskId: task.id },
                currentAccessOf(run),
                // A member's This Task binds to the top of its lead's tree, so it ends with the Quest (ADR 018).
                Effect.succeed(task.rootId),
              );
        // The session its turns ran in, as the runtime reported it, for a turn sent back to go on in.
        let session = previous;
        // Only the turn that carries the work accepts it; one sent back goes on with it in the same Attempt.
        const turnWith = (prompt: string, sessionId: string | null, accepts: boolean) =>
          runSessionTurn(
            deps.adapters,
            deps.redactor,
            {
              agent,
              config,
              taskId: task.id,
              attemptId,
              prompt,
              sessionId,
              access: run.access,
              approvals: handle?.approvals ?? null,
              recordToolStart: deps.recordToolStart(task),
              offer: (approvals) =>
                deps.tools.forSession(
                  { agentId: agent.id, taskId: task.id, carried: work.holding },
                  { attemptId, currentAccess: currentAccessOf(run), redactor: deps.redactor, approvals },
                ),
              started: (started) => {
                session = started.sessionId;
                return (accepts ? work.accepted(started.sessionId) : Effect.void).pipe(
                  Effect.andThen(nowIso),
                  Effect.flatMap((at) =>
                    deps.attempt(
                      tasks.updateAttempt(attemptId, { _tag: "Running", ...started, at }),
                      "record a member's session",
                    ),
                  ),
                  Effect.asVoid,
                );
              },
              turns: tasks,
            },
            deps.recorder,
          );
        return yield* Effect.gen(function* () {
          const ending = yield* turnWith(
            previous === null
              ? [memberPrompt(task, tree, lead), work.text("start")].filter((part) => part !== "").join("\n\n")
              : `${work.text("prompt")}\n\n${memberReminder(task, tree, lead)}`,
            previous,
            true,
          );
          // A session that never started has nothing to go on in, so its reply is settled as sent back already.
          // What the member reported since this turn began says how it ended, not what earlier turns did.
          const settled = yield* settle(task.id, attemptId, ending, work, {
            sentBack: session === null,
            startedAt: at,
          });
          if (settled !== SENT_BACK) return settled;
          // Its reply did not complete the Task: the same session goes on once, told to say how it ended (#1086).
          const again = yield* turnWith(sendBackPrompt(task, lead), session, false);
          return (yield* settle(task.id, attemptId, again, work, { sentBack: true, startedAt: at })) as CarriedEnd;
        }).pipe(Effect.ensuring(handle === null ? Effect.void : handle.close));
      }).pipe(
        // A bug in a turn must not leave its Attempt live, which would hold the Task from any other turn.
        Effect.catchDefect((defect) =>
          Effect.logWarning("A member's turn stopped on a defect", defect).pipe(
            Effect.andThen(
              settle(taskId, attemptId, { _tag: "Failed", reason: TURN_BROKE }, work) as Effect.Effect<CarriedEnd>,
            ),
          ),
        ),
        Effect.onInterrupt(() => stopped(taskId, attemptId, run)),
      ),
  });

  /** Starts the member's turns on its Task under its hob's lock, so a retirement sees every one admitted before it. */
  const start = ({ taskId, agentId }: MemberWorkWaiting) =>
    deps.admission.withHob(
      agentId,
      Effect.gen(function* () {
        const found = yield* read(taskId);
        // Work left for a hob that no longer owns the Task, as after a reassignment, is not its to do.
        if (Option.isNone(found) || found.value.task.ownerId !== agentId) return;
        const agent = yield* repo.findAgent(agentId);
        // A paused hob's work waits until it wakes; a retired hob's Task fails, so its lead hears.
        if (Option.isNone(agent) || agent.value.status === "retired")
          return yield* retire(taskId, agentId, yield* nowIso);
        if (agent.value.status !== "active") return;
        const config = yield* repo.findAgentConfig(agent.value.id, agent.value.configVersion);
        if (Option.isNone(config)) return;
        const { task, tree } = found.value;
        // An Attempt still live on the Task holds it: no turn starts until that one ends, which
        // wakes the runner again (ADR 019).
        if (liveAttemptOn(task, tree)) return;
        // Its work waits, queued, until every Task it comes after has completed: that completion
        // wakes the runner again, as it does for a step (ADR 018).
        if (TaskReadiness.of(task, tree.tasks)._tag !== "Ready") return;
        const narrowed = (own: ToolAccess | null) => delegatedAccess(own, task, tree, deps.separator);
        // Registered and forked under one permit, so a narrower policy either sees neither or can
        // stop the fiber it finds (PE-008).
        yield* Semaphore.withPermit(
          deps.authority,
          Effect.gen(function* () {
            const run: Running = {
              agentId,
              rootId: task.rootId,
              // Its turn starts here, so a question about it goes to the Quest's chat (#741).
              access: narrowed(yield* deps.hobTools.access(agent.value, { chat: taskChat(task, tree.tasks) })),
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
                    Effect.andThen(deps.settleCancels),
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
