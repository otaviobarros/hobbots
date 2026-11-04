import type { AgentId, Task, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef } from "react";
import { threadTasksQuery } from "../../api/tasks.ts";
import { useLaneSlots } from "../lane-actions/lane-slots.tsx";
import { LaneLineup } from "../lanes/lane-lineup.tsx";
import { QuestLanes } from "../lanes/quest-lanes.tsx";
import { useLaneJump } from "../lanes/use-lane-jump.ts";
import { pickedTries, useLaneRoom } from "../lanes/use-lane-room.ts";
import { HubWait } from "../loading/hub-wait.tsx";
import { roomRows } from "../quest/control-room.ts";
import { type HobLookup, type Pins, useFollowedTrees, useHobLookup } from "../quest/use-work.ts";
import { findTask, taskTitle } from "../quest/work-model.ts";
import { LaneNotes } from "../steer-receipt/lane-notes.tsx";
import { WorkbenchDock } from "../workbench/workbench-dock.tsx";
import { TaskCards } from "./lane-task.tsx";
import { messages } from "./messages.ts";
import { RoomHeader } from "./room-header.tsx";
import { litTask } from "./room-model.ts";
import { type RoomMoves, type RoomView, useRoomMoves } from "./room-search.ts";
import type { RoomWidth } from "./use-chat-fold.ts";

/**
 * The Quest room beside the chat (ADR 027): a header with Close room, the Quest's title, its
 * progress and its party, a lane per hob, and the Workbench docked under them. Every Task opens one:
 * a Task alone has one lane. Opening it moves focus to its title, and Close room puts focus back in
 * the chat, so the keyboard never lands on the page.
 */
export function QuestRoom({
  hobId,
  threadId,
  view,
  pins,
  width,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  view: RoomView;
  pins: Pins;
  width: RoomWidth;
}) {
  const followed = useFollowedTrees(threadId, pins.pinned);
  const read = useQuery(threadTasksQuery(threadId));
  const found = findTask([...followed.thread, ...followed.elsewhere], view.taskId);
  const hobs = useHobLookup();
  const opened = found?.tree.tasks[0]?.id;
  const moves = useRoomMoves(hobId, threadId, opened);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (opened !== undefined && heading.current !== null) focusElement(heading.current);
  }, [opened]);
  const close = () => {
    moves.close();
    // The chat's composer takes focus back, where you would type next.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-composer] textarea")?.focus());
  };
  if (found === null) {
    return (
      <section aria-label={messages.room} className="flex min-w-0 flex-1 flex-col gap-3 bg-ground px-6 py-4">
        <span>
          <Button variant="ghost" size="sm" onClick={close}>
            ✕ {messages.close}
          </Button>
        </span>
        {read.isPending ? (
          <HubWait pending onRetry={() => void read.refetch()} />
        ) : read.isError ? (
          <p role="alert" className="m-0 flex items-center gap-2 text-detail text-rose">
            {messages.readFailed}
            <Button variant="ghost" size="xs" onClick={() => void read.refetch()}>
              {messages.tryAgain}
            </Button>
          </p>
        ) : (
          <p className="m-0 text-detail text-label">{messages.notFound}</p>
        )}
      </section>
    );
  }
  return (
    <OpenRoom
      tree={found.tree}
      named={found.task}
      view={view}
      hobs={hobs}
      pins={pins}
      width={width}
      moves={moves}
      headingRef={heading}
      onClose={close}
    />
  );
}

/**
 * The room on its Quest: the header with the party's lineup, a lane per hob and the Workbench docked
 * under them. A lit lane is the hob's: picking a lane lights the Task its header names, and the
 * Workbench shows that Task's work.
 */
function OpenRoom({
  tree,
  named,
  view,
  hobs,
  pins,
  width,
  moves,
  headingRef,
  onClose,
}: {
  tree: TaskTree;
  /** The Task the address opened the room on. */
  named: Task;
  view: RoomView;
  hobs: HobLookup;
  pins: Pins;
  width: RoomWidth;
  moves: RoomMoves;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  const top = tree.tasks[0] ?? named;
  const lit = litTask(tree, named, view.lane);
  const { room, reads } = useLaneRoom(tree, pickedTries(tree, view.attemptId));
  const picked = tree.tasks.find((each) => each.id === lit)?.ownerId ?? null;
  const pick = (hobId: AgentId | null) =>
    moves.lane(hobId === null ? undefined : room.order.find((lane) => lane.hobId === hobId)?.task.id);
  const lanes = useLaneJump(pick);
  const actOn = useLaneSlots({ hobs, pins, view, moves });
  const rows = roomRows(tree);
  return (
    <section
      aria-label={messages.label({ title: taskTitle(top) })}
      className="flex min-w-0 flex-1 animate-hb-in flex-col overflow-hidden bg-ground"
    >
      <RoomHeader
        tree={tree}
        lineup={<LaneLineup lanes={room.order} hobs={hobs} picked={picked} onJump={lanes.jump} />}
        hobs={hobs}
        pins={pins}
        width={width}
        headingRef={headingRef}
        onClose={onClose}
      />
      <QuestLanes
        room={room}
        hobs={hobs}
        picked={picked}
        onPick={pick}
        flashing={lanes.flashing}
        onFlashed={lanes.flashed}
        reads={reads}
        slots={(lane) => {
          // A failed step waits on you in its owner's lane too, so acting covers the hob's steps.
          const owned = rows.filter((row) => row.task.ownerId === lane.hobId).map((row) => row.task);
          const acted = actOn(tree, { hobId: lane.hobId, task: lane.task, tasks: owned });
          return {
            actions: acted.actions,
            tries: acted.tries,
            cards: (
              <>
                <TaskCards
                  tree={tree}
                  lane={lane}
                  tried={acted.tried}
                  hobs={hobs}
                  onOpen={(taskId) => moves.lane(taskId)}
                  onWorkbench={(taskId) => moves.show(taskId, "summary")}
                />
                <LaneNotes tree={tree} ownerId={lane.hobId} hobs={hobs} />
                {acted.cards}
              </>
            ),
          };
        }}
      />
      <WorkbenchDock tree={tree} taskId={lit ?? top.id} view={view} hobs={hobs} moves={moves} />
    </section>
  );
}
