import type { AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { WorkspaceBackpack } from "../backpack/quest-backpack.tsx";
import { messages } from "./messages.ts";
import { QuestRoom } from "./quest-room.tsx";
import { type Pins, useFollowedTrees, useHobLookup, useOpenTask } from "./use-work.ts";

const copy = messages.room;

/**
 * The right panel's Quest tab: the control room for the work this thread follows (ADR 018,
 * CH-005). Each pinned Quest from another thread comes first, then this thread's own, newest first.
 * A Task opens in the drawer beside the chat, wherever it started.
 */
export function QuestTab({
  hobId,
  threadId,
  taskId,
  pins,
}: {
  hobId: AgentId;
  threadId: ThreadId | undefined;
  taskId: TaskId | undefined;
  pins: Pins;
}) {
  const { thread, elsewhere, missing, failed } = useFollowedTrees(threadId, pins.pinned);
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId ?? ("" as ThreadId));
  const trees = [
    ...elsewhere.map((tree) => ({ tree, own: false })),
    ...thread.map((tree) => ({ tree, own: true })).reverse(),
  ];

  const gone = [
    ...missing.map((id) => (
      <PinNote key={id} text={copy.missing} action={copy.unpin} onAction={() => pins.toggle(id)} />
    )),
    ...failed.map(({ taskId: id, retry }) => (
      <PinNote key={id} text={copy.unreadable} action={copy.tryAgain} onAction={retry} />
    )),
  ];

  if (trees.length === 0) {
    return (
      <>
        {gone}
        <div className="flex animate-hb-in flex-col gap-2 px-[18px] py-[22px] leading-normal text-secondary-text">
          <span className="font-pixel text-lg text-moonlight">{copy.emptyTitle}</span>
          <span>{copy.empty}</span>
        </div>
        <WorkspaceBackpack hobs={hobs} />
      </>
    );
  }
  return (
    <div className="flex flex-col">
      {gone}
      {trees.map(({ tree, own }) => (
        <QuestRoom
          key={tree.tasks[0]?.id}
          tree={tree}
          own={own}
          hobs={hobs}
          selected={taskId}
          pinned={tree.tasks[0] !== undefined && pins.pinned.includes(tree.tasks[0].id)}
          onPin={pins.toggle}
          onOpen={threadId === undefined ? undefined : open}
        />
      ))}
      <WorkspaceBackpack hobs={hobs} />
    </div>
  );
}

/** A line about a pinned Quest the tab cannot show, with what you can do about it. */
function PinNote({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <p className="m-0 flex items-center gap-2 border-b-2 border-line px-3.5 py-2.5 text-detail text-label">
      <span className="flex-1">{text}</span>
      <Button variant="chip" size="xs" onClick={onAction}>
        {action}
      </Button>
    </p>
  );
}
