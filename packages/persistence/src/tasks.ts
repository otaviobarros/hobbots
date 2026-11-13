import {
  type AttemptChange,
  type AttemptResume,
  type NewNote,
  type NewTask,
  type TaskCompletion,
  TaskRepository,
} from "@hobbots/agents";
import {
  type AgentId,
  type Answerer,
  ArtifactRef,
  Attempt,
  AttemptTransitions,
  ancestorsOf,
  CHECKPOINT_KINDS,
  Checkpoint,
  CheckpointId,
  type CheckpointKind,
  collidingLabel,
  Delegation,
  descendantsOf,
  HandOff,
  IllegalQuestTransition,
  IllegalTaskTransition,
  isLiveAttempt,
  isTerminalTask,
  type JournaledEvent,
  leadsAbove,
  ledgerRefusal,
  Milestone,
  noteRecipientOf,
  optionNamed,
  Quest,
  type QuestEvent,
  Question,
  QuestMachine,
  questPlacement,
  StaleTask,
  Task,
  type TaskId,
  TaskNote,
  TaskReadiness,
  type TaskRefusal,
  TaskRefused,
  type TaskState,
  type TaskTarget,
  TaskTransitions,
  TaskWait,
  type ThreadId,
  unmetCriteria,
  unmetCriteriaText,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { criteriaOf, makeCriteriaChanges } from "./criteria-rows.ts";
import { makeJournaled, makeJournaledChange } from "./journal.ts";
import { makeLedger } from "./ledger.ts";
import { readQuestSummaries } from "./quest-summary-rows.ts";
import { makeTaskReads, taskColumns } from "./task-rows.ts";

const refuse = (reason: TaskRefusal, message: string) => Effect.fail(new TaskRefused({ reason, message }));

/** A pure transition returns the next Task or why it cannot move; the latter fails the change. */
const orFail = (result: Task | IllegalTaskTransition) =>
  result instanceof IllegalTaskTransition ? Effect.fail(result) : Effect.succeed(result);

/** The automatic checkpoint a state records, if any (ADR 018). */
const AUTOMATIC: Partial<Record<TaskState, CheckpointKind>> = {
  active: "started",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** The Quest event a Task's terminal state ends its Quest with. */
const QUEST_END: Partial<Record<TaskState, "Complete" | "Fail" | "Cancel">> = {
  completed: "Complete",
  failed: "Fail",
  cancelled: "Cancel",
};

/** A Quest's change by `QuestMachine`: a change the machine refuses is a bug in the Task's own rules. */
const questMoved = (quest: Quest, event: QuestEvent) => {
  const next = QuestMachine.transition(quest, event);
  return next instanceof IllegalQuestTransition ? Effect.die(next) : Effect.succeed(next);
};

/** The SQL store of Tasks, Quests and their records, for SQLite and PostgreSQL (ADR 011, ADR 018). */

/** Whether a note left again with the same id is the same note: same Task, text and sender. */
const sameNote = (left: TaskNote, input: NewNote) =>
  left.taskId === input.taskId &&
  left.text === input.text &&
  (left.senderId ?? null) === (input.senderId ?? null) &&
  left.delivery === (input.delivery ?? "next-turn");

export const TaskRepositoryLive = Layer.effect(
  TaskRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
    const journaled = makeJournaled(sql);
    const read = makeTaskReads(sql);
    const ledger = makeLedger(sql);

    const loadTask = (id: string) =>
      read
        .task(id)
        .pipe(Effect.flatMap(([task]) => (task ? Effect.succeed(task) : refuse("task-missing", `No Task ${id}`))));

    /** A Task that has not ended, so its records can still change. */
    const openTask = (id: string) =>
      loadTask(id).pipe(
        Effect.flatMap((task) =>
          isTerminalTask(task.state) ? refuse("task-ended", `Task ${task.id} is ${task.state}`) : Effect.succeed(task),
        ),
      );

    /**
     * A Task that has not ended and whose cancel was not asked for: what its owner reports or asks
     * about it from then on is not news to anyone (OR-006).
     */
    const workingTask = (id: string) =>
      openTask(id).pipe(
        Effect.flatMap((task) =>
          task.state === "cancelling"
            ? refuse("task-cancelling", `Task ${task.id} is being cancelled`)
            : Effect.succeed(task),
        ),
      );

    /** The Task at the revision the change was decided on. */
    const current = (id: string, revision: number) =>
      loadTask(id).pipe(
        Effect.flatMap((task) =>
          task.revision === revision
            ? Effect.succeed(task)
            : Effect.fail(new StaleTask({ taskId: task.id, expected: revision, actual: task.revision })),
        ),
      );

    /** Saves the Task. One that ended waits for nothing any more, so its wait goes with it (#702). */
    const saveTask = (task: Task) => {
      const { id, ...columns } = taskColumns(task);
      const saved = sql`UPDATE tasks SET ${sql.update(columns)} WHERE id = ${id}`;
      return isTerminalTask(task.state)
        ? saved.pipe(Effect.andThen(sql`DELETE FROM task_waits WHERE task_id = ${id}`))
        : saved;
    };

    const insertCheckpoint = (checkpoint: Checkpoint) =>
      sql`INSERT INTO checkpoints ${sql.insert({
        id: checkpoint.id,
        task_id: checkpoint.taskId,
        attempt_id: checkpoint.attemptId,
        source: checkpoint.source,
        kind: checkpoint.kind,
        milestone_id: checkpoint.milestoneId,
        summary: checkpoint.summary,
        detail: checkpoint.detail,
        about_task_id: checkpoint.aboutTaskId,
        created_at: checkpoint.createdAt,
        revision: checkpoint.revision,
      })}`;

    /** Records the automatic checkpoint `task`'s new state calls for, if any, at journal sequence `revision`. */
    const automatic = (task: Task, at: string, revision: number) =>
      Effect.gen(function* () {
        const kind = AUTOMATIC[task.state];
        if (kind === undefined) return [];
        const checkpoint = new Checkpoint({
          id: CheckpointId.make(crypto.randomUUID()),
          taskId: task.id,
          attemptId: task.currentAttemptId,
          source: "automatic",
          kind,
          milestoneId: null,
          summary: kind,
          createdAt: at,
          revision,
        });
        yield* insertCheckpoint(checkpoint);
        return [{ _tag: "CheckpointRecorded", checkpoint, milestone: null } as const];
      });

    /** Writes a Quest's state, its stop and when it ended, at journal sequence `revision`. */
    const saveQuest = (quest: Quest, revision: number) =>
      Effect.as(
        sql`UPDATE quests SET state = ${quest.state}, stop = ${quest.stop === null ? null : JSON.stringify(quest.stop)},
          ended_at = ${quest.endedAt}, revision = ${revision} WHERE id = ${quest.id}`,
        new Quest({ ...quest, revision }),
      );

    /**
     * Ends the Quest on `task`, if it has one, with the Task's terminal state: one its lead was
     * stopping at your request ends stopped (#1346).
     */
    const endQuest = (task: Task, at: string, revision: number) =>
      Effect.gen(function* () {
        const event = QUEST_END[task.state];
        const [quest] = event === undefined ? [] : yield* read.questsOn([task.id]);
        if (quest === undefined || event === undefined) return null;
        return yield* saveQuest(yield* questMoved(quest, { _tag: event, at }), revision);
      });

    interface Placement {
      readonly rootId: TaskId;
      readonly threadId: ThreadId | null;
      readonly quest: Quest | null;
      readonly lead: AgentId;
    }
    type Placed = Effect.Effect<Placement, TaskRefused | SqlError.SqlError>;

    /** The Task you asked for: it starts its own tree, in a thread that exists, with no lead and no siblings. */
    const placeTop = (input: NewTask, hasDelegation: boolean): Placed =>
      Effect.gen(function* () {
        if (hasDelegation) return yield* refuse("delegation-mismatch", "The Task you asked for has no lead");
        if (input.dependsOn.length > 0) return yield* refuse("dependency-outside-tree", "A top Task has no siblings");
        const [thread] =
          input.threadId === null ? [true] : yield* sql`SELECT id FROM threads WHERE id = ${input.threadId}`;
        if (thread === undefined) return yield* refuse("thread-missing", `No thread ${input.threadId}`);
        return { rootId: input.id, threadId: input.threadId, quest: null, lead: input.ownerId };
      });

    /** A child: a step under its own owner's Task, or a member's Task delegated from a Quest on its parent. */
    const placeChild = (input: NewTask, parentId: TaskId, hasDelegation: boolean): Placed =>
      Effect.gen(function* () {
        const [parent] = yield* read.task(parentId);
        if (parent === undefined) return yield* refuse("parent-missing", `No parent Task ${parentId}`);
        if (isTerminalTask(parent.state)) return yield* refuse("parent-ended", `Task ${parent.id} is ${parent.state}`);
        // Work never starts under a Task whose cancel was asked for (OR-006).
        if (parent.state === "cancelling") return yield* refuse("parent-cancelling", `Task ${parent.id} is cancelling`);
        const step = parent.ownerId === input.ownerId;
        if (step && hasDelegation) return yield* refuse("delegation-mismatch", "A step is not delegated");
        if (!step && !hasDelegation) return yield* refuse("step-owner", "A step has its parent's owner");
        const [quest] = step ? [] : yield* read.questsOn([parent.id]);
        if (!step && quest === undefined) return yield* refuse("quest-missing", `Task ${parent.id} has no Quest`);
        const siblings = new Set(
          (yield* read.treeOf(parent.rootId)).filter((each) => each.parentId === parent.id).map((each) => each.id),
        );
        if (input.dependsOn.some((id) => !siblings.has(id))) {
          return yield* refuse("dependency-outside-tree", "A Task depends only on its siblings");
        }
        return { rootId: parent.rootId, threadId: parent.threadId, quest: quest ?? null, lead: parent.ownerId };
      });

    /** Checks a new Task's lineage, and returns where it sits: its root, thread, and a member's Quest and lead. */
    const lineage = (input: NewTask, hasDelegation: boolean): Placed =>
      Effect.gen(function* () {
        const [owner] = yield* sql`SELECT id FROM agents WHERE id = ${input.ownerId}`;
        if (owner === undefined) return yield* refuse("owner-missing", `No hob ${input.ownerId}`);
        return yield* input.parentId === null
          ? placeTop(input, hasDelegation)
          : placeChild(input, input.parentId, hasDelegation);
      });

    const createTask: TaskRepository["Service"]["createTask"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const { task: fields, delegation: brief } = input;
          const placed = yield* lineage(fields, brief !== null);
          const task = new Task({
            ...fields,
            rootId: placed.rootId,
            threadId: placed.threadId,
            state: "queued",
            result: null,
            currentAttemptId: null,
            updatedAt: fields.createdAt,
            revision,
          });
          yield* sql`INSERT INTO tasks ${sql.insert(taskColumns(task))}`;
          // A top Task started in a chat or camp belongs to the chapter it was started in, and moves with it (ADR 037).
          if (task.parentId === null && task.threadId !== null) {
            yield* sql`UPDATE tasks SET chapter_id = (SELECT c.id FROM chapters c
              WHERE c.thread_id = ${task.threadId} AND c.state = 'live') WHERE id = ${task.id}`;
          }
          const delegation =
            brief === null || placed.quest === null
              ? null
              : new Delegation({
                  ...brief,
                  questId: placed.quest.id,
                  leadId: placed.lead,
                  memberId: task.ownerId,
                  parentTaskId: placed.quest.taskId,
                  childTaskId: task.id,
                  createdAt: task.createdAt,
                });
          if (delegation !== null) {
            yield* sql`INSERT INTO delegations ${sql.insert({
              id: delegation.id,
              quest_id: delegation.questId,
              lead_id: delegation.leadId,
              member_id: delegation.memberId,
              parent_task_id: delegation.parentTaskId,
              child_task_id: delegation.childTaskId,
              brief: delegation.brief,
              expected_output: delegation.expectedOutput,
              authority: JSON.stringify(delegation.authority),
              timeout_ms: delegation.timeoutMs,
              created_at: delegation.createdAt,
            })}`;
          }
          const milestones = input.milestones.map(
            (milestone, position) =>
              new Milestone({ ...milestone, taskId: task.id, position, reachedAt: null, createdAt: task.createdAt }),
          );
          for (const milestone of milestones) {
            yield* sql`INSERT INTO milestones ${sql.insert({
              id: milestone.id,
              task_id: milestone.taskId,
              title: milestone.title,
              position: milestone.position,
              reached_at: null,
              reached_by: null,
              created_at: milestone.createdAt,
            })}`;
          }
          return { value: task, events: [{ _tag: "TaskCreated", task, delegation, milestones } as const] };
        }),
      );

    const startQuest: TaskRepository["Service"]["startQuest"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const task = yield* openTask(input.taskId);
          const tree = yield* read.treeOf(task.rootId);
          const quests = yield* read.questsOn(tree.map((each) => each.id));
          if (quests.some((quest) => quest.taskId === task.id)) {
            return yield* refuse("quest-exists", `Task ${task.id} is already a Quest`);
          }
          const { outer, depth } = questPlacement(task, tree, quests);
          const quest = new Quest({
            ...input,
            criteria: criteriaOf(input),
            leadId: task.ownerId,
            parentQuestId: outer?.id ?? null,
            threadId: task.threadId,
            depth,
            state: "active",
            endedAt: null,
            revision,
          });
          yield* sql`INSERT INTO quests ${sql.insert({
            id: quest.id,
            task_id: quest.taskId,
            lead_id: quest.leadId,
            parent_quest_id: quest.parentQuestId,
            thread_id: quest.threadId,
            goal: quest.goal,
            acceptance: JSON.stringify(quest.acceptance),
            criteria: JSON.stringify(quest.criteria),
            limits: JSON.stringify(quest.limits),
            depth: quest.depth,
            state: quest.state,
            created_at: quest.createdAt,
            ended_at: null,
            revision,
          })}`;
          return { value: quest, events: [{ _tag: "QuestStarted", quest } as const] };
        }),
      );

    const stopQuest: TaskRepository["Service"]["stopQuest"] = (questId, expected, stop) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* read.quest(questId);
          if (before === undefined) return yield* refuse("quest-missing", `No Quest ${questId}`);
          if (before.revision !== expected) {
            return yield* refuse("task-changed", `Quest ${questId} changed meanwhile`);
          }
          const stopped = QuestMachine.transition(before, { _tag: "Stop", ...stop });
          if (stopped instanceof IllegalQuestTransition) {
            return yield* refuse("quest-ended", `Quest ${questId} is ${before.state}, so it cannot be stopped`);
          }
          const quest = yield* saveQuest(stopped, revision);
          return { value: quest, events: [{ _tag: "QuestStopRequested", quest } as const] };
        }),
      );

    const liveAttempt = (task: Task) =>
      Effect.gen(function* () {
        if (task.currentAttemptId === null) return false;
        const [attempt] = yield* read.attempt(task.currentAttemptId);
        return attempt !== undefined && isLiveAttempt(attempt.state);
      });

    /** A Task ends only once its own Attempt and every Task under it have ended. */
    const endable = (task: Task) =>
      Effect.gen(function* () {
        if (yield* liveAttempt(task))
          return yield* refuse("attempt-live", `Task ${task.id} has a live Attempt; end it first`);
        const under = descendantsOf(task, yield* read.treeOf(task.rootId));
        if (under.some((each) => !isTerminalTask(each.state))) {
          return yield* refuse("children-open", `Task ${task.id} has work still open under it`);
        }
      });

    /** Nothing starts under a Task whose cancel was asked for (OR-006). */
    const notUnderCancel = (task: Task) =>
      Effect.gen(function* () {
        const cancelling = ancestorsOf(task, yield* read.treeOf(task.rootId)).find((at) => at.state === "cancelling");
        if (cancelling !== undefined) {
          return yield* refuse("parent-cancelling", `Task ${cancelling.id} is cancelling`);
        }
      });

    /**
     * A retry reopens a Task only under ancestors that are still open and not being cancelled, and
     * reopens its Quest with it.
     */
    const reopen = (task: Task, revision: number) =>
      Effect.gen(function* () {
        if (task.state !== "failed") return null;
        const above = ancestorsOf(task, yield* read.treeOf(task.rootId));
        const ended = above.find((at) => isTerminalTask(at.state));
        if (ended !== undefined) return yield* refuse("parent-ended", `Task ${ended.id} is ${ended.state}`);
        yield* notUnderCancel(task);
        const [quest] = yield* read.questsOn([task.id]);
        if (quest === undefined) return null;
        return yield* saveQuest(yield* questMoved(quest, { _tag: "Reopen", at: task.updatedAt }), revision);
      });

    /** Whether `task` can start an Attempt, read from its tree: refused unless it is Ready (#667). */
    const readiness = (task: Task) =>
      Effect.gen(function* () {
        const ready = TaskReadiness.of(task, task.dependsOn.length === 0 ? [] : yield* read.treeOf(task.rootId));
        if (ready._tag === "Ready") return ready;
        const unmet = TaskReadiness.unmet(ready).join(", ");
        return yield* refuse(
          "dependencies-open",
          `Task ${task.id} comes after Tasks that have not completed: ${unmet}`,
        );
      });

    const startAttempt: TaskRepository["Service"]["startAttempt"] = (taskId, expected, input) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          if (yield* liveAttempt(before)) return yield* refuse("attempt-live", `Task ${taskId} has a live Attempt`);
          yield* notUnderCancel(before);
          const quest = yield* reopen(before, revision);
          const task = new Task({
            ...(yield* orFail(TaskTransitions.start(before, input.id, input.startedAt, yield* readiness(before)))),
            revision,
          });
          const [last] = yield* sql<{ readonly number: unknown }>`SELECT MAX(number) AS number FROM attempts
            WHERE task_id = ${taskId}`;
          const attempt = new Attempt({
            ...input,
            taskId: task.id,
            number: Number(last?.number ?? 0) + 1,
            agentId: task.ownerId,
            state: "starting",
            outcome: null,
            endedAt: null,
          });
          yield* sql`INSERT INTO attempts ${sql.insert({
            id: attempt.id,
            task_id: attempt.taskId,
            number: attempt.number,
            agent_id: attempt.agentId,
            runtime: attempt.runtime,
            session_id: attempt.sessionId,
            config_version: attempt.configVersion,
            policy_version: attempt.policyVersion,
            state: attempt.state,
            outcome: null,
            started_at: attempt.startedAt,
            ended_at: null,
          })}`;
          yield* saveTask(task);
          return {
            value: { task, attempt },
            events: [
              { _tag: "TaskStateChanged", task, attempt, quest, wait: null } as const,
              ...(yield* automatic(task, input.startedAt, revision + 1)),
            ],
          };
        }),
      );

    /** The reply of the turn that ended an Attempt, journaled with its end for memory (ADR 028) and kept nowhere else. */
    const replyOf = (update: AttemptChange) =>
      update._tag === "Ended" && update.reply !== undefined ? { reply: update.reply } : {};

    const updateAttempt: TaskRepository["Service"]["updateAttempt"] = (attemptId, update) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* read.attempt(attemptId);
          if (before === undefined) return yield* refuse("attempt-missing", `No Attempt ${attemptId}`);
          if (!isLiveAttempt(before.state)) return yield* refuse("attempt-ended", `Attempt ${attemptId} has ended`);
          if (update._tag === "Running" && before.state === "running") {
            return yield* refuse("attempt-live", `Attempt ${attemptId} is already running`);
          }
          const owner = yield* loadTask(before.taskId);
          const ended =
            update._tag === "Ended" ? AttemptTransitions.end(owner, update.end, yield* cancelledBy(owner)) : null;
          const attempt = new Attempt({
            ...before,
            state: ended?.state ?? "running",
            sessionId: update.sessionId ?? before.sessionId,
            policyVersion: before.policyVersion ?? update.policyVersion ?? null,
            outcome: ended?.outcome ?? before.outcome,
            endedAt: ended === null ? null : update.at,
          });
          yield* sql`UPDATE attempts SET state = ${attempt.state}, session_id = ${attempt.sessionId},
            policy_version = ${attempt.policyVersion}, outcome = ${attempt.outcome}, ended_at = ${attempt.endedAt}
            WHERE id = ${attempt.id}`;
          // A Task that already ended keeps the time it ended: its turn often ends a little after.
          const updatedAt = isTerminalTask(owner.state) ? owner.updatedAt : update.at;
          const task = new Task({ ...owner, updatedAt, revision });
          yield* saveTask(task);
          return {
            value: { task, attempt },
            events: [{ _tag: "TaskStateChanged", task, attempt, quest: null, wait: null, ...replyOf(update) } as const],
          };
        }),
      );

    /**
     * Who cancelled `task`, as its Attempt names them: "You", or the hob's name, by the cancel asked
     * for on it or, for one cancelled with its parent, on its nearest ancestor. Null when its cancel
     * was not asked for, or was asked for before who asked was recorded.
     */
    const cancelledBy = (task: Task) =>
      Effect.gen(function* () {
        if (task.state !== "cancelling" && task.state !== "cancelled") return null;
        const line = [task, ...ancestorsOf(task, yield* read.treeOf(task.rootId))];
        const rows = yield* sql<{ readonly taskId: string; readonly requestedBy: string | null }>`
          SELECT task_id, requested_by FROM task_cancels WHERE ${sql.in(
            "task_id",
            line.map((each) => each.id),
          )}`;
        const nearest = line.flatMap((each) => rows.filter((row) => row.taskId === each.id))[0];
        if (nearest === undefined) return null;
        if (nearest.requestedBy === null) return "You";
        const [hob] = yield* sql<{ readonly name: string }>`SELECT name FROM agents WHERE id = ${nearest.requestedBy}`;
        return hob?.name ?? nearest.requestedBy;
      });

    /** The Attempt a Task last ran, which its next turn resumes when nothing makes it a new one. */
    const resumable = (task: Task, resume: AttemptResume) =>
      Effect.gen(function* () {
        if (isTerminalTask(task.state)) return yield* refuse("task-ended", `Task ${task.id} is ${task.state}`);
        // A retried Task waits in the queue for a new Attempt, never the one that failed (EX-001).
        if (task.state === "queued") return yield* refuse("attempt-ended", `Task ${task.id} waits for a new Attempt`);
        const [last] = task.currentAttemptId === null ? [] : yield* read.attempt(task.currentAttemptId);
        if (last === undefined) return yield* refuse("attempt-missing", `Task ${task.id} has no Attempt to resume`);
        if (isLiveAttempt(last.state)) return yield* refuse("attempt-live", `Attempt ${last.id} is still live`);
        if (last.state === "cancelled" || last.state === "unresolved") {
          return yield* refuse("attempt-ended", `Attempt ${last.id} ended as ${last.state}`);
        }
        if (last.runtime !== resume.runtime || last.configVersion !== resume.configVersion) {
          return yield* refuse("attempt-mismatch", `Attempt ${last.id} ran on another brain or configuration`);
        }
        return last;
      });

    const resumeAttempt: TaskRepository["Service"]["resumeAttempt"] = (taskId, expected, resume) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          const last = yield* resumable(before, resume);
          yield* notUnderCancel(before);
          const ready = yield* readiness(before);
          const task = new Task({
            ...(yield* orFail(TaskTransitions.start(before, last.id, resume.at, ready))),
            revision,
          });
          const attempt = new Attempt({ ...last, state: "starting", outcome: null, endedAt: null });
          yield* sql`UPDATE attempts SET state = ${attempt.state}, outcome = NULL, ended_at = NULL
            WHERE id = ${attempt.id}`;
          yield* saveTask(task);
          return {
            value: { task, attempt },
            events: [
              { _tag: "TaskStateChanged", task, attempt, quest: null, wait: null } as const,
              ...(yield* automatic(task, resume.at, revision + 1)),
            ],
          };
        }),
      );

    const moveTask: TaskRepository["Service"]["moveTask"] = (taskId, expected, to: TaskTarget, at, options = {}) =>
      change((revision) =>
        Effect.gen(function* () {
          const { carried = [], cancelledBy, reason } = options;
          const before = yield* current(taskId, expected);
          if (to === "failed" || to === "cancelled") yield* endable(before);
          const task = new Task({ ...(yield* orFail(TaskTransitions.moveTo(before, to, at))), revision });
          yield* saveTask(task);
          if (cancelledBy !== undefined && (to === "cancelling" || to === "cancelled")) {
            const requestedBy = cancelledBy === "you" ? null : cancelledBy;
            yield* sql`INSERT INTO task_cancels (task_id, requested_by, requested_at)
              VALUES (${task.id}, ${requestedBy}, ${at})
              ON CONFLICT (task_id) DO UPDATE SET requested_by = ${requestedBy}, requested_at = ${at}`;
          }
          const quest = yield* endQuest(task, at, revision);
          const events: Array<JournaledEvent> = [{ _tag: "TaskStateChanged", task, attempt: null, quest, wait: null }];
          if (reason !== undefined && (to === "blocked" || to === "failed")) {
            const checkpoint = new Checkpoint({
              id: CheckpointId.make(crypto.randomUUID()),
              taskId: task.id,
              attemptId: task.currentAttemptId,
              source: "automatic",
              kind: "blocker",
              milestoneId: null,
              summary: reason,
              createdAt: at,
              revision: revision + events.length,
            });
            yield* insertCheckpoint(checkpoint);
            events.push({ _tag: "CheckpointRecorded", checkpoint, milestone: null });
          }
          events.push(...(yield* automatic(task, at, revision + events.length)));
          if (to === "blocked" && carried.length > 0 && task.currentAttemptId !== null) {
            const { consumes } = yield* ledger.readFor(task, carried);
            const by = yield* ledger.consumer(task.currentAttemptId);
            events.push(...(yield* ledger.consume(consumes, by, revision + events.length)));
          }
          if (isTerminalTask(task.state)) {
            events.push(...(yield* withdrawQuestions(task, revision + events.length)));
            events.push(...(yield* ledger.closeStuck(task, null, revision + events.length)));
          }
          return { value: task, events };
        }),
      );

    /**
     * Withdraws the questions still open about `task` once it ended as cancelled or failed: nobody
     * is left to hear their answers, so they no longer hold its lead's ledger open or wait for you.
     * Recorded from sequence `first` on, with the lead's copies still pending and unclaimed resolved as late.
     */
    const withdrawQuestions = (task: Task, first: number) =>
      Effect.gen(function* () {
        const open = yield* read.openQuestionsOn(task.id);
        const events: Array<JournaledEvent> = [];
        for (const before of open) {
          const question = new Question({ ...before, state: "withdrawn", revision: first + events.length });
          yield* saveQuestion(question);
          events.push({ _tag: "QuestionWithdrawn", question });
        }
        if (open.length === 0) return events;
        return [...events, ...(yield* ledger.retire(yield* ledger.questionItems(task), first + events.length))];
      });

    const retryTask: TaskRepository["Service"]["retryTask"] = (taskId, expected, at) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          if (before.parentId === null) {
            return yield* refuse("top-task", `Task ${taskId} is the one you asked for; ask its hob again instead`);
          }
          const task = new Task({ ...(yield* orFail(TaskTransitions.retry(before, at))), revision });
          const quest = yield* reopen(before, revision);
          yield* saveTask(task);
          const [delegation] = yield* read.delegationsOf(task.id);
          const control = { _tag: "Retried", delegation: delegation ?? null } as const;
          const late = yield* ledger.retire(yield* ledger.staleItems(before, null), revision + 1);
          return {
            value: task,
            events: [{ _tag: "TaskStateChanged", task, attempt: null, quest, wait: null, control }, ...late],
          };
        }),
      );

    // The hob taking a Task, read in the write's transaction. On PostgreSQL its row stays locked until
    // the write commits, so retiring it waits; SQLite's one connection already runs writes one at a time.
    const lockTaker = (ownerId: AgentId) =>
      sql.onDialectOrElse({
        pg: () =>
          sql<{ readonly status: string; readonly retiring: string | null }>`SELECT status, retiring FROM agents
            WHERE id = ${ownerId} FOR UPDATE`,
        orElse: () =>
          sql<{ readonly status: string; readonly retiring: string | null }>`SELECT status, retiring FROM agents
            WHERE id = ${ownerId}`,
      });

    /**
     * Who may take a member's Task: a hob that exists, is neither retired nor finishing its open Tasks
     * before it retires (#408), is not its owner and owns nothing on its way up.
     */
    const newOwner = (task: Task, ownerId: AgentId) =>
      Effect.gen(function* () {
        const [owner] = yield* lockTaker(ownerId);
        if (owner === undefined) return yield* refuse("owner-missing", `No hob ${ownerId}`);
        if (owner.status === "retired" || owner.retiring != null) {
          return yield* refuse("owner-unavailable", `${ownerId} is retired or retiring, so it takes no new work`);
        }
        if (task.ownerId === ownerId) return yield* refuse("same-owner", `Task ${task.id} is already ${ownerId}'s`);
        const tree = yield* read.treeOf(task.rootId);
        if (ancestorsOf(task, tree).some((above) => above.ownerId === ownerId)) {
          return yield* refuse("lineage-owner", `${ownerId} already works on a Task above Task ${task.id}`);
        }
        return tree;
      });

    /** A member's Task can change hands only with nothing running in it and nothing open under it. */
    const handable = (task: Task, tree: ReadonlyArray<Task>) =>
      Effect.gen(function* () {
        if (yield* liveAttempt(task)) {
          return yield* refuse("attempt-live", `Task ${task.id} is running; wait for its turn to end`);
        }
        if (descendantsOf(task, tree).some((each) => !isTerminalTask(each.state))) {
          return yield* refuse("children-open", `Task ${task.id} has work still open under it; cancel it first`);
        }
        if ((yield* read.questsOn([task.id])).length > 0) {
          return yield* refuse("quest-exists", `Task ${task.id} leads a Quest of its own`);
        }
      });

    /**
     * Why the Task could not change hands to `ownerId` once its running turn has stopped, by the
     * rules `reassignTask` checks, or null when it could (#408). A live Attempt is no reason here:
     * the hand-over stops it first.
     */
    const handOverRefusal = (taskId: TaskId, ownerId: AgentId) =>
      Effect.gen(function* () {
        const task = yield* openTask(taskId);
        if (task.state === "cancelling") return yield* refuse("task-cancelling", `Task ${task.id} is being cancelled`);
        const [delegation] = yield* read.delegationsOf(task.id);
        if (delegation === undefined) {
          return yield* refuse("not-delegated", `Task ${taskId} is not a party member's; only those change hands`);
        }
        const tree = yield* newOwner(task, ownerId);
        if (descendantsOf(task, tree).some((each) => !isTerminalTask(each.state))) {
          return yield* refuse("children-open", `Task ${task.id} has work still open under it`);
        }
        if ((yield* read.questsOn([task.id])).length > 0) {
          return yield* refuse("quest-exists", `Task ${task.id} leads a Quest of its own`);
        }
        return null;
      }).pipe(
        Effect.catchTag("TaskRefused", (refused) => Effect.succeed(refused)),
        Effect.orDie,
      );

    const reassignTask: TaskRepository["Service"]["reassignTask"] = (taskId, expected, ownerId, at) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          const [delegation] = yield* read.delegationsOf(before.id);
          if (delegation === undefined) {
            return yield* refuse("not-delegated", `Task ${taskId} is not a party member's; only those change hands`);
          }
          const task = new Task({ ...(yield* orFail(TaskTransitions.reassign(before, ownerId, at))), revision });
          yield* handable(before, yield* newOwner(before, ownerId));
          const quest = yield* reopen(before, revision);
          yield* saveTask(task);
          yield* sql`UPDATE delegations SET member_id = ${ownerId} WHERE id = ${delegation.id}`;
          const control = {
            _tag: "Reassigned",
            from: before.ownerId,
            delegation: new Delegation({ ...delegation, memberId: ownerId }),
          } as const;
          const late = yield* ledger.retire(yield* ledger.staleItems(before, before.ownerId), revision + 1);
          // What the earlier owner was stuck on about the Task is no longer its to retry (#1087).
          const unstuck = yield* ledger.closeStuck(before, before.ownerId, revision + 1 + late.length);
          return {
            value: task,
            events: [
              { _tag: "TaskStateChanged", task, attempt: null, quest, wait: null, control },
              ...late,
              ...unstuck,
            ],
          };
        }),
      );

    /**
     * The completion gate: the result names the Task's current Attempt, and its responsibility
     * ledger is settled but for what the completing turn carries (ADR 019). Returns what the
     * completion consumes, and the items about ended Tasks under it that it resolves as late.
     */
    const gate = (task: Task, completion: TaskCompletion) =>
      Effect.gen(function* () {
        if (completion.attemptId !== task.currentAttemptId) {
          return yield* refuse("attempt-mismatch", "A result names its Task's current Attempt");
        }
        const { ledger: open, consumes, superseded } = yield* ledger.readFor(task, completion.carried);
        const refusal = ledgerRefusal(open);
        if (refusal !== null) return yield* refuse(refusal.reason, refusal.message);
        // A Quest completes only once each required criterion is accepted or waived (#1445).
        const [quest] = yield* read.questsOn([task.id]);
        const unmet = quest === undefined ? [] : unmetCriteria(quest.criteria);
        if (unmet.length > 0) return yield* refuse("criteria-unmet", unmetCriteriaText(task.id, unmet));
        return { consumes, superseded };
      });

    const completeTask: TaskRepository["Service"]["completeTask"] = (taskId, expected, completion) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          const result = { summary: completion.summary, attemptId: completion.attemptId };
          const task = new Task({
            ...(yield* orFail(TaskTransitions.complete(before, result, completion.at))),
            revision,
          });
          const settles = yield* gate(task, completion);
          yield* saveTask(task);
          const artifacts = completion.artifacts.map(
            (artifact) =>
              new ArtifactRef({
                ...artifact,
                taskId: task.id,
                attemptId: completion.attemptId,
                createdAt: completion.at,
              }),
          );
          for (const artifact of artifacts) {
            yield* sql`INSERT INTO artifact_refs ${sql.insert({
              id: artifact.id,
              task_id: artifact.taskId,
              attempt_id: artifact.attemptId,
              kind: artifact.kind,
              label: artifact.label,
              value: artifact.value,
              created_at: artifact.createdAt,
            })}`;
          }
          const events: Array<JournaledEvent> = [{ _tag: "TaskCompleted", task, artifacts }];
          events.push(...(yield* automatic(task, completion.at, revision + 1)));
          if (completion.uncommitted !== undefined) {
            const checkpoint = new Checkpoint({
              id: completion.uncommitted.id,
              taskId: task.id,
              attemptId: completion.attemptId,
              source: "automatic",
              kind: "uncommitted",
              milestoneId: null,
              summary: completion.uncommitted.summary,
              createdAt: completion.at,
              revision: revision + events.length,
            });
            yield* insertCheckpoint(checkpoint);
            events.push({ _tag: "CheckpointRecorded", checkpoint, milestone: null });
          }
          const quest = yield* endQuest(task, completion.at, revision + events.length);
          if (quest !== null) events.push({ _tag: "QuestCompleted", quest });
          const by = yield* ledger.consumer(completion.attemptId);
          events.push(...(yield* ledger.consume(settles.consumes, by, revision + events.length)));
          events.push(...(yield* ledger.retire(settles.superseded, revision + events.length)));
          events.push(...(yield* ledger.closeStuck(task, null, revision + events.length)));
          return { value: task, events };
        }),
      );

    /**
     * The milestone a planned checkpoint reaches, marked reached by the hob whose work reached it:
     * the one the checkpoint names, or else `owner`, the Task's owner that reports it (#743). Null for
     * any other checkpoint.
     */
    const reach = (input: Parameters<TaskRepository["Service"]["recordCheckpoint"]>[0], owner: AgentId) =>
      Effect.gen(function* () {
        if (input.kind !== "milestone") {
          if (input.milestoneId !== null) return yield* refuse("milestone-mismatch", "Only a milestone names one");
          if ((input.reachedBy ?? null) !== null) {
            return yield* refuse("milestone-mismatch", "Only a milestone names who reached it");
          }
          return null;
        }
        const [row] =
          input.milestoneId === null
            ? []
            : yield* sql<{ readonly title: string; readonly position: unknown; readonly createdAt: string }>`
                SELECT title, position, created_at FROM milestones
                WHERE id = ${input.milestoneId} AND task_id = ${input.taskId} AND reached_at IS NULL`;
        if (row === undefined || input.milestoneId === null) {
          return yield* refuse(
            "milestone-mismatch",
            "A milestone checkpoint reaches one of its Task's open milestones",
          );
        }
        const reachedBy = input.reachedBy ?? owner;
        yield* sql`UPDATE milestones SET reached_at = ${input.createdAt}, reached_by = ${reachedBy}
          WHERE id = ${input.milestoneId}`;
        return new Milestone({
          id: input.milestoneId,
          taskId: input.taskId,
          title: row.title,
          position: Number(row.position),
          reachedAt: input.createdAt,
          reachedBy,
          createdAt: row.createdAt,
        });
      });

    const recordCheckpoint: TaskRepository["Service"]["recordCheckpoint"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const task = yield* workingTask(input.taskId);
          // The hub records only findings this way; the automatic states follow the Task's own changes,
          // and what it left uncommitted is recorded with its completion.
          if (
            !CHECKPOINT_KINDS[input.source].includes(input.kind) ||
            (input.source === "automatic" && input.kind !== "finding")
          ) {
            return yield* refuse("checkpoint-kind", `A ${input.source} checkpoint is not a ${input.kind}`);
          }
          const { reachedBy: _reachedBy, ...recorded } = input;
          const milestone = yield* reach(input, task.ownerId);
          const checkpoint = new Checkpoint({
            ...recorded,
            detail: input.detail ?? null,
            aboutTaskId: input.aboutTaskId ?? null,
            attemptId: task.currentAttemptId,
            revision,
          });
          yield* insertCheckpoint(checkpoint);
          return { value: checkpoint, events: [{ _tag: "CheckpointRecorded", checkpoint, milestone } as const] };
        }),
      );

    const askQuestion: TaskRepository["Service"]["askQuestion"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const task = yield* workingTask(input.taskId);
          if (task.ownerId !== input.askerId) return yield* refuse("not-asker", "Only a Task's owner asks about it");
          // An answer names its choice by label, so each must read differently (#740).
          const same = collidingLabel(input.options ?? []);
          if (same !== undefined) return yield* refuse("options-collide", `Two options are both "${same}"`);
          const [lead] = leadsAbove(task, yield* read.treeOf(task.rootId));
          const question = new Question({
            ...input,
            options: input.options ?? [],
            recommended: input.recommended ?? null,
            recipientId: lead ?? null,
            chain: [],
            state: "open",
            answer: null,
            answeredBy: null,
            answeredAt: null,
            revision,
          });
          yield* sql`INSERT INTO questions ${sql.insert({
            id: question.id,
            task_id: question.taskId,
            asker_id: question.askerId,
            recipient_id: question.recipientId,
            chain: "[]",
            text: question.text,
            state: question.state,
            answer: null,
            answered_by: null,
            created_at: question.createdAt,
            answered_at: null,
            options: JSON.stringify(question.options),
            recommended: question.recommended,
            revision,
          })}`;
          return { value: question, events: [{ _tag: "QuestionAsked", question } as const] };
        }),
      );

    const openQuestion = (questionId: string, by: Answerer) =>
      Effect.gen(function* () {
        const [question] = yield* read.question(questionId);
        if (question === undefined) return yield* refuse("question-missing", `No question ${questionId}`);
        if (question.state === "withdrawn") {
          return yield* refuse("task-ended", `Question ${questionId} was withdrawn when its Task ended`);
        }
        if (question.state !== "open") return yield* refuse("question-answered", `Question ${questionId} is answered`);
        // A question about work that ended has nobody left to hear its answer.
        const task = yield* loadTask(question.taskId);
        const top = task.rootId === task.id ? task : yield* loadTask(task.rootId);
        if (isTerminalTask(task.state) || isTerminalTask(top.state))
          return yield* refuse("task-ended", `The work question ${questionId} is about has ended`);
        const recipient = by._tag === "User" ? null : by.agentId;
        if (question.recipientId !== recipient) {
          // Said so a hob does not tell the user an answer is on its way when it never went (#569, #575).
          return yield* refuse(
            "not-recipient",
            question.recipientId === null
              ? `Question ${questionId} was passed up to the user, so only the user answers it now. Your answer was not sent.`
              : `Only the hob question ${questionId} is waiting on answers it. Your answer was not sent.`,
          );
        }
        return question;
      });

    const saveQuestion = (question: Question) =>
      sql`UPDATE questions SET recipient_id = ${question.recipientId}, chain = ${JSON.stringify(question.chain)},
        state = ${question.state}, answer = ${question.answer},
        answered_by = ${question.answeredBy === null ? null : JSON.stringify(question.answeredBy)},
        answered_at = ${question.answeredAt}, answered_by_device_id = ${question.answeredByDeviceId},
        answered_via = ${question.answeredVia}, picked = ${question.picked},
        revision = ${question.revision} WHERE id = ${question.id}`;

    /** The copies of `question` still waiting for the hob that just handled it, resolved as answered (#573). */
    const settleCopies = (question: Question, first: number) =>
      question.recipientId === null
        ? Effect.succeed([])
        : ledger.settleQuestionCopies(question.id, question.recipientId, first);

    const answerQuestion: TaskRepository["Service"]["answerQuestion"] = (questionId, by, answer, at, from) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* openQuestion(questionId, by);
          // An answer that names one of its choices picked that choice, in the choice's own words (#740).
          const picked = optionNamed(before.options, answer);
          const question = new Question({
            ...before,
            state: "answered",
            answer: picked === null ? answer : (before.options[picked]?.label ?? answer),
            picked,
            answeredBy: by,
            answeredAt: at,
            answeredByDeviceId: from?.deviceId ?? null,
            answeredVia: from?.via ?? null,
            revision,
          });
          yield* saveQuestion(question);
          const settled = yield* settleCopies(before, revision + 1);
          return { value: question, events: [{ _tag: "QuestionAnswered", question } as const, ...settled] };
        }),
      );

    const escalateQuestion: TaskRepository["Service"]["escalateQuestion"] = (questionId, by) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* openQuestion(questionId, { _tag: "Lead", agentId: by });
          const task = yield* loadTask(before.taskId);
          const leads = leadsAbove(task, yield* read.treeOf(task.rootId));
          const question = new Question({
            ...before,
            recipientId: leads[leads.indexOf(by) + 1] ?? null,
            chain: [...before.chain, by],
            revision,
          });
          yield* saveQuestion(question);
          const settled = yield* settleCopies(before, revision + 1);
          return { value: question, events: [{ _tag: "QuestionEscalated", question } as const, ...settled] };
        }),
      );

    /**
     * Who a note goes to. You talk only to the lead: your note goes to the nearest one still at work,
     * or to the owner of a Task nobody leads. A lead's message goes to the owner of the open Task
     * directly under its own (#574).
     */
    const noteRecipient = (task: Task, senderId: AgentId | undefined, tree: ReadonlyArray<Task>) => {
      if (senderId === undefined) return Effect.succeed(noteRecipientOf(task, tree));
      const parent = tree.find((each) => each.id === task.parentId);
      if (parent?.ownerId !== senderId || task.ownerId === senderId) {
        return refuse("not-delegated", `Hob ${senderId} does not lead Task ${task.id}`);
      }
      return isTerminalTask(task.state)
        ? refuse("task-ended", `Task ${task.id} has ended`)
        : Effect.succeed(task.ownerId);
    };

    /**
     * The chat message of yours a lead's note traces back to (#900): the one its turn answers, else
     * that of the latest note the turn carries from its own lead, which it then passes on. A note you
     * leave traces back to none.
     */
    const noteOrigin = (input: NewNote) =>
      Effect.gen(function* () {
        if (input.senderId === undefined) return { messageId: null, fromNoteId: null };
        if (input.messageId !== undefined) return { messageId: input.messageId, fromNoteId: null };
        const picked = yield* read.carriedNote(input.carried ?? [], input.senderId);
        return picked === undefined
          ? { messageId: null, fromNoteId: null }
          : { messageId: picked.messageId, fromNoteId: picked.id };
      });

    const leaveNote: TaskRepository["Service"]["leaveNote"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const [left] = yield* read.note(input.id);
          if (left !== undefined) {
            if (!sameNote(left, input)) {
              return yield* refuse("note-key-reused", `Note ${input.id} was left with another Task, text or delivery`);
            }
            return { value: left, events: [] };
          }
          // A member's Task that ended can still be talked about while the work it is part of goes on.
          const task = yield* loadTask(input.taskId);
          const top = task.rootId === task.id ? task : yield* loadTask(task.rootId);
          if (isTerminalTask(top.state))
            return yield* refuse("task-ended", `The work Task ${task.id} is part of has ended`);
          const recipientId = yield* noteRecipient(task, input.senderId, yield* read.treeOf(task.rootId));
          const { messageId, fromNoteId } = yield* noteOrigin(input);
          const note = new TaskNote({
            id: input.id,
            taskId: input.taskId,
            text: input.text,
            createdAt: input.createdAt,
            senderId: input.senderId ?? null,
            recipientId,
            messageId,
            fromNoteId,
            delivery: input.delivery ?? "next-turn",
            revision,
          });
          yield* sql`INSERT INTO task_notes ${sql.insert({
            id: note.id,
            task_id: note.taskId,
            sender_id: note.senderId ?? null,
            recipient_id: note.recipientId,
            text: note.text,
            created_at: note.createdAt,
            message_id: note.messageId,
            from_note_id: note.fromNoteId,
            delivery: note.delivery,
            revision,
            left_revision: revision,
          })}`;
          return { value: note, events: [{ _tag: "NoteLeft", note } as const] };
        }),
      );

    const handOff: TaskRepository["Service"]["handOff"] = (artifactId, toTaskId, at) =>
      change(() =>
        Effect.gen(function* () {
          const [artifact] = yield* read.artifact(artifactId);
          if (artifact === undefined) return yield* refuse("artifact-missing", `No artifact ${artifactId}`);
          const [from, to] = [yield* loadTask(artifact.taskId), yield* openTask(toTaskId)];
          if (from.rootId !== to.rootId) return yield* refuse("artifact-outside-tree", "A hand-off stays in its tree");
          const [given] = yield* sql<{ readonly createdAt: string }>`SELECT created_at FROM hand_offs
            WHERE artifact_id = ${artifactId} AND to_task_id = ${toTaskId}`;
          if (given !== undefined) {
            return { value: new HandOff({ artifactId, toTaskId, createdAt: given.createdAt }), events: [] };
          }
          const handOff = new HandOff({ artifactId, toTaskId, createdAt: at });
          yield* sql`INSERT INTO hand_offs ${sql.insert({ artifact_id: artifactId, to_task_id: toTaskId, created_at: at })}`;
          return { value: handOff, events: [{ _tag: "HandedOff", handOff, artifact } as const] };
        }),
      );

    const waitFor: TaskRepository["Service"]["waitFor"] = (taskId, expected, input) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          const under = new Set(descendantsOf(before, yield* read.treeOf(before.rootId)).map((each) => each.id));
          if (input.on.length === 0 || input.on.some((id) => !under.has(id))) {
            return yield* refuse("wait-outside-subtree", "A Task waits only for Tasks under it");
          }
          // A new wait replaces the one the Task is already waiting on. A Task whose turn still runs
          // stays active until that turn ends.
          const stays = before.state === "waiting" || (input.keepActive === true && before.state === "active");
          const moved = stays ? before : yield* orFail(TaskTransitions.moveTo(before, "waiting", input.at));
          const task = new Task({ ...moved, updatedAt: input.at, revision });
          const wait = new TaskWait({ taskId, on: [...new Set(input.on)], mode: input.mode, createdAt: input.at });
          yield* sql`DELETE FROM task_waits WHERE task_id = ${taskId}`;
          yield* sql`INSERT INTO task_waits ${sql.insert({
            task_id: wait.taskId,
            waits_on: JSON.stringify(wait.on),
            mode: wait.mode,
            created_at: wait.createdAt,
          })}`;
          yield* saveTask(task);
          const automatically = stays ? [] : yield* automatic(task, input.at, revision + 1);
          return {
            value: { task, wait },
            events: [{ _tag: "TaskStateChanged", task, attempt: null, quest: null, wait } as const, ...automatically],
          };
        }),
      );

    return TaskRepository.of({
      createTask,
      startQuest,
      stopQuest,
      ...makeCriteriaChanges(sql, change),
      startAttempt,
      updateAttempt,
      resumeAttempt,
      moveTask,
      completeTask,
      retryTask,
      reassignTask,
      recordCheckpoint,
      askQuestion,
      answerQuestion,
      escalateQuestion,
      leaveNote,
      listWaitingQuestions: read.waitingQuestions.pipe(Effect.orDie),
      listFailedTasks: read.failedTasks.pipe(Effect.orDie),
      listQuestSummaries: (threadId) => readQuestSummaries(sql, threadId),
      handOff,
      waitFor,
      startTurn: (turn) =>
        Effect.all([
          sql`UPDATE attempt_turns SET ended_at = ${turn.startedAt}
            WHERE attempt_id = ${turn.attemptId} AND ended_at IS NULL AND started_at < ${turn.startedAt}`,
          sql`INSERT INTO attempt_turns ${sql.insert({
            attempt_id: turn.attemptId,
            agent_id: turn.agentId,
            runtime: turn.runtime,
            model: turn.model,
            started_at: turn.startedAt,
          })} ON CONFLICT (attempt_id, started_at) DO NOTHING`,
        ]).pipe(sql.withTransaction, Effect.asVoid, Effect.orDie),
      markAttemptReadWeb: (attemptId, mark) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const [before] = yield* read.attempt(attemptId);
            if (before === undefined) return null;
            // The mark keeps when the session first read the web, and names what it read last.
            const readWeb = { since: before.readWeb?.since ?? mark.since, source: mark.source };
            if (before.readWeb?.since === readWeb.since && before.readWeb.source === readWeb.source) return null;
            yield* sql`UPDATE attempts SET read_web_since = ${readWeb.since}, read_web_source = ${readWeb.source}
              WHERE id = ${attemptId}`;
            const attempt = new Attempt({ ...before, readWeb });
            return { value: attempt, events: [{ _tag: "AttemptReadWeb" as const, taskId: attempt.taskId, attempt }] };
          }),
        ),
      endTurn: (turn, usage, endedAt) =>
        sql`UPDATE attempt_turns SET ended_at = ${endedAt}, input_tokens = ${usage?.inputTokens ?? null},
          output_tokens = ${usage?.outputTokens ?? null}, cache_read_tokens = ${usage?.cacheReadTokens ?? null},
          cache_write_tokens = ${usage?.cacheWriteTokens ?? null}
          WHERE attempt_id = ${turn.attemptId} AND started_at = ${turn.startedAt}`.pipe(Effect.asVoid, Effect.orDie),
      readLedger: (taskId) =>
        read.task(taskId).pipe(
          Effect.flatMap(([task]) =>
            task === undefined
              ? Effect.succeedNone
              : ledger.readFor(task).pipe(Effect.map(({ ledger: open }) => Option.some(open))),
          ),
          sql.withTransaction,
          Effect.orDie,
        ),
      readTree: (taskId) => read.readTree(taskId).pipe(Effect.map(Option.fromNullishOr), Effect.orDie),
      readThreadTrees: (threadId) => read.threadTrees(threadId).pipe(Effect.orDie),
      findQuest: (questId) =>
        read.quest(questId).pipe(
          Effect.map(([quest]) => Option.fromNullishOr(quest)),
          Effect.orDie,
        ),
      listOpenTasks: (ownerId) =>
        sql<{ readonly id: string }>`SELECT id FROM tasks WHERE owner_id = ${ownerId}
          AND state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => read.task(row.id))),
          Effect.map((found) => found.flat()),
          Effect.orDie,
        ),
      handOverRefusal,
      openTaskCount: (ownerId) =>
        sql<{ readonly count: unknown }>`SELECT COUNT(*) AS count FROM tasks WHERE owner_id = ${ownerId}
          AND state NOT IN ('completed', 'failed', 'cancelled')`.pipe(
          Effect.map(([row]) => Number(row?.count ?? 0)),
          Effect.orDie,
        ),
      listMemberWork: (agentId) => read.memberWork(agentId).pipe(Effect.orDie),
      readHistoryRecords: (agentId) => read.historyRecords(agentId).pipe(Effect.orDie),
      listQueuedSteps: read.queuedSteps.pipe(Effect.orDie),
      listStrandedSteps: read.strandedSteps.pipe(Effect.orDie),
      listCancellingTasks: read.cancelling.pipe(Effect.orDie),
      listLiveAttempts: read.liveAttempts.pipe(Effect.orDie),
      listRootsAtWork: read.rootsAtWork.pipe(Effect.orDie),
    });
  }),
);
