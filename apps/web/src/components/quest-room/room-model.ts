import type { AgentId, Task, TaskId, TaskTree } from "@hobbots/domain";
import { type RoomRow, roomRows } from "../quest/control-room.ts";

/**
 * One hob's lane in the Quest room (ADR 027): the hob, its Tasks on the Quest in tree order, and
 * the hobs it leads. A hob splitting its own work is not a party, so its steps stay in its lane,
 * and a hob with more than one Task keeps one lane.
 */
export interface RoomLane {
  readonly ownerId: AgentId;
  readonly rows: readonly [RoomRow, ...ReadonlyArray<RoomRow>];
  /** The Quest's lead: the owner of its top Task. */
  readonly lead: boolean;
  /** The hobs this hob brought in on a Quest of its own, a nested Quest. */
  readonly leads: ReadonlyArray<AgentId>;
}

/** The lanes of a Quest, the lead's first, then each hob in the order it joined. */
export const roomLanes = (tree: TaskTree): ReadonlyArray<RoomLane> => {
  const leadId = tree.tasks[0]?.ownerId;
  const lanes: Array<RoomLane> = [];
  for (const row of roomRows(tree)) {
    const at = lanes.findIndex((lane) => lane.ownerId === row.task.ownerId);
    const lane = lanes[at];
    const leads = row.party.filter((id) => id !== row.task.ownerId);
    if (lane === undefined) {
      lanes.push({ ownerId: row.task.ownerId, rows: [row], lead: row.task.ownerId === leadId, leads });
    } else {
      lanes[at] = {
        ...lane,
        rows: [...lane.rows, row],
        leads: [...lane.leads, ...leads.filter((id) => !lane.leads.includes(id))],
      };
    }
  }
  return lanes;
};

/** The lane that holds a Task, if any. */
export const laneOf = (lanes: ReadonlyArray<RoomLane>, taskId: TaskId | undefined): RoomLane | undefined =>
  taskId === undefined ? undefined : lanes.find((lane) => lane.rows.some((row) => row.task.id === taskId));

/**
 * The lane the room lights: the one the address names, else the one holding the Task a link named
 * when that is not the Quest's top Task. With none lit, the room shows everyone.
 */
export const litTask = (tree: TaskTree, named: Task, lane: TaskId | undefined): TaskId | undefined => {
  if (lane !== undefined && tree.tasks.some((task) => task.id === lane)) return lane;
  return named.id === tree.tasks[0]?.id ? undefined : named.id;
};

const ENDED: ReadonlyArray<RoomRow["status"]> = ["done", "cancelled", "unresolved"];

/** The Task a lane stands for: the first of its hob's Tasks that has not ended, else its last. */
export const laneTask = (lane: RoomLane): Task =>
  (lane.rows.find((row) => !ENDED.includes(row.status)) ?? lane.rows.at(-1) ?? lane.rows[0]).task;
