import { isTerminalTask, type Task, type TaskId, type TaskTree } from "@hobbots/domain";
import type { HobState } from "../../lib/hob-state.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { LaneCards } from "../lane-actions/lane-cards.tsx";
import { LaneMenu } from "../lane-actions/lane-menu.tsx";
import { useLaneActions } from "../lane-actions/use-lane-actions.ts";
import { LANE, LANE_HEAD } from "../lanes/lane-focus.ts";
import type { Lane, LaneRole } from "../lanes/lane-model.ts";
import { messages as laneCopy } from "../lanes/messages.ts";
import { type LaneReads, pickedTries, useLaneRoom } from "../lanes/use-lane-room.ts";
import { type RoomStatus, roomRows, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import { Said } from "../said/said.tsx";
import { LaneNotes } from "../steer-receipt/lane-notes.tsx";
import { HobSteps } from "./hob-steps.tsx";
import { messages } from "./messages.ts";
import type { QuestMoves } from "./quest-search.ts";
import { TaskCards } from "./task-cards.tsx";

const copy = messages.sheet;

/** How the hob's sprite moves for where its Task stands: working hops, waiting dozes. */
const MOOD: Readonly<Record<RoomStatus, HobState>> = {
  running: "working",
  waiting: "asleep",
  blocked: "waiting",
  "needs-you": "needs-you",
  failed: "failed",
  done: "idle",
  cancelling: "waiting",
  cancelled: "idle",
  unresolved: "waiting",
  stuck: "needs-you",
};

const roleText = (role: LaneRole, hobs: HobLookup): string | null =>
  role.kind === "lead"
    ? laneCopy.role.lead
    : role.kind === "leads"
      ? role.members.length === 0
        ? laneCopy.role.leadsQuest
        : laneCopy.role.leads({ names: laneCopy.names(role.members.map((id) => hobs(id).name)) })
      : null;

/**
 * Who is on the quest, a hob at a time in the order the hub brought them in: each hob's Tasks, your
 * notes that reached it, and what waits on you there, such as a question or a failed Task, with the
 * hob's ⋯ menu to retry, reassign or cancel.
 */
export function Team({ tree, hobs, pins, moves }: { tree: TaskTree; hobs: HobLookup; pins: Pins; moves: QuestMoves }) {
  const { room, reads } = useLaneRoom(tree, pickedTries(tree, undefined));
  const top = tree.tasks[0];
  const finished = top !== undefined && isTerminalTask(top.state);
  const actions = useLaneActions();
  const rows = roomRows(tree);
  return (
    <section aria-label={copy.team} className="flex flex-col gap-2">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.team}</h3>
      {room.order.map((lane) => (
        <HobWork
          key={lane.hobId}
          tree={tree}
          lane={lane}
          // A failed step waits on you under its owner too, so acting covers the hob's steps.
          owned={rows.filter((row) => row.task.ownerId === lane.hobId).map((row) => row.task)}
          hobs={hobs}
          pins={pins}
          moves={moves}
          actions={actions}
          finished={finished}
          reads={reads(lane.hobId)}
        />
      ))}
    </section>
  );
}

function HobWork({
  tree,
  lane,
  owned,
  hobs,
  pins,
  moves,
  actions,
  finished,
  reads,
}: {
  tree: TaskTree;
  lane: Lane;
  owned: ReadonlyArray<Task>;
  hobs: HobLookup;
  pins: Pins;
  moves: QuestMoves;
  actions: ReturnType<typeof useLaneActions>;
  /** The quest has ended: each hob's steps fold to its results until opened. */
  finished: boolean;
  reads: LaneReads;
}) {
  const hob = hobs(lane.hobId);
  const role = roleText(lane.role, hobs);
  const open = (taskId: TaskId) => moves.lane(taskId);
  return (
    <section
      aria-label={copy.hobWork({ name: hob.name })}
      {...LANE}
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-line bg-card p-3"
    >
      <span className="flex items-center gap-1">
        <button
          type="button"
          {...LANE_HEAD}
          title={copy.showHob({ name: hob.name })}
          onClick={() => moves.lane(lane.task.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent p-0 text-start text-ui text-text-strong"
        >
          <HobSprite hob={hob} size={24} state={MOOD[lane.status]} />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold">{hob.name}</span>
            {role !== null && (
              <span className="ms-1.5 text-meta text-label">
                <Said>{laneCopy.said.role}</Said>
                {role}
              </span>
            )}
            <Said>{laneCopy.said.state}</Said>
          </span>
          {/* Named by what it shows, then what it does, so speech input can say what it sees (WCAG 2.5.3). */}
          <StatusTag status={roomTone(lane.status)} said={laneCopy.said.show({ name: hob.name })}>
            {roomStatusLabel(lane.status)}
          </StatusTag>
        </button>
        <LaneMenu
          tree={tree}
          task={lane.task}
          hobs={hobs}
          pins={pins}
          actions={actions}
          onWorkbench={() => moves.show(lane.task.id, "changes")}
        />
      </span>
      <TaskCards
        tree={tree}
        lane={lane}
        tried={() => null}
        hobs={hobs}
        onOpen={open}
        onWorkbench={(taskId) => moves.show(taskId, "changes")}
      />
      <HobSteps lane={lane} hobs={hobs} finished={finished} reads={reads} />
      <LaneNotes tree={tree} ownerId={lane.hobId} hobs={hobs} />
      <LaneCards tree={tree} lane={lane.task.id} hobId={lane.hobId} tasks={owned} hobs={hobs} actions={actions} />
    </section>
  );
}
