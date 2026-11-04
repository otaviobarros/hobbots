import type { TaskTree } from "@hobbots/domain";
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
import { type ReactNode, type RefObject, useState } from "react";
import { progressStrip, topCancel } from "../quest/control-room.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { messages as questCopy } from "../quest/messages.ts";
import { TopControls } from "../quest/room-controls.tsx";
import { StatusStrip } from "../quest/status-strip.tsx";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import { taskTitle, workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { roomSearch } from "./room-search.ts";
import type { RoomWidth } from "./use-chat-fold.ts";

/**
 * The room's header (ADR 027): Close room, the Quest's title under who leads it, its progress strip
 * and count, the lineup of the party's sprites, each jumping to its lane, and a ⋯ menu with Pin
 * quest and Cancel quest…. The question a cancel asks opens under it.
 */
export function RoomHeader({
  tree,
  lineup,
  hobs,
  pins,
  width,
  headingRef,
  onClose,
}: {
  tree: TaskTree;
  /** The party's sprites, each going to its lane. */
  lineup: ReactNode;
  hobs: HobLookup;
  pins: Pins;
  width: RoomWidth;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const lead = hobs(card.leadId);
  const { segments, needs } = progressStrip(tree);
  const { done, total } = card.progress;
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
        <span className="ms-auto shrink-0">{lineup}</span>
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
