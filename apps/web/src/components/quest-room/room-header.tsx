import type { TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useParams } from "@tanstack/react-router";
import { type RefObject, useState } from "react";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { progressStrip, topCancel } from "../quest/control-room.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { messages as questCopy } from "../quest/messages.ts";
import { TopControls } from "../quest/room-controls.tsx";
import { StatusStrip } from "../quest/status-strip.tsx";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import { taskTitle, workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { laneOf, laneTask, type RoomLane } from "./room-model.ts";
import { roomSearch } from "./room-search.ts";
import type { RoomWidth } from "./use-chat-fold.ts";

/** Scrolls a hob's lane into view, as the lineup jumps to it. */
const showLane = (taskId: TaskId) =>
  document.getElementById(laneElementId(taskId))?.scrollIntoView({ block: "nearest", inline: "nearest" });

/** The element id of the lane that holds a Task, for the lineup to jump to. */
export const laneElementId = (taskId: TaskId) => `lane-${taskId}`;

/**
 * The room's header (ADR 027): Close room, the Quest's title under who leads it, its progress strip
 * and count, the lineup of the party's sprites, each jumping to its lane, and a ⋯ menu with Pin
 * quest and Cancel quest…. The question a cancel asks opens under it.
 */
export function RoomHeader({
  tree,
  lanes,
  lit,
  hobs,
  pins,
  width,
  headingRef,
  onClose,
  onLane,
}: {
  tree: TaskTree;
  lanes: ReadonlyArray<RoomLane>;
  lit: TaskId | undefined;
  hobs: HobLookup;
  pins: Pins;
  width: RoomWidth;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onLane: (taskId: TaskId | undefined) => void;
}) {
  const [asking, setAsking] = useState(false);
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const lead = hobs(card.leadId);
  const { segments, needs } = progressStrip(tree);
  const { done, total } = card.progress;
  const litLane = laneOf(lanes, lit);
  const cancel = topCancel(tree);
  return (
    <>
      <header className="flex items-center gap-4 border-b border-line py-2.5 ps-3 pe-5">
        <Button variant="ghost" size="sm" title={messages.closeHint} onClick={onClose}>
          <span aria-hidden>✕</span>
          {messages.close}
        </Button>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-meta font-bold text-star">
            <FlagIcon size={12} />
            {card.quest === null
              ? messages.taskEyebrow({ name: lead.name })
              : messages.questEyebrow({ name: lead.name })}
          </span>
          <Elsewhere top={top} />
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="m-0 truncate font-heading text-title font-(--heading-weight) text-text-strong outline-none"
          >
            {taskTitle(top)}
          </h2>
        </span>
        {width === "wide" && segments.length > 0 && <StatusStrip statuses={segments} className="w-30 shrink-0" />}
        <span
          className={cn("shrink-0 text-detail whitespace-nowrap text-text-secondary", width === "narrow" && "sr-only")}
        >
          {total > 0 && messages.done({ done, total })}
          {needs > 0 && <span className="font-bold text-lantern"> · {messages.needYou({ count: needs })}</span>}
        </span>
        <fieldset aria-label={messages.party} className="m-0 ms-auto flex shrink-0 items-center gap-1 border-0 p-0">
          {lanes.map((lane) => {
            const hob = hobs(lane.ownerId);
            const picked = litLane?.ownerId === lane.ownerId;
            const task = laneTask(lane);
            return (
              <button
                key={lane.ownerId}
                type="button"
                aria-pressed={picked}
                aria-label={messages.goToLane({ name: hob.name })}
                title={hob.name}
                onClick={() => {
                  onLane(picked ? undefined : task.id);
                  showLane(task.id);
                }}
                className="cursor-pointer rounded-control border-0 bg-transparent p-0.5 aria-pressed:shadow-[inset_0_0_0_2px_var(--color-focus-ring)]"
              >
                <HobTile hob={hob} tile="sm" />
              </button>
            );
          })}
        </fieldset>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="icon" size="icon" aria-label={messages.menu({ title: taskTitle(top) })}>
              ⋯
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => pins.toggle(top.id)}>
              {pins.pinned.includes(top.id) ? messages.unpin : messages.pin}
            </DropdownMenuItem>
            {cancel === "open" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="deny" onSelect={() => setAsking(true)}>
                  {card.quest === null ? messages.cancelTask : messages.cancelQuest}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="px-5 pt-2 empty:hidden">
        {(asking || cancel !== "open") && (
          <TopControls
            tree={tree}
            top={top}
            hobs={hobs}
            cancel={cancel}
            quest={card.quest}
            asked={{ open: asking, set: setAsking }}
          />
        )}
      </div>
    </>
  );
}

/** A Quest pinned from another thread says so, with a link to its own thread. */
function Elsewhere({ top }: { top: TaskTree["tasks"][number] }) {
  const route = useParams({ strict: false });
  if (top.threadId === null || top.threadId === route.threadId) return null;
  return (
    <span className="flex items-center gap-2 text-meta text-label">
      {questCopy.room.elsewhere}
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: top.ownerId, threadId: top.threadId }}
        search={roomSearch(top.id)}
        className="text-link"
      >
        {questCopy.room.openThread}
      </Link>
    </span>
  );
}
