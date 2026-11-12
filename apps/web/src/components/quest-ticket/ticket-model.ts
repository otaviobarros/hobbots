import { type AgentId, type Quest, QuestStates, type Task, type TaskTree } from "@hobbots/domain";
import { laneRoom } from "../lanes/lane-model.ts";
import type { RoomStatus } from "../quest/control-room.ts";
import type { QuestProgress } from "../quest/quest-progress.ts";
import { taskTitle, workCard } from "../quest/work-model.ts";

/**
 * How a Quest that ended came to its end, as its top Task records it, or `stopped` when its lead
 * stopped it at your request (#1346): its Task was cancelled, but not by you.
 */
export type TicketEnd = "completed" | "failed" | "cancelled" | "stopped";

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
 * The ticket under the request that started a Task (ADR 027): the party in lane order, the
 * title, the progress, and how many things wait on you. It is built from the Task tree and the
 * progress the hub published for its Quest, so it stays the same size however much work the Quest does.
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

const endOf = (task: Task, quest: Quest | null): TicketEnd | null => {
  if (task.state !== "completed" && task.state !== "failed" && task.state !== "cancelled") return null;
  return quest !== null && QuestStates.stoppedByLead(quest) ? "stopped" : task.state;
};

const progressOf = (
  top: Task,
  quest: Quest | null,
  done: number,
  total: number,
  took: number | null,
): TicketProgress => {
  const end = endOf(top, quest);
  if (end !== null) return { kind: "ended", end, took: took ?? 0 };
  return total === 0 ? { kind: "started", at: top.createdAt } : { kind: "count", done, total };
};

/** The ticket for a request's Task tree and its progress, or null for a tree with no Task. */
export const questTicket = (tree: TaskTree, progress: QuestProgress): Ticket | null => {
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const party = laneRoom(tree, []).order.map((lane) => ({ hobId: lane.hobId, status: lane.status }));
  return {
    top,
    title: taskTitle(top),
    leadId: card.leadId,
    party,
    progress: progressOf(top, card.quest, progress.done, progress.total, card.took),
    needsYou: progress.needs,
  };
};
