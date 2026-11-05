import type { Task, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { OverflowTooltip } from "@hobbots/ui/components/overflow-tooltip";
import { formatWhen } from "../../lib/time.ts";
import { TaskBackpack } from "../backpack/quest-backpack.tsx";
import type { PickedTry } from "../lane-actions/lane-actions-model.ts";
import type { Lane } from "../lanes/lane-model.ts";
import { attemptCount, type RoomRow, roomRows, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import { TaskDetail } from "../quest/task-detail.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { TaskSummary } from "../workbench/summary/task-summary.tsx";
import { messages } from "./messages.ts";

const room = questCopy.room;

/**
 * The Task cards in a hob's lane, one per Task it owns on the Quest and each of its steps, in tree
 * order: the lane above them already tells what the hob did and who it waits on.
 */
export function TaskCards({
  tree,
  lane,
  tried,
  hobs,
  onOpen,
  onWorkbench,
}: {
  tree: TaskTree;
  lane: Lane;
  /** The earlier try picked for a Task, which its card names in place of its latest. */
  tried: (task: Task) => PickedTry | null;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const rows = roomRows(tree).filter((row) => row.task.ownerId === lane.hobId);
  return rows.map((row) => (
    <TaskCard
      key={row.task.id}
      tree={tree}
      row={row}
      tried={tried(row.task)}
      titled={rows.length > 1}
      hobs={hobs}
      onOpen={onOpen}
      onWorkbench={onWorkbench}
    />
  ));
}

/**
 * One of a hob's Tasks in its lane: which try it shows once there is more than one, how a picked
 * earlier one went, what waits in its backpack, and everything else behind a disclosure, Show in
 * the Workbench among it. A question for you, a failure and the controls are
 * the lane's own (lane-actions), as are its beats, marks and waits (ADR 027).
 */
function TaskCard({
  tree,
  row,
  tried,
  titled,
  hobs,
  onOpen,
  onWorkbench,
}: {
  tree: TaskTree;
  row: RoomRow;
  /** An earlier try picked in the lane, which the Task shows in place of its latest. */
  tried: PickedTry | null;
  /** Whether the lane holds more than one Task, so each says which it is. */
  titled: boolean;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const { task } = row;
  const attempts = attemptCount(tree, task);
  return (
    <section
      aria-label={taskTitle(task)}
      className="flex min-w-0 flex-col gap-2 border-t border-line pt-2.5 text-detail wrap-anywhere"
    >
      {titled && (
        <span className="flex items-center gap-2">
          <OverflowTooltip text={taskTitle(task)}>
            <h3 className="m-0 min-w-0 flex-1 truncate text-detail font-bold text-text-strong">{taskTitle(task)}</h3>
          </OverflowTooltip>
          <StatusTag status={roomTone(row.status)}>{roomStatusLabel(row.status)}</StatusTag>
        </span>
      )}
      {/* Which try it is only matters once there is more than one. */}
      {(tried !== null || attempts > 1) && (
        <p className="m-0 text-meta text-label">
          {messages.taskMeta({ attempt: tried?.number ?? attempts, age: formatWhen(task.createdAt) })}
        </p>
      )}
      {/* An earlier try picked in the lane says how it went; the lane shows the rest. */}
      {tried?.line != null && <p className="m-0 line-clamp-3 whitespace-pre-wrap text-text">{tried.line}</p>}
      <Flags row={row} hobs={hobs} />
      <TaskBackpack tree={tree} task={task} hobs={hobs} onOpen={onOpen} waiting />
      <details>
        <summary className="cursor-pointer text-label">{messages.details}</summary>
        <div className="mt-3 flex flex-col gap-4">
          <span className="flex">
            <Button variant="outline" size="xs" onClick={() => onWorkbench(task.id)}>
              {messages.showInWorkbench}
            </Button>
          </span>
          <TaskBackpack tree={tree} task={task} hobs={hobs} onOpen={onOpen} waiting={false} />
          <TaskSummary tree={tree} task={task} hobs={hobs} />
          <TaskDetail tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
        </div>
      </details>
    </section>
  );
}

/**
 * What else the Task says: that its hob started a Quest of its own but brought nobody in yet, and
 * that another Task changed a file this one changed too (#570, #576).
 */
function Flags({ row, hobs }: { row: RoomRow; hobs: HobLookup }) {
  const sameFile = row.sameFileAs.map((id) => hobs(id).name);
  const nobody = row.quest?.state === "active" && row.party.length === 0;
  if (!nobody && sameFile.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-meta">
      {nobody && <span className="text-lantern">{room.nobodyYet}</span>}
      {sameFile.length > 0 && <span className="text-rose">{room.sameFile({ names: questCopy.names(sameFile) })}</span>}
    </span>
  );
}
