import {
  isTerminalTask,
  pendingApprovals,
  type QuestSummary,
  type Task,
  type TaskTree,
  type WorkTone,
} from "@hobbots/domain";
import { summaryProgress } from "../../lib/led-quests.ts";
import { roomStatus, roomTone } from "./control-room.ts";
import type { RowStatus } from "./work-model.ts";

/**
 * How far a request's work got, as the quest pill, the room's header, the ticket and the finished
 * banner show it. A Quest's comes from the summary the hub publishes (ADR 037), never from its Task
 * states (STD-REACT-028). A Task that works alone has no Quest and no summary: it shows its own
 * record, its steps and what it asks you.
 */
export interface QuestProgress {
  /** The strip's segments, one per Task under the lead's, by tone. */
  readonly segments: ReadonlyArray<RowStatus>;
  readonly done: number;
  readonly total: number;
  /** What waits on you while the work runs. */
  readonly needs: number;
}

/** The strip's color for each tone of a Task. */
const toneSegment: Record<WorkTone, RowStatus> = {
  done: "done",
  needs: "blocked",
  problem: "failed",
  working: "running",
  waiting: "waiting",
  idle: "waiting",
};

/** The order the strip shows tones in: what is done first, then what needs a look, then the rest. */
const STRIP_ORDER: ReadonlyArray<WorkTone> = ["done", "problem", "needs", "working", "waiting", "idle"];

/** A Quest's progress from its summary. */
export const progressOfSummary = (summary: QuestSummary): QuestProgress => ({
  segments: STRIP_ORDER.flatMap((tone) => Array.from({ length: summary.tones[tone] }, () => toneSegment[tone])),
  ...summaryProgress(summary),
  needs: summary.needsYou,
});

/** A Quest whose summary has not been read yet shows no progress until it is. */
const UNREAD: QuestProgress = { segments: [], done: 0, total: 0, needs: 0 };

/**
 * What a Task working alone waits on you for while it runs: each question and approval that reached
 * you, and each failed step, which waits for a retry or another hob (ADR 027).
 */
const soloNeeds = (tree: TaskTree, steps: ReadonlyArray<Task>): number =>
  tree.questions.filter((question) => question.recipientId === null && question.state === "open").length +
  pendingApprovals(tree).length +
  steps.filter((step) => step.state === "failed").length;

/**
 * The progress of a request's work: its Quest's summary, or for a Task working alone its steps, or
 * itself with none, and what it asks you while it runs.
 */
export const questProgress = (tree: TaskTree, summary: QuestSummary | undefined): QuestProgress => {
  const top = tree.tasks[0];
  if (top === undefined) return UNREAD;
  const quest = tree.quests.find((each) => each.taskId === top.id);
  if (quest !== undefined) return summary === undefined ? UNREAD : progressOfSummary(summary);
  const steps = tree.tasks.filter((task) => task.id !== top.id);
  return {
    segments: (steps.length > 0 ? steps : [top]).map((task) => roomTone(roomStatus(tree, task))),
    done: steps.filter((task) => task.state === "completed").length,
    total: steps.length,
    needs: isTerminalTask(top.state) ? 0 : soloNeeds(tree, steps),
  };
};
