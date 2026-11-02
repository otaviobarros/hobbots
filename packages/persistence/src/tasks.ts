import { type NewTask, type TaskCompletion, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  type Answerer,
  ArtifactRef,
  Attempt,
  ancestorsOf,
  CHECKPOINT_KINDS,
  Checkpoint,
  CheckpointId,
  type CheckpointKind,
  Delegation,
  descendantsOf,
  HandOff,
  IllegalTaskTransition,
  isLiveAttempt,
  isTerminalTask,
  type JournaledEvent,
  leadsAbove,
  ledgerRefusal,
  Milestone,
  noteRecipientOf,
  Quest,
  Question,
  type QuestState,
  questPlacement,
  StaleTask,
  Task,
  type TaskId,
  TaskNote,
  type TaskRefusal,
  TaskRefused,
  type TaskState,
  type TaskTarget,
  TaskTransitions,
  TaskWait,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { makeLedger } from "./ledger.ts";
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

/** The Quest state a Task's terminal state ends its Quest with. */
const QUEST_END: Partial<Record<TaskState, QuestState>> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** The SQL store of Tasks, Quests and their records, for SQLite and PostgreSQL (ADR 011, ADR 018). */
export const TaskRepositoryLive = Layer.effect(
  TaskRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
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

    /** The Task at the revision the change was decided on. */
    const current = (id: string, revision: number) =>
      loadTask(id).pipe(
        Effect.flatMap((task) =>
          task.revision === revision
            ? Effect.succeed(task)
            : Effect.fail(new StaleTask({ taskId: task.id, expected: revision, actual: task.revision })),
        ),
      );

    const saveTask = (task: Task) => {
      const { id, ...columns } = taskColumns(task);
      return sql`UPDATE tasks SET ${sql.update(columns)} WHERE id = ${id}`;
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

    /** Ends the Quest on `task`, if it has one, with the Task's terminal state. */
    const endQuest = (task: Task, at: string, revision: number) =>
      Effect.gen(function* () {
        const state = QUEST_END[task.state];
        const [quest] = state === undefined ? [] : yield* read.questsOn([task.id]);
        if (quest === undefined || state === undefined) return null;
        const ended = new Quest({ ...quest, state, endedAt: at, revision });
        yield* sql`UPDATE quests SET state = ${state}, ended_at = ${at}, revision = ${revision} WHERE id = ${quest.id}`;
        return ended;
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

    /** A retry reopens a Task only under ancestors that are still open, and reopens its Quest with it. */
    const reopen = (task: Task, revision: number) =>
      Effect.gen(function* () {
        if (task.state !== "failed") return null;
        const ended = ancestorsOf(task, yield* read.treeOf(task.rootId)).find((at) => isTerminalTask(at.state));
        if (ended !== undefined) return yield* refuse("parent-ended", `Task ${ended.id} is ${ended.state}`);
        const [quest] = yield* read.questsOn([task.id]);
        if (quest === undefined) return null;
        yield* sql`UPDATE quests SET state = 'active', ended_at = NULL, revision = ${revision} WHERE id = ${quest.id}`;
        return new Quest({ ...quest, state: "active", endedAt: null, revision });
      });

    const startAttempt: TaskRepository["Service"]["startAttempt"] = (taskId, expected, input) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          if (yield* liveAttempt(before)) return yield* refuse("attempt-live", `Task ${taskId} has a live Attempt`);
          const quest = yield* reopen(before, revision);
          const task = new Task({
            ...(yield* orFail(TaskTransitions.start(before, input.id, input.startedAt))),
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

    const updateAttempt: TaskRepository["Service"]["updateAttempt"] = (attemptId, update) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* read.attempt(attemptId);
          if (before === undefined) return yield* refuse("attempt-missing", `No Attempt ${attemptId}`);
          if (!isLiveAttempt(before.state)) return yield* refuse("attempt-ended", `Attempt ${attemptId} has ended`);
          if (update.state === "running" && before.state === "running") {
            return yield* refuse("attempt-live", `Attempt ${attemptId} is already running`);
          }
          const ended = update.state !== "running";
          const attempt = new Attempt({
            ...before,
            state: update.state,
            sessionId: update.sessionId ?? before.sessionId,
            outcome: update.outcome ?? before.outcome,
            endedAt: ended ? update.at : null,
          });
          yield* sql`UPDATE attempts SET state = ${attempt.state}, session_id = ${attempt.sessionId},
            outcome = ${attempt.outcome}, ended_at = ${attempt.endedAt} WHERE id = ${attempt.id}`;
          const task = new Task({ ...(yield* loadTask(attempt.taskId)), updatedAt: update.at, revision });
          yield* saveTask(task);
          return {
            value: { task, attempt },
            events: [{ _tag: "TaskStateChanged", task, attempt, quest: null, wait: null } as const],
          };
        }),
      );

    const moveTask: TaskRepository["Service"]["moveTask"] = (taskId, expected, to: TaskTarget, at) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* current(taskId, expected);
          if (to === "failed" || to === "cancelled") yield* endable(before);
          const task = new Task({ ...(yield* orFail(TaskTransitions.moveTo(before, to, at))), revision });
          yield* saveTask(task);
          const quest = yield* endQuest(task, at, revision);
          return {
            value: task,
            events: [
              { _tag: "TaskStateChanged", task, attempt: null, quest, wait: null } as const,
              ...(yield* automatic(task, at, revision + 1)),
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
          const quest = yield* endQuest(task, completion.at, revision + events.length);
          if (quest !== null) events.push({ _tag: "QuestCompleted", quest });
          const by = yield* ledger.consumer(completion.attemptId);
          events.push(...(yield* ledger.consume(settles.consumes, by, revision + events.length)));
          events.push(...(yield* ledger.retire(settles.superseded, revision + events.length)));
          return { value: task, events };
        }),
      );

    /** The milestone a planned checkpoint reaches, marked reached; null for any other checkpoint. */
    const reach = (input: Parameters<TaskRepository["Service"]["recordCheckpoint"]>[0]) =>
      Effect.gen(function* () {
        if (input.kind !== "milestone") {
          if (input.milestoneId !== null) return yield* refuse("milestone-mismatch", "Only a milestone names one");
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
        yield* sql`UPDATE milestones SET reached_at = ${input.createdAt} WHERE id = ${input.milestoneId}`;
        return new Milestone({
          id: input.milestoneId,
          taskId: input.taskId,
          title: row.title,
          position: Number(row.position),
          reachedAt: input.createdAt,
          createdAt: row.createdAt,
        });
      });

    const recordCheckpoint: TaskRepository["Service"]["recordCheckpoint"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const task = yield* openTask(input.taskId);
          if (!CHECKPOINT_KINDS[input.source].includes(input.kind)) {
            return yield* refuse("checkpoint-kind", `A ${input.source} checkpoint is not a ${input.kind}`);
          }
          const milestone = yield* reach(input);
          const checkpoint = new Checkpoint({ ...input, attemptId: task.currentAttemptId, revision });
          yield* insertCheckpoint(checkpoint);
          return { value: checkpoint, events: [{ _tag: "CheckpointRecorded", checkpoint, milestone } as const] };
        }),
      );

    const askQuestion: TaskRepository["Service"]["askQuestion"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const task = yield* openTask(input.taskId);
          if (task.ownerId !== input.askerId) return yield* refuse("not-asker", "Only a Task's owner asks about it");
          const [lead] = leadsAbove(task, yield* read.treeOf(task.rootId));
          const question = new Question({
            ...input,
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
            revision,
          })}`;
          return { value: question, events: [{ _tag: "QuestionAsked", question } as const] };
        }),
      );

    const openQuestion = (questionId: string, by: Answerer) =>
      Effect.gen(function* () {
        const [question] = yield* read.question(questionId);
        if (question === undefined) return yield* refuse("question-missing", `No question ${questionId}`);
        if (question.state !== "open") return yield* refuse("question-answered", `Question ${questionId} is answered`);
        // A question about work that ended has nobody left to hear its answer.
        const task = yield* loadTask(question.taskId);
        const top = task.rootId === task.id ? task : yield* loadTask(task.rootId);
        if (isTerminalTask(task.state) || isTerminalTask(top.state))
          return yield* refuse("task-ended", `The work question ${questionId} is about has ended`);
        const recipient = by._tag === "User" ? null : by.agentId;
        if (question.recipientId !== recipient) return yield* refuse("not-recipient", "Only its recipient answers it");
        return question;
      });

    const saveQuestion = (question: Question) =>
      sql`UPDATE questions SET recipient_id = ${question.recipientId}, chain = ${JSON.stringify(question.chain)},
        state = ${question.state}, answer = ${question.answer},
        answered_by = ${question.answeredBy === null ? null : JSON.stringify(question.answeredBy)},
        answered_at = ${question.answeredAt}, revision = ${question.revision} WHERE id = ${question.id}`;

    const answerQuestion: TaskRepository["Service"]["answerQuestion"] = (questionId, by, answer, at) =>
      change((revision) =>
        Effect.gen(function* () {
          const before = yield* openQuestion(questionId, by);
          const question = new Question({
            ...before,
            state: "answered",
            answer,
            answeredBy: by,
            answeredAt: at,
            revision,
          });
          yield* saveQuestion(question);
          return { value: question, events: [{ _tag: "QuestionAnswered", question } as const] };
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
          return { value: question, events: [{ _tag: "QuestionEscalated", question } as const] };
        }),
      );

    const leaveNote: TaskRepository["Service"]["leaveNote"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          const [left] = yield* read.note(input.id);
          if (left !== undefined) {
            if (left.taskId !== input.taskId || left.text !== input.text) {
              return yield* refuse("note-key-reused", `Note ${input.id} was left with another Task or text`);
            }
            return { value: left, events: [] };
          }
          // A member's Task that ended can still be talked about while the work it is part of goes on.
          const task = yield* loadTask(input.taskId);
          const top = task.rootId === task.id ? task : yield* loadTask(task.rootId);
          if (isTerminalTask(top.state))
            return yield* refuse("task-ended", `The work Task ${task.id} is part of has ended`);
          // You talk only to the lead: the note goes to the nearest one still at work, or to the owner of a Task nobody leads.
          const recipientId = noteRecipientOf(task, yield* read.treeOf(task.rootId));
          const note = new TaskNote({ ...input, recipientId, revision });
          yield* sql`INSERT INTO task_notes ${sql.insert({
            id: note.id,
            task_id: note.taskId,
            recipient_id: note.recipientId,
            text: note.text,
            created_at: note.createdAt,
            revision,
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
          // A new wait replaces the one the Task is already waiting on.
          const moved =
            before.state === "waiting" ? before : yield* orFail(TaskTransitions.moveTo(before, "waiting", input.at));
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
          const automatically = before.state === "waiting" ? [] : yield* automatic(task, input.at, revision + 1);
          return {
            value: { task, wait },
            events: [{ _tag: "TaskStateChanged", task, attempt: null, quest: null, wait } as const, ...automatically],
          };
        }),
      );

    return TaskRepository.of({
      createTask,
      startQuest,
      startAttempt,
      updateAttempt,
      moveTask,
      completeTask,
      recordCheckpoint,
      askQuestion,
      answerQuestion,
      escalateQuestion,
      leaveNote,
      listWaitingQuestions: read.waitingQuestions.pipe(Effect.orDie),
      handOff,
      waitFor,
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
      openTaskCount: (ownerId) =>
        sql<{ readonly count: unknown }>`SELECT COUNT(*) AS count FROM tasks WHERE owner_id = ${ownerId}
          AND state NOT IN ('completed', 'failed', 'cancelled')`.pipe(
          Effect.map(([row]) => Number(row?.count ?? 0)),
          Effect.orDie,
        ),
      listMemberWork: (agentId) => read.memberWork(agentId).pipe(Effect.orDie),
      listQueuedSteps: read.queuedSteps.pipe(Effect.orDie),
      listStrandedSteps: read.strandedSteps.pipe(Effect.orDie),
      listLiveAttempts: read.liveAttempts.pipe(Effect.orDie),
    });
  }),
);
