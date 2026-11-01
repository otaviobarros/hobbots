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
import { formatDay, formatWhen } from "../../lib/time.ts";
import { ChatView } from "../chat-view.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { MessageRow, messageElementId } from "../message-row.tsx";
import { messages as chatCopy } from "../messages.ts";
import { messages } from "./messages.ts";

type ChatProps = ComponentProps<typeof ChatView>;

/**
 * The middle of the chat workspace: the hob's archived threads with `archivedList`, an archived
 * thread read-only, and otherwise the chat. A thread archived or restored on any device switches
 * between the chat and the read-only view as its event arrives, and its unsent draft stays.
 */
export function ThreadMain({ archivedList = false, ...props }: ChatProps & { archivedList?: boolean | undefined }) {
  const { hobId, threadId } = props;
  const live = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.some((t) => t.id === threadId) });
  const archived = useQuery({
    ...archivedThreadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });

  if (archivedList) return <ArchivedThreadList {...props} />;
  if (archived.data) return <ArchivedThreadView {...props} thread={archived.data} />;
  // A thread that is not live may be archived: wait for that list rather than offer a composer.
  if (threadId !== undefined && live.data === false && archived.isPending) return <main className="flex-1" />;
  return <ChatView key={threadId ?? `new-${hobId}`} {...props} />;
}

/**
 * "Archived · N" at the end of an open hob's thread list. It hides at zero, except while the
 * archived list is open, and is selected while that list or an archived thread is open.
 */
export function ArchivedEntry({ hobId, threadId }: { hobId: AgentId; threadId?: ThreadId | undefined }) {
  const archived = useQuery(archivedThreadsQuery(hobId));
  const matchRoute = useMatchRoute();
  const listOpen = matchRoute({ to: "/hobs/$hobId/archived", params: { hobId } }) !== false;
  const count = archived.data?.length ?? 0;
  const current = listOpen || (threadId !== undefined && archived.data?.some((t) => t.id === threadId) === true);
  if (count === 0 && !listOpen) return null;

  return (
    <Link
      to="/hobs/$hobId/archived"
      params={{ hobId }}
      aria-current={current ? "page" : undefined}
      aria-label={messages.entryLabel({ count })}
      className={cn(
        "flex w-full items-center gap-2 py-[7px] ps-[34px] pe-2.5 text-sm text-text no-underline hover:bg-hover hover:text-text",
        current && "bg-line text-moonlight hover:text-moonlight",
      )}
    >
      <span aria-hidden className="size-2.5 flex-none border-2 border-secondary-text" />
      <span className="min-w-0 flex-1 truncate">{messages.entry}</span>
      <span className="text-[11px] whitespace-nowrap text-label">{count}</span>
    </Link>
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
    <header className="flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
      {!props.navOpen && (
        <Button
          variant="icon"
          size="icon"
          onClick={props.onShowNav}
          aria-label={chatCopy.chat.showNav}
          title={chatCopy.chat.showNav}
        >
          »
        </Button>
      )}
      <HobSprite hob={hob} size={36} state="idle" badge />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-pixel text-xl font-semibold whitespace-nowrap">{hob.name}</span>
          <span className="text-sm font-bold whitespace-nowrap text-moonlight">{hob.roleTitle}</span>
          <span className="truncate text-secondary-text">{title}</span>
          {tagged && <Badge variant="archived">{messages.tag}</Badge>}
        </span>
        <span className="text-xs text-label">{detail}</span>
      </div>
      <Button asChild variant="outline">
        <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }}>
          {messages.editHob}
        </Link>
      </Button>
      <Button
        variant="icon"
        size="icon"
        onClick={props.onTogglePanel}
        aria-label={props.panelOpen ? chatCopy.chat.hidePanel : chatCopy.chat.showPanel}
        title={props.panelOpen ? chatCopy.chat.hidePanel : chatCopy.chat.showPanel}
      >
        {props.panelOpen ? "»" : "«"}
      </Button>
    </header>
  );
}

const useHob = (hobId: AgentId) => useQuery({ ...agentsQuery, select: (hobs) => hobs.find((h) => h.id === hobId) });

/** When a thread was archived, in a row: "just now", else its day. */
const archivedWhen = (iso: string, now: Date = new Date()) =>
  now.getTime() - new Date(iso).getTime() < 60_000 ? messages.justNow : formatDay(iso, now);

/** Why a restore failed, in words: a retired hob keeps its threads as they are; anything else is worth another try. */
const restoreError = (error: Error, hob: Agent, thread: Thread) =>
  error instanceof ApiError && error.tag === "ThreadArchiveRefused" && hob.status === "retired"
    ? messages.restoreRetired({ name: hob.name, title: thread.title })
    : messages.restoreFailed({ title: thread.title });

/** The hob's archived threads in place of the chat, most recently archived first, each with Restore. */
function ArchivedThreadList(props: ChatProps) {
  const hob = useHob(props.hobId);
  const archived = useQuery(archivedThreadsQuery(props.hobId));
  const current = hob.data;
  if (!current) return <main className="flex-1" />;
  const count = archived.data?.length ?? 0;

  return (
    <main aria-label={messages.title} className="flex min-w-[360px] flex-1 flex-col">
      <ArchivedHeader
        hob={current}
        props={props}
        title={messages.title}
        detail={archived.data ? messages.threadCount({ count }) : ""}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-[18px]">
        {archived.isPending && <p className="m-0 text-label">{messages.loading}</p>}
        {archived.isError && <p className="m-0 text-sm text-rose">{messages.loadFailed}</p>}
        {archived.data && count === 0 && <EmptyArchive hob={current} />}
        {archived.data && count > 0 && (
          <>
            <p className="m-0 text-secondary-text">{messages.intro({ name: current.name })}</p>
            <ul aria-label={messages.title} className="m-0 flex list-none flex-col p-0">
              {archived.data.map((thread) => (
                <ArchivedRow key={thread.id} hob={current} thread={thread} />
              ))}
            </ul>
            <p className="m-0 text-[13px] text-label">{messages.hint}</p>
          </>
        )}
      </div>
    </main>
  );
}

function EmptyArchive({ hob }: { hob: Agent }) {
  return (
    <section
      aria-label={messages.empty}
      className="flex max-w-[460px] animate-hb-in flex-col gap-2 bg-deep px-4 py-3.5 text-secondary-text"
    >
      <h2 className="m-0 font-pixel text-base font-semibold text-text">{messages.empty}</h2>
      <p className="m-0 text-sm">{messages.emptyBody({ name: hob.name })}</p>
      <Link to="/hobs/$hobId" params={{ hobId: hob.id }} className="text-sm text-lantern underline">
        {messages.backToThreads({ name: hob.name })}
      </Link>
    </section>
  );
}

function ArchivedRow({ hob, thread }: { hob: Agent; thread: Thread }) {
  const restore = useRestoreThread();
  return (
    <li className="flex flex-col gap-1.5 border-b-2 border-line py-3">
      <div className="flex items-center gap-3">
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: hob.id, threadId: thread.id }}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-text no-underline hover:text-moonlight"
        >
          <span className="truncate font-bold">{thread.title}</span>
          <span className="text-[13px] text-secondary-text">
            {messages.rowDetail({
              archived: thread.archivedAt ? archivedWhen(thread.archivedAt) : messages.justNow,
              last: formatWhen(thread.updatedAt),
            })}
          </span>
        </Link>
        <RestoreButton
          variant="outline"
          size="sm"
          pending={restore.isPending}
          label={messages.restoreThread({ title: thread.title })}
          onRestore={() => restore.mutate(thread.id)}
        />
      </div>
      {restore.error && (
        <RestoreError text={restoreError(restore.error, hob, thread)} onRetry={() => restore.mutate(thread.id)} />
      )}
    </li>
  );
}

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
    <div role="alert" className="flex items-center gap-3 border-2 border-rose px-3 py-2 text-sm">
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
    <main aria-label="Chat" className="flex min-w-[360px] flex-1 flex-col">
      <ArchivedHeader hob={current} props={props} title={thread.title} detail={messages.readOnly} tagged />
      <section
        aria-label={messages.tag}
        className="flex flex-wrap items-center gap-3 border-b-4 border-line bg-card px-4 py-2.5 text-sm"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{messages.banner({ name: current.name, date })}</span>
          {draftKept && <span className="text-secondary-text">{messages.draftKept}</span>}
        </span>
        <RestoreButton
          pending={restore.isPending}
          label={messages.restoreThread({ title: thread.title })}
          onRestore={() => restore.mutate(thread.id)}
        />
      </section>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-[18px]">
        {transcript.isPending && <p className="text-label">{messages.loadingMessages}</p>}
        {transcript.isError && <p className="text-sm text-rose">{messages.loadMessagesFailed}</p>}
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
    <p role="note" className="m-0 flex-none border-t-4 border-line px-6 py-3.5 text-sm text-secondary-text">
      {children} ·{" "}
      <Link to="/hobs/$hobId/archived" params={{ hobId }} className="text-lantern underline">
        {messages.backToArchived}
      </Link>
    </p>
  );
}
