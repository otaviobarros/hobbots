import type { AgentId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { archivedThreadsQuery, threadsQuery } from "../../api/queries.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { messages } from "./messages.ts";

/**
 * What the chat workspace gives whatever fills its middle: the hob, the thread, the side panels' state
 * and whether the Quest room is open beside it.
 */
export type WorkspaceMainProps = ComponentProps<typeof ChatView> & { readonly room?: boolean };

/**
 * The middle of the chat workspace for a thread: the chat, or, once the thread is archived, a move to
 * where the Archive reads it with Restore. A thread opened by its address shows neither until its
 * hob's lists say which it is, so an archived thread never offers a composer. A chat started fresh
 * opens the hob's new chat instead. A thread archived on any
 * device moves to the Archive as its event arrives, and its unsent draft stays.
 */
export function ThreadMain({ room = false, ...props }: WorkspaceMainProps) {
  const { hobId, threadId } = props;
  const live = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.some((t) => t.id === threadId) });
  const archived = useQuery({
    ...archivedThreadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });

  // An archived thread is read in the Archive, with Restore, never as a chat here, on the message a
  // search matched. While its Quest room is open, the room keeps its recap and Workbench (ADR 027)
  // and the chat beside it says where to read the chat; Close room then moves to the Archive.
  if (archived.data) {
    if (room) return <ArchivedBeside hobId={hobId} threadId={archived.data.id} />;
    // A chat started fresh lives on in the new one, so its address opens that chat (ADR 037).
    if (archived.data.state === "superseded" && props.focusMessageId === undefined) {
      return <Navigate to="/hobs/$hobId/chat" params={{ hobId }} replace />;
    }
    return (
      <Navigate
        to="/archive/chats/$hobId/$threadId"
        params={{ hobId, threadId: archived.data.id }}
        search={{ message: props.focusMessageId }}
        replace
      />
    );
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

/** The chat beside an archived thread's Quest room: read-only, so it points to the Archive. */
function ArchivedBeside({ hobId, threadId }: { hobId: AgentId; threadId: ThreadId }) {
  return (
    <ThreadLookup>
      <p role="note" className="m-0 max-w-64 text-center text-text-secondary">
        {messages.archivedBeside}
      </p>
      <Link
        to="/archive/chats/$hobId/$threadId"
        params={{ hobId, threadId }}
        search={{}}
        className="text-ui text-link underline"
      >
        {messages.readInArchive}
      </Link>
    </ThreadLookup>
  );
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
