import type { AgentId, ChannelId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { archivedChannelsQuery, channelsQuery } from "../../api/queries.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { messages } from "./messages.ts";

/**
 * What the chat workspace gives whatever fills its middle: the hob, the channel, the side panels' state
 * and whether the quest's Workbench is open beside it.
 */
export type WorkspaceMainProps = ComponentProps<typeof ChatView> & { readonly room?: boolean };

/**
 * The middle of the chat workspace for a channel: the chat, or, once the channel is archived, a move to
 * where the Archive reads it with Restore. A channel opened by its address shows neither until its
 * hob's lists say which it is, so an archived channel never offers a composer. A chat started fresh
 * opens the hob's new chat instead. A channel archived on any
 * device moves to the Archive as its event arrives, and its unsent draft stays.
 */
export function ChannelMain({ room = false, ...props }: WorkspaceMainProps) {
  const { hobId, channelId } = props;
  const live = useQuery({ ...channelsQuery(hobId), select: (channels) => channels.some((t) => t.id === channelId) });
  const archived = useQuery({
    ...archivedChannelsQuery(hobId),
    select: (channels) => channels.find((t) => t.id === channelId),
  });

  // An archived channel is read in the Archive, with Restore, never as a chat here, on the message a
  // search matched. While its quest's Workbench is open, it keeps its recap and Workbench (ADR 027)
  // and the chat beside it says where to read the chat; Close room then moves to the Archive.
  if (archived.data) {
    if (room) return <ArchivedBeside hobId={hobId} channelId={archived.data.id} />;
    // A chat started fresh lives on in the new one, so its address opens that chat (ADR 037).
    if (archived.data.state === "superseded" && props.focusMessageId === undefined) {
      return <Navigate to="/hobs/$hobId/chat" params={{ hobId }} replace />;
    }
    return (
      <Navigate
        to="/archive/chats/$hobId/$channelId"
        params={{ hobId, channelId: archived.data.id }}
        search={{ message: props.focusMessageId }}
        replace
      />
    );
  }
  if (channelId === undefined || live.data === true) return <ChatView key={channelId ?? `new-${hobId}`} {...props} />;
  if (live.isError || archived.isError) {
    return (
      <ChannelLookup>
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
      </ChannelLookup>
    );
  }
  if (live.isPending || archived.isPending) {
    return (
      <ChannelLookup>
        <p role="status" className="m-0 text-label">
          {messages.lookingUp}
        </p>
      </ChannelLookup>
    );
  }
  // Neither list holds it, so it is not archived: the chat says what the hub answers for it.
  return <ChatView key={channelId} {...props} />;
}

/** The chat beside an archived channel's quest Workbench: read-only, so it points to the Archive. */
function ArchivedBeside({ hobId, channelId }: { hobId: AgentId; channelId: ChannelId }) {
  return (
    <ChannelLookup>
      <p role="note" className="m-0 max-w-64 text-center text-text-secondary">
        {messages.archivedBeside}
      </p>
      <Link
        to="/archive/chats/$hobId/$channelId"
        params={{ hobId, channelId }}
        search={{}}
        className="text-ui text-link underline"
      >
        {messages.readInArchive}
      </Link>
    </ChannelLookup>
  );
}

function ChannelLookup({ children }: { children: ReactNode }) {
  return (
    <main
      aria-label={messages.chat}
      className="flex min-w-chat-min flex-1 group-data-[room=open]/room:min-w-0 flex-col items-center justify-center gap-3"
    >
      {children}
    </main>
  );
}
