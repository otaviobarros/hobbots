import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import { useRestoreThread } from "../../api/archived-threads.ts";
import { ApiError } from "../../api/client.ts";
import { readDraft } from "../../api/drafts.ts";
import { agentsQuery, archivedThreadsQuery, messagesQuery, threadsQuery } from "../../api/queries.ts";
import { formatDay } from "../../lib/time.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { MessageRow, messageElementId } from "../chat/message-row.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages as chatCopy } from "../messages.ts";
import { ReconnectingCard } from "../shell/reconnecting.tsx";
import { messages } from "./messages.ts";

/** What the chat workspace gives whatever fills its middle: the hob, the thread and the side panels' state. */
export type WorkspaceMainProps = ComponentProps<typeof ChatView>;
type ChatProps = WorkspaceMainProps;

/**
 * The middle of the chat workspace for a thread: the chat, or the thread read-only while it is
 * archived. A thread opened by its address shows neither until its hob's lists say which it is, so
 * an archived thread never offers a composer. A thread archived or restored on any device switches
 * between the two as its event arrives, and its unsent draft stays.
 */
export function ThreadMain(props: WorkspaceMainProps) {
  const { hobId, threadId } = props;
  const live = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.some((t) => t.id === threadId) });
  const archived = useQuery({
    ...archivedThreadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });

  if (archived.data) return <ArchivedThreadView {...props} thread={archived.data} />;
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
    <main aria-label={messages.chat} className="flex min-w-chat-min flex-1 flex-col items-center justify-center gap-3">
      {children}
    </main>
  );
}

/** The chat header for an archived view: the hob, what is shown, Edit hob and the panel toggle. */
function ArchivedHeader({
  hob,
  props,
  title,
  detail,
  tagged = false,
}: {
  hob: Agent;
  props: ChatProps;
  title: string;
  detail: string;
  tagged?: boolean;
}) {
  return (
    <>
      <header className="flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
        <HobSprite hob={hob} size={36} state="idle" badge />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-heading text-xl font-semibold whitespace-nowrap">{hob.name}</span>
            <span className="text-ui font-bold whitespace-nowrap text-moonlight">{hob.roleTitle}</span>
            <span className="truncate text-text-secondary">{title}</span>
            {tagged && <Badge variant="archived">{messages.tag}</Badge>}
          </span>
          <span className="text-meta text-label">{detail}</span>
        </div>
        <Button asChild variant="outline">
          <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }}>
            {messages.editHob}
          </Link>
        </Button>
      </header>
      <ReconnectingCard className="mx-6 mt-2.5" />
    </>
  );
}

const useHob = (hobId: AgentId) => useQuery({ ...agentsQuery, select: (hobs) => hobs.find((h) => h.id === hobId) });

/** Why a restore failed, in words: a retired hob keeps its threads as they are; anything else is worth another try. */
const restoreError = (error: Error, hob: Agent, thread: Thread) =>
  error instanceof ApiError && error.tag === "ThreadArchiveRefused" && hob.status === "retired"
    ? messages.restoreRetired({ name: hob.name, title: thread.title })
    : messages.restoreFailed({ title: thread.title });

function RestoreButton({
  pending,
  label,
  onRestore,
  ...button
}: {
  pending: boolean;
  label: string;
  onRestore: () => void;
} & Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button {...button} disabled={pending} aria-label={label} onClick={onRestore}>
      {pending ? messages.restoring : messages.restore}
    </Button>
  );
}

function RestoreError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 border-2 border-rose px-3 py-2 text-ui">
      <span className="flex-1">{text}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {messages.tryAgain}
      </Button>
    </div>
  );
}

/**
 * An archived thread, read-only: the Archived tag, a banner with the date and Restore, and the
 * transcript with no composer, brain chip, Continue or Retry. Restoring brings the chat back here.
 */
function ArchivedThreadView({ thread, ...props }: ChatProps & { thread: Thread }) {
  const hob = useHob(props.hobId);
  const transcript = useQuery({
    ...messagesQuery(thread.id),
    select: (all) => all.filter((m) => m.status !== "queued"),
  });
  const restore = useRestoreThread();
  // A search match opens with its message in view.
  const focusLoaded = transcript.data?.some((m) => m.id === props.focusMessageId) ?? false;
  useEffect(() => {
    if (focusLoaded && props.focusMessageId)
      document.getElementById(messageElementId(props.focusMessageId))?.scrollIntoView({ block: "center" });
  }, [focusLoaded, props.focusMessageId]);
  const current = hob.data;
  if (!current) return <main className="flex-1" />;
  const date = formatDay(thread.archivedAt ?? thread.updatedAt);
  const draftKept = readDraft(thread.id).trim() !== "";

  return (
    <main aria-label={messages.chat} className="flex min-w-chat-min flex-1 flex-col">
      <ArchivedHeader hob={current} props={props} title={thread.title} detail={messages.readOnly} tagged />
      <section
        aria-label={messages.tag}
        className="flex flex-wrap items-center gap-3 border-b-4 border-line bg-card px-4 py-2.5 text-ui"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{messages.banner({ name: current.name, date })}</span>
          {draftKept && <span className="text-text-secondary">{messages.draftKept}</span>}
        </span>
        <RestoreButton
          pending={restore.isPending}
          label={messages.restoreThread({ title: thread.title })}
          onRestore={() => restore.mutate(thread.id)}
        />
      </section>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-transcript-y">
        {transcript.isPending && <p className="text-label">{messages.loadingMessages}</p>}
        {transcript.isError && <p className="text-ui text-rose">{messages.loadMessagesFailed}</p>}
        {transcript.data?.map((message) => (
          <MessageRow key={message.id} message={message} hob={current} focused={message.id === props.focusMessageId} />
        ))}
        {restore.error && (
          <RestoreError text={restoreError(restore.error, current, thread)} onRetry={() => restore.mutate(thread.id)} />
        )}
      </div>
      <ReadOnlyFooter hobId={current.id}>{messages.footer}</ReadOnlyFooter>
    </main>
  );
}

function ReadOnlyFooter({ hobId, children }: { hobId: AgentId; children: ReactNode }) {
  return (
    <p role="note" className="m-0 flex-none border-t-4 border-line px-6 py-3.5 text-ui text-text-secondary">
      {children} ·{" "}
      <Link to="/archive" search={{ hob: hobId }} className="text-lantern underline">
        {messages.backToArchived}
      </Link>
    </p>
  );
}
