import type { AgentId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { threadTasksQuery } from "../../api/tasks.ts";
import { useLaneSlots } from "../lane-actions/lane-slots.tsx";
import { HubWait } from "../loading/hub-wait.tsx";
import { type Pins, useFollowedTrees, useHobLookup } from "../quest/use-work.ts";
import { findTask, taskTitle } from "../quest/work-model.ts";
import { WorkbenchDock } from "../workbench/workbench-dock.tsx";
import { messages } from "./messages.ts";
import { RoomHeader } from "./room-header.tsx";
import { RoomLanes } from "./room-lanes.tsx";
import { litTask, roomLanes } from "./room-model.ts";
import { type RoomView, useRoomMoves } from "./room-search.ts";
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
  const slots = useLaneSlots({ hobs, pins, view, moves });
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
  const { tree } = found;
  const top = tree.tasks[0] ?? found.task;
  const lit = litTask(tree, found.task, view.lane);
  const lanes = roomLanes(tree);
  return (
    <section
      aria-label={messages.label({ title: taskTitle(top) })}
      className="flex min-w-0 flex-1 animate-hb-in flex-col overflow-hidden bg-ground"
    >
      <RoomHeader
        tree={tree}
        lanes={lanes}
        lit={lit}
        hobs={hobs}
        pins={pins}
        width={width}
        headingRef={heading}
        onClose={close}
        onLane={moves.lane}
      />
      <RoomLanes tree={tree} lanes={lanes} lit={lit} hobs={hobs} moves={moves} slots={(lane) => slots(tree, lane)} />
      <WorkbenchDock tree={tree} taskId={lit ?? top.id} view={view} hobs={hobs} moves={moves} />
    </section>
  );
}
