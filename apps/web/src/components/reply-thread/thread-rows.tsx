import { inMainLine, type Message, type MessageId } from "@hobbots/domain";
import { type ReactNode, useEffect, useRef } from "react";
import { threadLines } from "../../lib/reply-threads.ts";
import { messages as copy } from "./messages.ts";
import type { Cast } from "./thread-faces.ts";
import { ThreadLine } from "./thread-line.tsx";
import type { OpenThread } from "./use-thread.ts";

/** What the main line shows of reply threads, beside the messages it draws. */
export interface ThreadRows {
  /** Under a root: its thread in one line; nothing under a message with no replies. */
  readonly line: (message: Message) => ReactNode;
  /** Beside a reply also sent to the main line: From a thread, which opens it. */
  readonly from: (message: Message) => ReactNode;
  /** Opens the thread of a main-line message, as Reply in thread does. */
  readonly open: (messageId: MessageId) => void;
}

/**
 * Reply threads in the main line (ADR 039, Reply threads), from the channel's said messages. A search
 * result that is a reply only in a thread opens that thread, since the main line does not show it.
 */
export const useThreadRows = (
  said: ReadonlyArray<Message> | undefined,
  cast: Cast,
  thread: OpenThread,
  focusMessageId: string | undefined,
): ThreadRows => {
  const lines = threadLines(said ?? []);
  const focusRoot = said?.find((message) => message.id === focusMessageId && !inMainLine(message))?.rootMessageId;
  // Each search pick of a reply opens its thread once, so closing it leaves it closed.
  const opened = useRef<string>(undefined);
  const { show } = thread;
  useEffect(() => {
    if (focusRoot === undefined || focusRoot === null || opened.current === focusMessageId) return;
    opened.current = focusMessageId;
    show(focusRoot);
  }, [focusRoot, focusMessageId, show]);
  return {
    line: (message) => {
      const line = lines.get(message.id);
      return (
        line !== undefined && (
          <ThreadLine
            rootId={message.id}
            line={line}
            cast={cast}
            open={thread.open === message.id}
            onOpen={thread.show}
            end={message.role === "user"}
          />
        )
      );
    },
    from: (message) =>
      message.rootMessageId !== null && (
        <button
          type="button"
          className="cursor-pointer rounded-tag border-0 bg-line px-1.75 text-meta leading-[18px] font-semibold text-text-secondary hover:text-text-strong"
          onClick={() => message.rootMessageId !== null && thread.show(message.rootMessageId)}
        >
          {copy.fromThread}
        </button>
      ),
    open: thread.show,
  };
};
