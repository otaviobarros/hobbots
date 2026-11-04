import type { Thread } from "@hobbots/domain";
import { messages as copy } from "../archive/messages.ts";
import { PinIcon, RenameField } from "../hob-page/chat-row.tsx";

/**
 * The open thread's title, which leads the chat header, with the lantern pin when it is pinned to the top. Rename
 * in the ⋯ menu turns it into a field: Enter saves, Escape keeps the old title.
 */
export function ChatTitle({
  thread,
  title,
  renaming,
  onDone,
}: {
  thread: Thread | undefined;
  title: string;
  renaming: boolean;
  onDone: () => void;
}) {
  if (thread !== undefined && renaming) return <RenameField thread={thread} onDone={onDone} className="flex-1" />;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {thread?.pinnedAt != null && <PinIcon label={copy.pinned} />}
      <span className="truncate font-heading text-title font-(--heading-weight) text-text-strong">{title}</span>
    </span>
  );
}
