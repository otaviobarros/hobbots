import type { AgentId, Task, TaskTree } from "@hobbots/domain";
import type { ReactNode } from "react";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import type { RoomMoves, RoomView } from "../quest-room/room-search.ts";
import { type PickedTry, pickedTry } from "./lane-actions-model.ts";
import { LaneCards } from "./lane-cards.tsx";
import { LaneMenu } from "./lane-menu.tsx";
import { LaneTries } from "./lane-tries.tsx";
import { useLaneActions } from "./use-lane-actions.ts";

/** What a lane needs to be acted on: its hob, the Task its header names and all of the hob's Tasks. */
export interface ActedLane {
  readonly hobId: AgentId;
  readonly task: Task;
  readonly tasks: ReadonlyArray<Task>;
}

/** The parts acting adds to a lane: the ⋯ menu beside its header, the attempt picker under it, the cards in its body and the try it shows. */
export interface LaneSlots {
  readonly actions: ReactNode;
  readonly tries: ReactNode;
  readonly cards: ReactNode;
  /** The earlier try of one of the lane's Tasks that is picked, which the lane shows in its place. */
  readonly tried: (task: Task) => PickedTry | null;
}

/**
 * Acting in the Quest room's lanes (ADR 027): one set of shared state for the room, and for each
 * lane its ⋯ menu, attempt picker and cards. The room calls the hook once, and each lane asks for
 * its slots with the room's Task tree.
 */
export const useLaneSlots = ({
  hobs,
  pins,
  view,
  moves,
}: {
  hobs: HobLookup;
  pins: Pins;
  view: RoomView;
  moves: RoomMoves;
}) => {
  const actions = useLaneActions();
  return (tree: TaskTree, lane: ActedLane): LaneSlots => ({
    actions: (
      <LaneMenu
        tree={tree}
        task={lane.task}
        hobs={hobs}
        pins={pins}
        actions={actions}
        onWorkbench={() => moves.show(lane.task.id, view.tab ?? "changes")}
      />
    ),
    tries: (
      <LaneTries
        tree={tree}
        task={lane.task}
        name={hobs(lane.hobId).name}
        picked={view.attemptId}
        onPick={(attemptId) => moves.pick(lane.task.id, attemptId)}
      />
    ),
    cards: (
      <LaneCards tree={tree} lane={lane.task.id} hobId={lane.hobId} tasks={lane.tasks} hobs={hobs} actions={actions} />
    ),
    tried: (task) => pickedTry(tree, task, view.attemptId),
  });
};
