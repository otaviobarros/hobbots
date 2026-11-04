import type { TaskId, TaskTree } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { type HobState, HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { ActedLane, LaneSlots } from "../lane-actions/lane-slots.tsx";
import { type RoomStatus, roomStatusLabel, roomTone, waitedTaskCount } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { questionForYou, taskTitle } from "../quest/work-model.ts";
import { LaneTask } from "./lane-task.tsx";
import { messages } from "./messages.ts";
import { laneElementId } from "./room-header.tsx";
import { laneOf, laneTask, type RoomLane } from "./room-model.ts";
import type { RoomMoves } from "./room-search.ts";

/** The sprite's mood in its lane header: working hops, waiting dozes. */
const MOOD: Partial<Record<RoomStatus, HobState>> = {
  running: "working",
  waiting: "waiting",
  "needs-you": "needs-you",
  failed: "failed",
  blocked: "failed",
};

/**
 * A lane per hob on the Quest (ADR 027), side by side; the row scrolls sideways when they do not
 * fit. Clicking a lane's header lights it and shows that hob's work in the Workbench; clicking it
 * again shows everyone.
 */
export function RoomLanes({
  tree,
  lanes,
  lit,
  hobs,
  moves,
  slots,
}: {
  tree: TaskTree;
  lanes: ReadonlyArray<RoomLane>;
  lit: TaskId | undefined;
  hobs: HobLookup;
  moves: RoomMoves;
  slots: (lane: ActedLane) => LaneSlots;
}) {
  const litLane = laneOf(lanes, lit);
  return (
    <section aria-label={messages.lanes} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 py-3.5">
      {lanes.map((lane) => (
        <Lane
          key={lane.ownerId}
          tree={tree}
          lane={lane}
          lit={litLane?.ownerId === lane.ownerId}
          hobs={hobs}
          moves={moves}
          slots={slots}
        />
      ))}
    </section>
  );
}

function Lane({
  tree,
  lane,
  lit,
  hobs,
  moves,
  slots,
}: {
  tree: TaskTree;
  lane: RoomLane;
  lit: boolean;
  hobs: HobLookup;
  moves: RoomMoves;
  slots: (lane: ActedLane) => LaneSlots;
}) {
  const hob = hobs(lane.ownerId);
  const task = laneTask(lane);
  const acted = slots({ hobId: lane.ownerId, task, tasks: lane.rows.map((row) => row.task) });
  const status = lane.rows.find((row) => row.task.id === task.id)?.status ?? "waiting";
  const tone = roomTone(status);
  const role = lane.lead
    ? messages.lead
    : lane.leads.length > 0
      ? questCopy.room.leadsParty({ names: questCopy.names(lane.leads.map((id) => hobs(id).name)) })
      : lane.rows.some((row) => row.quest !== null)
        ? questCopy.room.leads
        : null;
  const waited = lane.lead ? waitedTaskCount(tree, task) : 0;
  const asks = lane.rows.some((row) => questionForYou(tree, row.task) !== null);
  return (
    <article
      id={laneElementId(task.id)}
      aria-label={messages.lane({ name: hob.name })}
      className={cn(
        "flex min-h-0 min-w-lane-min flex-1 flex-col rounded-card border-(length:--edge) border-transparent bg-panel",
        asks && "border-lantern",
        tone === "failed" && "border-rose",
        lit && "border-focus-ring",
      )}
    >
      <div className="flex items-center gap-1 pe-2">
        <button
          type="button"
          aria-pressed={lit}
          aria-label={messages.pick({ name: hob.name })}
          onClick={() => moves.lane(lit ? undefined : task.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-t-card border-0 bg-transparent px-3 py-2.5 text-start text-text-strong hover:bg-hover"
        >
          <HobTile hob={hob} tile="lg" state={MOOD[status] ?? "idle"} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-heading font-(--heading-weight)">
              {hob.name}
              {role !== null && <span className="ms-1.5 font-sans text-meta font-normal text-label">{role}</span>}
              {waited > 0 && (
                <span className="ms-1.5 font-sans text-meta font-normal text-lantern">
                  {messages.waitingOnTasks({ count: waited })}
                </span>
              )}
            </span>
            <span className="truncate text-detail text-text-secondary">{taskTitle(task)}</span>
          </span>
          <StatusTag status={tone}>{roomStatusLabel(status)}</StatusTag>
        </button>
        {acted.actions}
      </div>
      {acted.tries}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-1 pb-3">
        {lane.rows.map((row) => (
          <LaneTask
            key={row.task.id}
            tree={tree}
            row={row}
            tried={acted.tried(row.task)}
            titled={lane.rows.length > 1}
            hobs={hobs}
            onOpen={(taskId) => moves.lane(taskId)}
            onWorkbench={(taskId) => moves.show(taskId, "summary")}
          />
        ))}
        {acted.cards}
      </div>
    </article>
  );
}
