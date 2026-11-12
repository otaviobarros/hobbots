import { isNote, type Message, type MessageId, type Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { pinsQuery, useSetPinned } from "../../api/notes.ts";
import { messagesQuery } from "../../api/queries.ts";
import { firstLine, formatAgo } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import { ReadState, SheetSection } from "./sheet-parts.tsx";

const copy = messages.mine;

/** What is yours in the camp (ADR 037, Mine): the messages you pinned, then your notes to self. */
export function MineTab({ thread, onJump }: { thread: Thread; onJump: (messageId: MessageId) => void }) {
  const pins = useQuery(pinsQuery(thread.id));
  const transcript = useQuery(messagesQuery(thread.id));
  const unpin = useSetPinned(thread.id);
  const byId = new Map((transcript.data ?? []).map((message) => [message.id, message]));
  // A pin whose message the transcript does not hold yet waits for it.
  const pinned = (pins.data ?? []).flatMap((pin) => {
    const message = byId.get(pin.messageId);
    return message === undefined ? [] : [message];
  });
  const notes = (transcript.data ?? []).filter(isNote).reverse();
  return (
    <div className="flex flex-col gap-4">
      <SheetSection title={copy.pinned}>
        <ReadState read={pins} empty={pinned.length === 0 ? copy.noPins : undefined} />
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {pinned.map((message) => (
            <MineRow key={message.id} message={message} onJump={onJump}>
              <Button
                variant="text"
                size="xs"
                disabled={unpin.isPending}
                onClick={() => unpin.mutate({ messageId: message.id, pinned: false })}
              >
                {copy.unpin}
              </Button>
            </MineRow>
          ))}
        </ul>
      </SheetSection>
      <SheetSection title={copy.notes}>
        <ReadState read={transcript} empty={notes.length === 0 ? copy.noNotes : undefined} />
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {notes.map((note) => (
            <MineRow key={note.id} message={note} onJump={onJump} />
          ))}
        </ul>
      </SheetSection>
      <p className="m-0 text-meta text-label">{copy.note}</p>
    </div>
  );
}

function MineRow({
  message,
  onJump,
  children,
}: {
  message: Message;
  onJump: (messageId: MessageId) => void;
  children?: ReactNode;
}) {
  const line = firstLine(message.content);
  return (
    <li className="flex items-center gap-2.5 rounded-control px-2 py-2 hover:bg-hover">
      <span aria-hidden className="text-meta text-lantern">
        {messages.mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-text-strong">{line}</span>
        <span className="text-meta text-label">{formatAgo(message.createdAt)}</span>
      </span>
      <Button variant="text" size="xs" aria-label={copy.jumpTo({ text: line })} onClick={() => onJump(message.id)}>
        {copy.jump}
      </Button>
      {children}
    </li>
  );
}
