import type { Message } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { formatTime } from "../../lib/time.ts";
import { messages } from "./messages.ts";

/**
 * A note to self in the transcript (ADR 037): on your side, in a dashed box, under "Note to self ·
 * only you". No hob reads it.
 */
export function NoteRow({
  message,
  id,
  focused,
  actions,
}: {
  message: Message;
  /** The row's element id, for scrolling to it. */
  id: string;
  focused: boolean;
  actions?: ReactNode;
}) {
  return (
    <div
      id={id}
      data-note=""
      className={cn(
        "flex max-w-bubble-max animate-hb-in flex-col items-end gap-1 self-end",
        focused && "outline-2 outline-offset-4 outline-lantern",
      )}
    >
      <span className="flex items-center gap-1 text-meta text-label">
        {actions}
        {messages.meta({ time: formatTime(message.createdAt) })}
      </span>
      <div className="rounded-card rounded-ee-tag border-(length:--edge) border-dashed border-line-2 px-4 py-2.5 leading-[1.45] whitespace-pre-wrap text-text">
        {message.content}
      </div>
    </div>
  );
}
