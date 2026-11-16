import type { Agent, AgentId, Channel, ChannelId } from "@hobbots/domain";
import { ToastProvider } from "@hobbots/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useArchiveChannel, useUndoArchive } from "../../api/archive.ts";
import { ApiError } from "../../api/client.ts";
import { queryKeys } from "../../api/queries.ts";
import { isTextField } from "../../lib/page-keys.ts";
import { type ArchiveBlock, isArchiveKey, isUndoKey, nextChannel } from "./archive-rules.ts";
import { ArchiveToast } from "./archive-toast.tsx";
import { useArchiveBlock } from "./use-archive-block.ts";

/** Why the hub refused an archive. */
export type ArchiveRefusal = ArchiveBlock | "hob-retired";

/**
 * Where the workspace shows: a hob's channel, or its fresh page. Archiving the open channel moves to
 * the next one, and the archived channel opens again (after a failure, or on Undo) only while the
 * user is still there.
 */
export interface Place {
  readonly hobId: AgentId | undefined;
  readonly channelId: ChannelId | undefined;
}

/** What the toast above the composer says; `id` makes each notice a new toast. */
export type Notice = { readonly id: number; readonly hob: Agent } & (
  | { readonly kind: "archived"; readonly channel: Channel; readonly movedTo: Place | null }
  | { readonly kind: "cant-yet"; readonly block: ArchiveBlock }
  | { readonly kind: "refused"; readonly channel: Channel; readonly reason: ArchiveRefusal }
  | {
      readonly kind: "failed";
      readonly action: "archive" | "undo";
      readonly channel: Channel;
      readonly movedTo: Place | null;
    }
);

type NoticeBody = Notice extends infer N ? (N extends Notice ? Omit<N, "id"> : never) : never;

interface ArchiveActions {
  /** Archives a channel; the open one gives way to the next channel first. */
  readonly archive: (hob: Agent, channel: Channel) => void;
}

const ArchiveContext = createContext<ArchiveActions | null>(null);

/** The archive actions of the chat workspace. */
export const useArchive = (): ArchiveActions => {
  const actions = useContext(ArchiveContext);
  if (actions === null) throw new Error("useArchive needs an ArchiveProvider");
  return actions;
};

const refusalOf = (error: unknown): ArchiveRefusal | undefined =>
  error instanceof ApiError && error.tag === "ChannelArchiveRefused"
    ? (error.fields.reason as ArchiveRefusal | undefined)
    : undefined;

/** Scrolls the open channel's waiting approval card into view and focuses its first button. */
const showRequest = () => {
  const card = document.querySelector<HTMLElement>('main[aria-label="Chat"] section[data-state="pending"]');
  if (card === null) return;
  card.scrollIntoView({ block: "center" });
  card.querySelector<HTMLElement>("button")?.focus();
};

/**
 * Archiving for every page after setup: the actions behind the channel menus, ⌃⌘A for the open
 * channel, and the toast with Undo, which ⌘Z also takes while it shows and focus is not in a text
 * field. It sits above the routes, so a toast outlives the move to another page, as when the hob's
 * last chat is archived and its fresh page opens.
 */
export function ArchiveProvider({
  hobId,
  channelId,
  children,
}: {
  /** The hob whose page or chat is open, if any. */
  hobId: AgentId | undefined;
  channelId: ChannelId | undefined;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const archiving = useArchiveChannel();
  const undoing = useUndoArchive();
  const [notice, setNotice] = useState<Notice | null>(null);
  const block = useArchiveBlock(channelId);
  // Where the user is now, for callbacks that answer after they may have moved on.
  const here = useRef<Place>({ hobId, channelId });
  useEffect(() => {
    here.current = { hobId, channelId };
  }, [hobId, channelId]);
  const stillAt = (place: Place | null): place is Place =>
    place !== null && here.current.hobId === place.hobId && here.current.channelId === place.channelId;

  const show = (body: NoticeBody) => setNotice((old) => ({ ...body, id: (old?.id ?? 0) + 1 }) as Notice);
  const openChannel = (channel: Channel) =>
    void navigate({
      to: "/hobs/$hobId/channels/$channelId",
      params: { hobId: channel.ownerHobId, channelId: channel.id },
    });

  /** Moves off the open channel to the next one, else the fresh page, and says where. */
  const moveOn = (hob: Agent, channel: Channel): Place => {
    const next = nextChannel(
      queryClient.getQueryData<ReadonlyArray<Channel>>(queryKeys.channels(hob.id)) ?? [],
      channel.id,
    );
    if (next) openChannel(next);
    else void navigate({ to: "/hobs/$hobId/chat", params: { hobId: hob.id } });
    here.current = { hobId: hob.id, channelId: next?.id };
    return here.current;
  };

  const archive = (hob: Agent, channel: Channel) => {
    const movedTo = channel.id === channelId ? moveOn(hob, channel) : null;
    archiving.mutate(channel, {
      onSuccess: () => show({ kind: "archived", hob, channel, movedTo }),
      onError: (error) => {
        // The channel stepped back into the list; it opens again unless the user has moved on.
        if (stillAt(movedTo)) openChannel(channel);
        const reason = refusalOf(error);
        show(
          reason
            ? { kind: "refused", hob, channel, reason }
            : { kind: "failed", action: "archive", hob, channel, movedTo },
        );
      },
    });
  };

  const undo = (hob: Agent, channel: Channel, movedTo: Place | null) => {
    setNotice(null);
    undoing.mutate(channel, {
      onSuccess: () => {
        if (stillAt(movedTo)) openChannel(channel);
      },
      onError: () => show({ kind: "failed", action: "undo", hob, channel, movedTo }),
    });
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (isUndoKey(event) && notice?.kind === "archived" && !isTextField(document.activeElement)) {
      event.preventDefault();
      undo(notice.hob, notice.channel, notice.movedTo);
      return;
    }
    if (!isArchiveKey(event) || hobId === undefined || channelId === undefined) return;
    const hob = queryClient.getQueryData<ReadonlyArray<Agent>>(queryKeys.agents)?.find((a) => a.id === hobId);
    const channel = queryClient
      .getQueryData<ReadonlyArray<Channel>>(queryKeys.channels(hobId))
      ?.find((t) => t.id === channelId);
    if (hob === undefined || channel === undefined) return;
    event.preventDefault();
    if (block !== null) show({ kind: "cant-yet", hob, block });
    else archive(hob, channel);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const retry = (failed: Extract<Notice, { kind: "failed" }>) => {
    setNotice(null);
    if (failed.action === "undo") undo(failed.hob, failed.channel, failed.movedTo);
    else archive(failed.hob, failed.channel);
  };

  return (
    <ArchiveContext.Provider value={{ archive }}>
      <ToastProvider>
        {children}
        {notice && (
          <ArchiveToast
            key={notice.id}
            notice={notice}
            onClose={() => setNotice(null)}
            onUndo={(archived) => undo(archived.hob, archived.channel, archived.movedTo)}
            onShowRequest={showRequest}
            onRetry={retry}
          />
        )}
      </ToastProvider>
    </ArchiveContext.Provider>
  );
}
