import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { archivedThreadsQuery, threadsQuery } from "../../api/queries.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { messages } from "./messages.ts";

/** What the chat workspace gives whatever fills its middle: the hob, the thread and the side panels' state. */
export type WorkspaceMainProps = ComponentProps<typeof ChatView>;

/**
 * The middle of the chat workspace for a thread: the chat, or, once the thread is archived, a move to
 * where the Archive reads it with Restore. A thread opened by its address shows neither until its
 * hob's lists say which it is, so an archived thread never offers a composer. A thread archived on any
 * device moves to the Archive as its event arrives, and its unsent draft stays.
 */
export function ThreadMain(props: WorkspaceMainProps) {
  const { hobId, threadId } = props;
  const live = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.some((t) => t.id === threadId) });
  const archived = useQuery({
    ...archivedThreadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });

  // An archived thread is read in the Archive, with Restore, never as a chat here.
  if (archived.data) {
    return <Navigate to="/archive/chats/$hobId/$threadId" params={{ hobId, threadId: archived.data.id }} replace />;
  }
  if (threadId === undefined || live.data === true) return <ChatView key={threadId ?? `new-${hobId}`} {...props} />;
  if (live.isError || archived.isError) {
    return (
      <ThreadLookup>
        <p role="alert" className="m-0 text-rose">
          {messages.lookupFailed}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (live.isError) void live.refetch();
            if (archived.isError) void archived.refetch();
          }}
        >
          {messages.tryAgain}
        </Button>
      </ThreadLookup>
    );
  }
  if (live.isPending || archived.isPending) {
    return (
      <ThreadLookup>
        <p role="status" className="m-0 text-label">
          {messages.lookingUp}
        </p>
      </ThreadLookup>
    );
  }
  // Neither list holds it, so it is not archived: the chat says what the hub answers for it.
  return <ChatView key={threadId} {...props} />;
}

function ThreadLookup({ children }: { children: ReactNode }) {
  return (
    <main
      aria-label={messages.chat}
      className="flex min-w-chat-min flex-1 group-data-[room=open]/room:min-w-0 flex-col items-center justify-center gap-3"
    >
      {children}
    </main>
  );
}
