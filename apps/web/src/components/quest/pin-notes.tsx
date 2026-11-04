import type { ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { messages } from "./messages.ts";
import { type Pins, useFollowedTrees } from "./use-work.ts";

const copy = messages.room;

/**
 * Under the chat header, a line for each pinned Quest the chat cannot show: one the hub no longer
 * has, with Unpin, and one it could not read right now, with Try again.
 */
export function PinNotes({ threadId, pins }: { threadId: ThreadId; pins: Pins }) {
  const { missing, failed } = useFollowedTrees(threadId, pins.pinned);
  if (missing.length + failed.length === 0) return null;
  return (
    <div className="flex flex-col border-b-2 border-line">
      {missing.map((id) => (
        <PinNote key={id} text={copy.missing} action={copy.unpin} onAction={() => pins.toggle(id)} />
      ))}
      {failed.map(({ taskId, retry }) => (
        <PinNote key={taskId} text={copy.unreadable} action={copy.tryAgain} onAction={retry} />
      ))}
    </div>
  );
}

function PinNote({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <p className="m-0 flex items-center gap-2 px-4 py-2 text-detail text-label">
      <span className="flex-1">{text}</span>
      <Button variant="chip" size="xs" onClick={onAction}>
        {action}
      </Button>
    </p>
  );
}
