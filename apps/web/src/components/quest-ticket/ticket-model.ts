import { type AgentId, isTerminalTask, type Task, type TaskTree } from "@hobbots/domain";
import type { RoomStatus } from "../quest/control-room.ts";
import { taskTitle, workCard, workCounts } from "../quest/work-model.ts";
import { laneTask, roomLanes } from "../quest-room/room-model.ts";

/** How a Quest that ended came to its end, as its top Task records it. */
export type TicketEnd = "completed" | "failed" | "cancelled";

/** What the ticket says of the work beside its title. */
export type TicketProgress =
  /** A Quest still running: how many of the Tasks under the lead's are done. */
  | { readonly kind: "count"; readonly done: number; readonly total: number }
  /** A Task working alone, with no party: when it started. */
  | { readonly kind: "started"; readonly at: string }
  /** Work that ended: how, and how long it ran, in milliseconds. */
  | { readonly kind: "ended"; readonly end: TicketEnd; readonly took: number };

/** One hob of the party on the ticket, in its lane's order, with where its lane stands. */
interface TicketHob {
  readonly hobId: AgentId;
  readonly status: RoomStatus;
}

/**
 * The one-line ticket under the request that started a Task (ADR 027): the party in lane order, the
 * title, the progress, and how many things wait on you. It is built from the Task tree alone, so it
 * stays the same size however much work the Quest does.
 */
export interface Ticket {
  readonly top: Task;
  readonly title: string;
  readonly leadId: AgentId;
  readonly party: ReadonlyArray<TicketHob>;
  readonly progress: TicketProgress;
  /** Questions and approvals that reached you, and Tasks that failed, while the work runs. */
  readonly needsYou: number;
}

const endOf = (task: Task): TicketEnd | null =>
  task.state === "completed" || task.state === "failed" || task.state === "cancelled" ? task.state : null;

const progressOf = (top: Task, done: number, total: number): TicketProgress => {
  const end = endOf(top);
  if (end !== null) {
    return { kind: "ended", end, took: Math.max(0, Date.parse(top.updatedAt) - Date.parse(top.createdAt)) };
  }
  return total === 0 ? { kind: "started", at: top.createdAt } : { kind: "count", done, total };
};

/**
 * What waits on you in a running Quest: each question and approval that reached you, and each failed
 * Task, which waits for a retry or another hob (ADR 027). An ended Quest asks nothing more.
 */
const needsYouOf = (tree: TaskTree, top: Task): number => {
  if (isTerminalTask(top.state)) return 0;
  const counts = workCounts(tree);
  return counts["needs-you"] + counts.failed;
};

/** The ticket for a request's Task tree, or null for a tree with no Task. */
export const questTicket = (tree: TaskTree): Ticket | null => {
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const party = roomLanes(tree).map((lane) => {
    const shown = laneTask(lane);
    const row = lane.rows.find((each) => each.task.id === shown.id) ?? lane.rows[0];
    return { hobId: lane.ownerId, status: row.status };
  });
  return {
    top,
    title: taskTitle(top),
    leadId: card.leadId,
    party,
    progress: progressOf(top, card.progress.done, card.progress.total),
    needsYou: needsYouOf(tree, top),
  };
};
