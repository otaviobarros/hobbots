import type { TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { formatWhen } from "../../lib/time.ts";
import { TaskBackpack } from "../backpack/quest-backpack.tsx";
import { attemptCount, type RoomRow, roomStatusLabel, roomTone, waitingNames } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import { TaskDetail } from "../quest/task-detail.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { latestOf, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const room = questCopy.room;

/**
 * One of a hob's Tasks in its lane: where it stands in a line, Show in the Workbench, what its hob
 * waits on and everything else it holds behind a disclosure. A question for you, a failure and the
 * controls are the lane's own (lane-actions). The lane's own beats, marks and menu replace these
 * parts as the room grows (ADR 027).
 */
export function LaneTask({
  tree,
  row,
  titled,
  hobs,
  onOpen,
  onWorkbench,
}: {
  tree: TaskTree;
  row: RoomRow;
  /** Whether the lane holds more than one Task, so each says which it is. */
  titled: boolean;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const { task } = row;
  const waits = waitingNames(row, (id) => hobs(id).name);
  const line = task.result?.summary ?? latestOf(tree, task);
  return (
    <section aria-label={taskTitle(task)} className="flex min-w-0 flex-col gap-2 text-detail wrap-anywhere">
      {titled && (
        <span className="flex items-center gap-2">
          <h3 className="m-0 min-w-0 flex-1 truncate text-detail font-bold text-text-strong">{taskTitle(task)}</h3>
          <StatusTag status={roomTone(row.status)}>{roomStatusLabel(row.status)}</StatusTag>
        </span>
      )}
      <p className="m-0 text-meta text-label">
        {messages.taskMeta({ attempt: attemptCount(tree, task), age: formatWhen(task.createdAt) })}
      </p>
      {waits.length > 0 && (
        <p className="m-0 text-lantern">{questCopy.card.waitingOn({ names: questCopy.names(waits) })}</p>
      )}
      {line !== null && <p className="m-0 line-clamp-3 whitespace-pre-wrap text-text">{line}</p>}
      <Flags row={row} hobs={hobs} />
      <span className="flex">
        <Button variant="outline" size="xs" onClick={() => onWorkbench(task.id)}>
          {messages.showInWorkbench}
        </Button>
      </span>
      <TaskBackpack tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
      <details>
        <summary className="cursor-pointer text-label">{messages.details}</summary>
        <div className="mt-3">
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
