import type { NewCheckpoint } from "@hobbots/agents";
import {
  CheckpointId,
  descendantsOf,
  IDLE_QUEST,
  isIdleQuestFinding,
  isTerminalTask,
  type LedgerEntry,
  type Quest,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { newId } from "./call-scope.ts";
import type { TurnEndDeps } from "./turn-end.ts";

/** How a finding about an empty Quest starts, so it is reported once per Quest. */
const EMPTY_QUEST = "Started a Quest but has not brought anyone in";

/**
 * The finding a member's Task reports when the member's turn ended leaving a Quest it leads with
 * nobody in it and nothing to wait on, so the lead above it hears of it (#576). Null when the Task
 * leads no such Quest, has brought someone in, waits on something under it, or reported it already.
 */
export const emptyQuestFinding = (task: Task, tree: TaskTree, at: string): NewCheckpoint | null => {
  if (task.parentId === null) return null;
  const quest: Quest | undefined = tree.quests.find((each) => each.taskId === task.id && each.state === "active");
  if (quest === undefined) return null;
  const broughtIn = descendantsOf(task, tree.tasks).some((each) => each.ownerId !== task.ownerId);
  const waits = tree.waits.some((wait) => wait.taskId === task.id);
  const reported = tree.checkpoints.some(
    (each) => each.taskId === task.id && each.kind === "finding" && each.summary.startsWith(EMPTY_QUEST),
  );
  if (broughtIn || waits || reported) return null;
  return {
    id: CheckpointId.make(newId()),
    taskId: task.id,
    source: "unplanned",
    kind: "finding",
    milestoneId: null,
    summary: `${EMPTY_QUEST} (Quest ${quest.id}: ${quest.goal}). Its turn ended with nobody delegated to and nothing to wait on.`,
    createdAt: at,
  };
};

/** What a turn of the Task you asked for left its Quest as, when nothing moves the Quest on (#1081). */
export type IdleQuest =
  /** The lead is woken once with what is missing, by a finding that goes to it. */
  | { readonly _tag: "Wake"; readonly finding: NewCheckpoint }
  /** The lead was woken and still left nothing moving: the Task is blocked, so you see the Quest stalled. */
  | { readonly _tag: "Stalled"; readonly reason: string };

/** What the lead is told when its Quest has nothing moving it, in words a smaller model acts on. */
const idleDetail = (quest: Quest) =>
  [
    `Quest ${quest.id} (${quest.goal}) is still active, but your turn ended with no Task open under it and nothing to wait on, so nothing moves it on.`,
    "Writing the plan starts nothing: delegate the next Tasks with delegate_task, or plan steps with plan_steps.",
    "If the Quest's work is done and delivers what the user asked for, call complete_task with its result and delivered: true. If you need the user, ask. If the user asked you to stop it, call stop_quest.",
  ].join(" ");

/** Why the Task you asked for is blocked when its Quest stalled, for you to act on. */
const stalledReason = (quest: Quest) =>
  `The Quest stalled: its lead was told that nothing moves Quest ${quest.id} (${quest.goal}) on, and its next turn again ended with no Task open under it and nothing to wait on. Tell the lead what to do next, or cancel the Quest.`;

/**
 * What a turn that replied on the Task you asked for leaves its active Quest as, read once the turn
 * has ended (#1081). Null while anything moves the Quest on or will wake its lead: a Task open under
 * it, a wait that holds, a question, an approval, or backpack work the turn did not carry. Its own
 * unreported milestones move nothing. The lead is woken once since it last brought work in; a later
 * turn that still leaves the Quest so stalls it.
 */
export const idleQuestOf = (
  task: Task,
  tree: TaskTree,
  open: ReadonlyArray<LedgerEntry>,
  carried: ReadonlySet<string>,
  at: string,
): IdleQuest | null => {
  if (task.parentId !== null || isTerminalTask(task.state) || task.state === "cancelling" || task.state === "blocked")
    return null;
  const quest = tree.quests.find((each) => each.taskId === task.id && each.state === "active");
  if (quest === undefined) return null;
  const moving = open.some(
    (entry) => entry._tag !== "Milestone" && (entry._tag !== "Item" || !carried.has(entry.item.id)),
  );
  if (moving) return null;
  // When work was last brought in under it: a wake from before that is about work since done.
  const lastIn = Math.max(0, ...descendantsOf(task, tree.tasks).map((each) => Date.parse(each.createdAt)));
  const woken = tree.checkpoints.some(
    (each) => each.taskId === task.id && isIdleQuestFinding(each) && Date.parse(each.createdAt) >= lastIn,
  );
  if (woken) return { _tag: "Stalled", reason: stalledReason(quest) };
  return {
    _tag: "Wake",
    finding: {
      id: CheckpointId.make(newId()),
      taskId: task.id,
      source: "automatic",
      kind: "finding",
      milestoneId: null,
      summary: IDLE_QUEST,
      detail: idleDetail(quest),
      createdAt: at,
    },
  };
};

/**
 * Once a turn on the Task you asked for has replied, wakes its lead when the turn left its Quest
 * with nothing moving it, or blocks the Task when the lead was woken and still left it so (#1081).
 * A change the records refuse, as when the Task moved on meanwhile, changes nothing.
 */
export const flagIdleQuest = (deps: TurnEndDeps, taskId: TaskId, carried: ReadonlySet<string>, at: string) =>
  Effect.gen(function* () {
    const tree = Option.getOrUndefined(yield* deps.tasks.readTree(taskId));
    const task = tree?.tasks[0];
    if (tree === undefined || task === undefined) return;
    // Only a Task that leads an active Quest can be left idle so: any other reads nothing more.
    if (!tree.quests.some((each) => each.taskId === task.id && each.state === "active")) return;
    const ledger = yield* deps.tasks.readLedger(task.id);
    if (Option.isNone(ledger)) return;
    const idle = idleQuestOf(task, tree, ledger.value.open, carried, at);
    if (idle === null) return;
    if (idle._tag === "Wake") {
      yield* deps.attempt(deps.tasks.recordCheckpoint(idle.finding), "wake the lead of an idle Quest");
      return;
    }
    yield* deps.attempt(
      deps.tasks.moveTask(task.id, task.revision, "blocked", at, { reason: idle.reason }),
      "block a stalled Quest",
    );
  });

/**
 * Looks again, as the hub starts, at each Quest you asked for that is still at work (#1081). A turn's
 * end commits before its wake is recorded, so a hub that stopped in between left a Quest idle with
 * nothing to wake its lead; this records what that turn's end would have. It is idempotent: a wake
 * already recorded is open backpack work, which moves nothing on only once a turn has carried it.
 * Runs once no Attempt is live, so no turn's own end is racing it.
 */
export const recoverIdleQuests = (deps: TurnEndDeps, at: string) =>
  Effect.gen(function* () {
    for (const rootId of yield* deps.tasks.listRootsAtWork) yield* flagIdleQuest(deps, rootId, new Set(), at);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not look over idle Quests", cause)));
