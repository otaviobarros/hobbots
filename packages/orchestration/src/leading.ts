import type { TaskRepository } from "@hobbots/agents";
import {
  type ApprovalRequest,
  descendantsOf,
  detailOf,
  isTerminalTask,
  liveAttemptOn,
  type NoteDelivery,
  NoteId,
  pendingApprovalsOn,
  type Question,
  type RuntimeKind,
  reportsOn,
  type Task,
  TaskReadiness,
  type TaskToolInput,
  type TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import {
  approvalsWaiting,
  type CallScope,
  describeApproval,
  fromRecords,
  journalOf,
  ledTask,
  nameFor,
  newId,
  outcomesShown,
  ownTask,
  questionChoices,
  refuse,
} from "./call-scope.ts";
import { describeCriterion } from "./criteria.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  /** Whether a turn on `runtime` takes a message while it runs (#1345); otherwise steering one interrupts it. */
  readonly steersTurns: (runtime: RuntimeKind) => boolean;
}

/** How many of a Task's latest checkpoints `read_tasks` shows. */
const RECENT_CHECKPOINTS = 3;

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

/** What a Task waits on now: the Tasks its owner waits for, and its dependencies, while open. */
const waitingOn = (task: Task, tree: TaskTree): ReadonlyArray<string> => {
  const open = (id: string) => {
    const each = tree.tasks.find((candidate) => candidate.id === id);
    return each !== undefined && !isTerminalTask(each.state);
  };
  const waited = tree.waits.find((wait) => wait.taskId === task.id)?.on ?? [];
  return [
    ...new Set([
      ...(task.state === "waiting" ? waited.filter(open) : []),
      ...TaskReadiness.unmet(TaskReadiness.of(task, tree.tasks)),
    ]),
  ];
};

/**
 * A question as `read_tasks` reports it: its state as the hub records it, who it waits for while
 * open, and its answer once answered, so a lead never tells the user one is unanswered from memory (#659).
 */
const describeQuestion = (question: Question, caller: string) => ({
  question_id: question.id as string,
  question: question.text,
  ...questionChoices(question),
  state: question.state,
  ...(question.state === "open" && { waits_for: nameFor(question.recipientId, caller) }),
  ...(question.state === "answered" && {
    answer: question.answer,
    ...(question.options.length > 0 && { picked_a_choice: question.picked !== null }),
    answered_by: nameFor(question.answeredBy?._tag === "Lead" ? question.answeredBy.agentId : null, caller),
  }),
});

/** The artifacts a Task returned, by the id hand_off takes (#1088); nothing when it returned none. */
const artifactsOf = (task: Task, tree: TaskTree) => {
  const artifacts = tree.artifacts
    .filter((artifact) => artifact.taskId === task.id)
    .map((artifact) => ({ artifact_id: artifact.id as string, label: artifact.label, kind: artifact.kind }));
  return artifacts.length === 0 ? {} : { artifacts };
};

/** One Task as `read_tasks` reports it: where it stands, what holds it and what it last said. */
const describeTask = (task: Task, tree: TaskTree, caller: string) => {
  // What its hob and the hub reported, newest first; the hub's own state changes show in `state`.
  const reported = tree.checkpoints
    .filter((each) => each.taskId === task.id && reportsOn(each))
    .toSorted((a, b) => b.revision - a.revision)
    .slice(0, RECENT_CHECKPOINTS);
  return {
    task_id: task.id as string,
    parent_id: task.parentId as string | null,
    owner: task.ownerId as string,
    brief: firstLine(task.brief),
    state: task.state,
    turn_running: liveAttemptOn(task, tree),
    waiting_on: waitingOn(task, tree),
    questions: tree.questions
      .filter((question) => question.taskId === task.id)
      .map((question) => describeQuestion(question, caller)),
    // Its turn is paused on these until the user decides them (#698).
    approvals: pendingApprovalsOn(tree, task.id).map(describeApproval),
    // The detail travels with its summary, bounded, so a lead reads what the hob put beyond the beat (#901).
    recent_checkpoints: reported.map((each) => {
      const detail = detailOf(each);
      return { kind: each.kind, summary: each.summary, ...(detail === null ? {} : { detail }), at: each.createdAt };
    }),
    ...(task.result === null ? {} : { result: task.result.summary }),
    ...artifactsOf(task, tree),
  };
};

/** What a turn running on a member's Task is doing as a message arrives; undefined when none runs, so it wakes the member. */
type Held =
  | { readonly held: "turn-running"; readonly runtime: RuntimeKind | null }
  | { readonly held: "approval-pending"; readonly runtime: RuntimeKind | null; readonly approval: ApprovalRequest };

/** The turn running on a member's Task now, and the approval request it waits on, if any (#701). */
const heldBy = (tasks: TaskRepository["Service"], task: Task, tree: TaskTree): Effect.Effect<Held | undefined> => {
  if (!liveAttemptOn(task, tree)) return Effect.succeed(undefined);
  const runtime = tree.attempts.find((each) => each.id === task.currentAttemptId)?.runtime ?? null;
  return Effect.map(tasks.readLedger(task.id), (ledger): Held => {
    const approval = Option.getOrUndefined(ledger)?.open.flatMap((entry) =>
      entry._tag === "Approval" ? [entry.approval] : [],
    )[0];
    return approval === undefined ? { held: "turn-running", runtime } : { held: "approval-pending", runtime, approval };
  });
};

/**
 * How a message reaches a member's running turn (#1345): as asked, with `steer` by default, except
 * that a runtime that cannot take input while a turn runs is interrupted instead.
 */
const deliveryFor = (asked: NoteDelivery | undefined, held: Held | undefined, steers: Deps["steersTurns"]) => {
  const wanted = asked ?? "steer";
  const fellBack = wanted === "steer" && held?.runtime != null && !steers(held.runtime);
  return { stored: wanted, reaches: fellBack ? ("interrupt" as const) : wanted, fellBack };
};

/** What `message_task` tells its sender: when the member reads it, and why then. */
const sentText = (task: Task, held: Held | undefined, delivery: ReturnType<typeof deliveryFor>) => {
  const to = `hob ${task.ownerId} on Task ${task.id}`;
  if (held === undefined)
    return `Sent to ${to}. It reaches them in their next turn, and wakes them if they are not working.`;
  const kept = "It is kept, so do not send it again.";
  if (delivery.reaches === "interrupt") {
    const why = delivery.fellBack ? " Their runtime cannot take a message while a turn runs, so" : "";
    return `Sent to ${to}.${why}${why === "" ? " Their" : " their"} turn stops now and starts again with your message first; what it did so far is kept. ${kept}`;
  }
  if (delivery.reaches === "steer") {
    const when =
      held.held === "turn-running"
        ? "They are in a turn, so it reaches them at its next step, between two tool calls."
        : `Their turn waits for the user to decide their request "${held.approval.label}", so it reaches them at the turn's next step once that is decided.`;
    return `Sent to ${to}. ${when} If the turn ends first, it reaches them as their next turn starts. ${kept}`;
  }
  const why =
    held.held === "turn-running"
      ? "they are in a turn now, and you asked for it to wait for the next one"
      : `their turn waits for the user to decide their request "${held.approval.label}"`;
  return `Held for ${to}: ${why}. They read your message once that turn ends, as their next turn starts. ${kept}`;
};

/** The acceptance criteria of the Quest on `root`, as read_tasks shows them (#1445); nothing when it has none. */
const criteriaOn = (scope: CallScope, root: Task) => {
  const quest = scope.tree.quests.find((each) => each.taskId === root.id);
  return quest === undefined || quest.criteria.length === 0
    ? {}
    : { quest_id: quest.id as string, criteria: quest.criteria.map(describeCriterion) };
};

/** The Task `read_tasks` reads under: one the caller owns, or one under a Task of its own. */
const readRoot = (scope: CallScope, id: string | undefined): Effect.Effect<Task, TaskToolRefused> =>
  id === undefined ? ownTask(scope, undefined) : ownTask(scope, id).pipe(Effect.catch(() => ledTask(scope, id)));

/**
 * Tools a lead keeps track of and talks to the work under it with (#574): it reads the state of
 * every Task under one of its own, at any depth, and sends a member a message that wakes it.
 */
export const makeLeading = ({ tasks, steersTurns }: Deps) => ({
  read_tasks: (scope: CallScope, input: Omit<TaskToolInput<"read_tasks">, "key">) =>
    Effect.gen(function* () {
      const root = yield* readRoot(scope, input.task_id);
      // A request that ended is never reopened; a member's Task under it can be retried.
      const top = scope.tree.tasks[0];
      const ended = top !== undefined && isTerminalTask(top.state) ? top : undefined;
      const under = descendantsOf(root, scope.tree.tasks);
      const listed = under.map((task) => describeTask(task, scope.tree, scope.caller.agentId));
      return {
        done: {
          message:
            listed.length === 0
              ? `Nothing is under Task ${root.id} yet.`
              : `${listed.length === 1 ? "1 Task is" : `${listed.length} Tasks are`} under Task ${root.id}, at every depth. This is what the records say now; nothing else is known.${
                  ended === undefined
                    ? ""
                    : ` Task ${ended.id} ended as ${ended.state}, so nothing under it changes now.`
                } ${approvalsWaiting(listed.reduce((sum, task) => sum + task.approvals.length, 0))}`.trimEnd(),
          details: { tasks: listed, ...criteriaOn(scope, root) },
        },
        entries: [],
        // It shows each ended Task's state and result, as a briefing does: the turn has read them.
        shown: yield* outcomesShown(tasks, scope, under),
      };
    }),

  message_task: (scope: CallScope, input: Omit<TaskToolInput<"message_task">, "key">) =>
    Effect.gen(function* () {
      const task = yield* ledTask(scope, input.task_id);
      const parent = scope.tree.tasks.find((each) => each.id === task.parentId);
      if (parent?.ownerId !== scope.caller.agentId || task.ownerId === scope.caller.agentId) {
        return yield* refuse(
          "not-lead",
          `Task ${task.id} is not a member's Task directly under one of yours. Message the hob that leads it instead.`,
        );
      }
      if (isTerminalTask(task.state)) {
        return yield* refuse("task-state", `Task ${task.id} has ended as ${task.state}, so nobody would read it.`);
      }
      const held = yield* heldBy(tasks, task, scope.tree);
      const delivery = deliveryFor(input.delivery, held, steersTurns);
      const journal = journalOf();
      const note = journal.keep(
        yield* fromRecords(
          tasks.leaveNote({
            id: NoteId.make(newId()),
            taskId: task.id,
            text: input.text,
            createdAt: scope.at,
            senderId: scope.caller.agentId,
            // Where it came from, for the steer receipt of the message of yours behind it (#900).
            ...(scope.caller.messageId !== undefined && { messageId: scope.caller.messageId }),
            // Only what the turn was given under its claims: an item a call only showed it was not picked up.
            carried: (scope.caller.carried ?? []).flatMap((item) => (item.owner === null ? [] : [item.itemId])),
            // What the sender asked, so a turn that runs as it arrives gets it that way (#1345).
            delivery: delivery.reaches,
          }),
        ),
      );
      return {
        done: {
          message: sentText(task, held, delivery),
          details: {
            message_id: note.id,
            recipient: note.recipientId,
            ...(held !== undefined && { turn_running: true, delivery: delivery.reaches }),
            ...(held !== undefined && delivery.reaches === "next-turn" && { held: held.held }),
            ...(held?.held === "approval-pending" && { approval_id: held.approval.id }),
          },
        },
        entries: journal.entries,
      };
    }),
});
