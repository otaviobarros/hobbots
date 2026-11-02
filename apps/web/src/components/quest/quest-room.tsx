import type { Task, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatWhen } from "../../lib/time.ts";
import { RoomBackpack } from "../backpack/quest-backpack.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { useNow } from "../inbox/use-now.ts";
import { type RoomRow, type RoomStatus, roomRows, topCancel } from "./control-room.ts";
import { messages } from "./messages.ts";
import { RoomControls } from "./room-controls.tsx";
import { StatusDot, StatusTag } from "./status-dot.tsx";
import type { HobLookup } from "./use-work.ts";
import { type RowStatus, taskTitle, workCard } from "./work-model.ts";

const copy = messages.room;

/** A cancel shows in the waiting tone: nothing runs, and nothing is done either. */
const toneOf = (status: RoomStatus): RowStatus =>
  status === "cancelling" || status === "cancelled" ? "waiting" : status;

const statusLabel = (status: RoomStatus): string =>
  status === "cancelling" || status === "cancelled" ? copy.status[status] : messages.status[status];

/** Indents a row by its depth in the tree; deeper Tasks keep the last indent. */
const INDENT = ["ps-2", "ps-6", "ps-10", "ps-14", "ps-18"] as const;

/**
 * One request's Task tree in the Quest tab: who owns each Task, where it stands, how old it is and
 * who it waits on, nested Quests indented under their member, with Pin and the controls.
 */
export function QuestRoom({
  tree,
  own,
  hobs,
  selected,
  pinned,
  onPin,
  onOpen,
}: {
  tree: TaskTree;
  /** Whether the tree started in this thread; a pinned one from elsewhere links to its own. */
  own: boolean;
  hobs: HobLookup;
  selected: TaskId | undefined;
  pinned: boolean;
  onPin: (taskId: TaskId) => void;
  /** Opens a Task in the drawer beside this chat; without one, a Task opens in its own thread. */
  onOpen: ((taskId: TaskId) => void) | undefined;
}) {
  const navigate = useNavigate();
  const now = useNow();
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const title = taskTitle(top);
  const lead = hobs(card.leadId).name;
  const rows = roomRows(tree);
  const chosen = rows.find((row) => row.task.id === selected) ?? null;
  const { done, total } = card.progress;
  const whose = card.quest === null ? messages.strip.task({ name: lead }) : messages.strip.quest({ name: lead });
  const ownThread = top.threadId === null ? null : { hobId: top.ownerId, threadId: top.threadId };
  const open =
    onOpen ??
    ((taskId: TaskId) =>
      ownThread !== null &&
      void navigate({ to: "/hobs/$hobId/threads/$threadId", params: ownThread, search: { task: taskId } }));

  return (
    <section aria-label={copy.label({ title })} className="flex flex-col border-b-4 border-line">
      <div className="flex flex-col gap-2 px-3.5 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 min-w-0 flex-1 truncate font-pixel text-lg font-bold text-moonlight">{title}</h2>
          <Button
            variant="chip"
            size="xs"
            aria-pressed={pinned}
            aria-label={copy.pin}
            title={pinned ? copy.unpinHint : copy.pinHint}
            onClick={() => onPin(top.id)}
            className={cn("text-xs", pinned && "border-moonlight text-moonlight")}
          >
            {pinned ? copy.pinned : copy.pin}
          </Button>
        </div>
        <span className="text-detail text-secondary-text">
          {total > 0 ? copy.summary({ whose, done, total }) : whose}
        </span>
        {!own && (
          <span className="flex items-center gap-2 text-detail text-label">
            {copy.elsewhere}
            {ownThread !== null && (
              <Link to="/hobs/$hobId/threads/$threadId" params={ownThread} className="text-lantern">
                {copy.openThread}
              </Link>
            )}
          </span>
        )}
        {total > 0 && <Segments rows={rows} />}
      </div>
      <ul aria-label={copy.tree({ title })} className="m-0 flex list-none flex-col gap-0.5 px-1.5 pb-2">
        {rows.map((row) => (
          <li key={row.task.id}>
            <Row row={row} hobs={hobs} now={now} selected={row.task.id === selected} onOpen={open} />
          </li>
        ))}
      </ul>
      <RoomBackpack tree={tree} hobs={hobs} onOpen={open} />
      <RoomControls
        tree={tree}
        task={chosen?.task ?? null}
        hobs={hobs}
        cancel={topCancel(tree)}
        hasQuest={card.quest !== null}
      />
    </section>
  );
}

/** One block per Task under the top one, filled as each is done. */
function Segments({ rows }: { rows: ReadonlyArray<RoomRow> }) {
  return (
    <div aria-hidden className="flex gap-0.5">
      {rows.slice(1).map((row) => (
        <span
          key={row.task.id}
          className={cn("h-2 flex-1", row.task.state === "completed" ? "bg-mint" : "bg-line-2")}
        />
      ))}
    </div>
  );
}

function Row({
  row,
  hobs,
  now,
  selected,
  onOpen,
}: {
  row: RoomRow;
  hobs: HobLookup;
  now: Date;
  selected: boolean;
  onOpen: (taskId: TaskId) => void;
}) {
  const owner = hobs(row.task.ownerId);
  const title = taskTitle(row.task);
  const waits = row.waitingOn.map((each) => (each.kind === "you" ? copy.you : hobs(each.id).name));
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={() => onOpen(row.task.id)}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 border-0 py-1.5 pe-2 text-start text-text hover:bg-hover",
        INDENT[Math.min(row.depth, INDENT.length - 1)],
        selected ? "bg-line" : "bg-transparent",
      )}
    >
      {row.depth > 0 && <span aria-hidden className="h-0.5 w-2.5 shrink-0 bg-line-2" />}
      <StatusDot status={toneOf(row.status)} />
      <HobSprite hob={owner} size={20} state={row.status === "running" ? "working" : "idle"} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{copy.row({ name: owner.name, title })}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-label">
          {row.quest !== null && <span className="shrink-0 bg-line px-1.5 font-bold text-moonlight">{copy.leads}</span>}
          {waits.length > 0 && (
            <span className="truncate text-lantern">{messages.card.waitingOn({ names: messages.names(waits) })}</span>
          )}
          <Age task={row.task} now={now} />
        </span>
      </span>
      <StatusTag status={toneOf(row.status)}>{statusLabel(row.status)}</StatusTag>
    </button>
  );
}

/** How long ago the Task was created. */
function Age({ task, now }: { task: Task; now: Date }) {
  return (
    <time dateTime={task.createdAt} className="shrink-0">
      {formatWhen(task.createdAt, now)}
    </time>
  );
}
