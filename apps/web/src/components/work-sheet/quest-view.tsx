import type { TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SheetCloseButton, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { type RoomRow, roomRows, roomStatusLabel, roomTone, topCancel, waitingNames } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { TopControls } from "../quest/room-controls.tsx";
import { StatusTag } from "../quest/status-dot.tsx";
import { StatusStrip } from "../quest/status-strip.tsx";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import { latestOf, taskTitle, workCard, workCounts } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** Done rows fold into a count once the list is longer than this. */
const SHOWN_BEFORE_FOLD = 4;

/** Indents a row by its depth under the lead's own Task; deeper Tasks keep the last indent. */
const INDENT = ["", "ps-4", "ps-8", "ps-12"] as const;

/**
 * The quest sheet: the request's title with Pin, when it started and how far it got, one strip
 * segment per task, the lead's own task, then each task under it with its owner, a one-line note and
 * its state tag. Done rows fold into a count past four. Cancel quest sits at the bottom.
 */
export function QuestView({
  tree,
  hobs,
  pins,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  pins: Pins;
  onOpen: (taskId: TaskId) => void;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const lead = hobs(card.leadId);
  const rows = roomRows(tree);
  const tasks = rows.slice(1);
  const needs = workCounts(tree)["needs-you"];
  const pinned = pins.pinned.includes(top.id);
  const fold = !unfolded && tasks.length > SHOWN_BEFORE_FOLD;
  const shown = fold ? tasks.filter((row) => row.task.state !== "completed") : tasks;
  const folded = tasks.length - shown.length;
  const { done, total } = card.progress;
  return (
    <>
      <SheetHeader>
        <span className="flex items-center gap-1.5 text-detail font-bold text-star">
          <FlagIcon />
          {card.quest === null ? copy.taskEyebrow({ name: lead.name }) : copy.questEyebrow({ name: lead.name })}
        </span>
        <PinButton pinned={pinned} onToggle={() => pins.toggle(top.id)} />
        <SheetCloseButton label={copy.close} className="ms-0" />
      </SheetHeader>
      <div className="flex flex-col gap-1">
        <SheetTitle tabIndex={-1}>{taskTitle(top)}</SheetTitle>
        <SheetDescription>
          {copy.started({ when: formatWhen(top.createdAt) })}
          {total > 0 && ` · ${copy.done({ done, total })}`}
          {needs > 0 && <span className="font-bold text-lantern"> · {copy.needYou({ count: needs })}</span>}
        </SheetDescription>
      </div>
      {tasks.length > 0 && <StatusStrip statuses={tasks.map((row) => roomTone(row.status))} />}
      <button
        type="button"
        onClick={() => onOpen(top.id)}
        className="flex cursor-pointer items-center gap-2.5 rounded-card border-0 bg-card px-3 py-2.5 text-start text-text-strong hover:bg-hover"
      >
        <Tile>
          <HobSprite hob={lead} size={22} />
        </Tile>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-bold">{taskTitle(top)}</span>
          <span className="truncate text-detail text-text-secondary">
            {copy.leads({ name: lead.name })}
            {rows[0] !== undefined && ` · ${roomStatusLabel(rows[0].status)}`}
          </span>
        </span>
      </button>
      {tasks.length > 0 && (
        <section aria-label={copy.tasks} className="flex flex-col gap-1.5">
          <h3 className="m-0 flex items-center justify-between text-detail font-bold text-label">
            {copy.tasks}
            <span className="rounded-dot bg-line px-1.5 text-meta">{tasks.length}</span>
          </h3>
          <ul
            aria-label={questCopy.room.tree({ title: taskTitle(top) })}
            className="m-0 flex list-none flex-col overflow-hidden rounded-card bg-card p-0"
          >
            {shown.map((row) => (
              <li key={row.task.id} className="border-b border-line last:border-b-0">
                <TaskRow row={row} tree={tree} hobs={hobs} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {folded > 0 && (
            <p className="m-0 flex items-center gap-2 text-detail text-label">
              {copy.doneFolded({ count: folded })}
              <Button variant="link" size="xs" onClick={() => setUnfolded(true)}>
                {copy.showDone}
              </Button>
            </p>
          )}
        </section>
      )}
      <SheetFooter className="border-t border-line pt-3">
        <TopControls tree={tree} top={top} hobs={hobs} cancel={topCancel(tree)} quest={card.quest} />
        {topCancel(tree) === "open" && (
          <p className="m-0 text-meta text-label">
            {card.quest === null ? copy.cancelTaskNote({ name: lead.name }) : copy.cancelQuestNote({ name: lead.name })}
          </p>
        )}
      </SheetFooter>
    </>
  );
}

/** One task under the lead's: its owner, title, a one-line note and its state tag. */
function TaskRow({
  row,
  tree,
  hobs,
  onOpen,
}: {
  row: RoomRow;
  tree: TaskTree;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const title = taskTitle(row.task);
  const owner = hobs(row.task.ownerId);
  const waits = waitingNames(row, (id) => hobs(id).name);
  const note =
    waits.length > 0
      ? questCopy.card.waitingOn({ names: questCopy.names(waits) })
      : (latestOf(tree, row.task) ?? row.task.result?.summary ?? null);
  const tone = roomTone(row.status);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.task.id)}
      aria-label={questCopy.room.row({ name: owner.name, title })}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2.5 text-start text-text-strong hover:bg-hover",
        INDENT[Math.min(row.depth - 1, INDENT.length - 1)],
      )}
    >
      <Tile>
        <HobSprite hob={owner} size={22} state={row.status === "running" ? "working" : "idle"} />
      </Tile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-bold">{title}</span>
        <span
          className={cn(
            "truncate text-detail",
            waits.length > 0 || tone === "needs-you"
              ? "text-lantern"
              : tone === "failed"
                ? "text-rose"
                : "text-text-secondary",
          )}
        >
          {note === null ? owner.name : `${owner.name} · ${note}`}
        </span>
      </span>
      <StatusTag status={tone}>{roomStatusLabel(row.status)}</StatusTag>
    </button>
  );
}

function Tile({ children }: { children: React.ReactNode }) {
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-tile bg-tile">{children}</span>;
}

function FlagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Pin keeps the quest in view in every thread; pressed, it reads Pinned. */
function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pinned}
      title={pinned ? questCopy.room.unpinHint : questCopy.room.pinHint}
      onClick={onToggle}
      className={cn("ms-auto", pinned && "text-lantern")}
    >
      <PinIcon />
      {pinned ? questCopy.room.pinned : questCopy.room.pin}
    </Button>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M8 10.5V14M5 2.5h6M6 2.5v4L4 9h8l-2-2.5v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
