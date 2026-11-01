import { type AgentId, isInProgress, isResumable, type ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useActivity } from "../api/activity.ts";
import { approvalsQuery } from "../api/approvals.ts";
import { appendDraft, moveDraft, restoreDraft, writeDraft } from "../api/drafts.ts";
import { useConnection } from "../api/live.ts";
import { enqueue, followed, takeBack, tryAgain, useOutbox, type WaitingPlace } from "../api/outbox.ts";
import {
  agentsQuery,
  messagesQuery,
  runtimesQuery,
  threadsQuery,
  useContinueReply,
  useInterrupt,
  usePauseHob,
  useRemoveQueued,
  useSendNow,
  useSendPrompt,
  useStartThread,
} from "../api/queries.ts";
import { runtimeProblem } from "../api/runtime-health.ts";
import { sendErrorText } from "../lib/send-error.ts";
import { ReplyApprovals } from "./approvals/reply-approvals.tsx";
import { Composer } from "./composer.tsx";
import { HobSprite, stateLabel, threadState } from "./hob-sprite.tsx";
import { MessageRow, messageElementId, QueuedRow } from "./message-row.tsx";
import { messages } from "./messages.ts";
import { RuntimeChip } from "./runtime.tsx";

/**
 * Keeps the transcript's end in view while the composer grows or shrinks, so a long draft never
 * hides the latest message. A transcript scrolled back stays where it is.
 */
const stayAtEnd = (view: HTMLDivElement | null) => {
  if (view === null) return;
  let height = view.clientHeight;
  const observer = new ResizeObserver(() => {
    if (view.scrollHeight - view.scrollTop - height < 24) view.scrollTop = view.scrollHeight;
    height = view.clientHeight;
  });
  observer.observe(view);
  return () => observer.disconnect();
};

const copy = messages.chat;

/** The middle of the chat workspace. Without a thread id it is the empty "fresh page". */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function ChatView({
  hobId,
  threadId,
  focusMessageId,
  navOpen,
  panelOpen,
  onShowNav,
  onTogglePanel,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  focusMessageId?: string | undefined;
  navOpen: boolean;
  panelOpen: boolean;
  onShowNav: () => void;
  onTogglePanel: () => void;
}) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  const thread = useQuery({
    ...threadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });
  const threadCount = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.length });
  const messages = useQuery({ ...messagesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  // A new request for approval scrolls into view like new text, so a paused reply never waits unseen.
  const asking = useQuery({
    ...approvalsQuery(threadId ?? ("" as ThreadId)),
    enabled: threadId !== undefined,
    select: (approvals) => approvals.filter((approval) => approval.state === "pending").length,
  });
  const activity = useActivity();
  const navigate = useNavigate();
  // Messages sent while the hub is out of reach wait in the outbox, which sends them when it is back.
  const place: WaitingPlace = threadId ?? `new-${hobId}`;
  const outbox = useOutbox(place);
  const waiting = outbox.messages;
  const connection = useConnection();
  const brain = useQuery({ ...runtimesQuery, select: (runtimes) => runtimeProblem(runtimes[0]) });
  const bottom = useRef<HTMLDivElement>(null);

  const send = useSendPrompt(threadId ?? ("" as ThreadId));
  const start = useStartThread(hobId);
  const interrupt = useInterrupt(threadId ?? ("" as ThreadId));
  const pause = usePauseHob(hobId);
  const remove = useRemoveQueued(threadId ?? ("" as ThreadId));
  const sendNow = useSendNow(threadId ?? ("" as ThreadId));
  const resume = useContinueReply(threadId ?? ("" as ThreadId));

  const streaming = messages.data?.some((m) => isInProgress(m.status)) ?? false;
  // Stopping lasts from the hub recording the request until the runtime confirms the turn ended.
  const stopping = interrupt.isPending || (messages.data?.some((m) => m.status === "stopping") ?? false);
  // Queued messages wait below the transcript, in the order they will start.
  const transcript = messages.data?.filter((m) => m.status !== "queued");
  const queued = messages.data?.filter((m) => m.status === "queued") ?? [];
  const lastContent = messages.data?.at(-1)?.content;
  // Up brings back the last message that went out; a queued one is still there to remove or edit.
  const lastSent = transcript?.findLast((m) => m.role === "user")?.content;
  // Only the thread's latest reply can be continued, and only while nothing else runs.
  const latest = transcript?.at(-1);
  const resumable =
    latest?.role === "assistant" && isResumable(latest.status) && !streaming && hob.data?.status === "active"
      ? latest
      : undefined;

  // A search match opens with its message in view and holds it there while a reply streams, until
  // the user scrolls back down to the end or sends a message.
  const [released, setReleased] = useState<string>();
  const holding = focusMessageId !== undefined && released !== focusMessageId;
  const follow = () => setReleased(focusMessageId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pending approval scrolls like new text.
  useEffect(() => {
    if (lastContent !== undefined && !holding) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastContent, asking.data, holding]);

  const focusLoaded = messages.data?.some((m) => m.id === focusMessageId) ?? false;
  useEffect(() => {
    if (focusLoaded && focusMessageId)
      document.getElementById(messageElementId(focusMessageId))?.scrollIntoView({ block: "center" });
  }, [focusLoaded, focusMessageId]);

  // When a waiting message starts this page's thread, the page follows it there with its draft.
  useEffect(() => {
    const started = outbox.startedThread;
    if (started === undefined) return;
    followed(place);
    moveDraft(place, started);
    void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: started } });
  }, [outbox.startedThread, place, hobId, navigate]);
  // A send answered after the user left this page must not pull them back to it.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  const current = hob.data;
  if (!current) return <main className="flex-1" />;

  const state = threadState(current, threadId ? activity[threadId] : undefined, streaming);
  const paused = current.status === "paused";
  const title = thread.data?.title ?? copy.newThread;
  // The draft clears as it is sent, so the next message can be typed at once. A refused send puts
  // its text back, even when the user has moved to another thread meanwhile.
  const deliver = (content: string) => {
    const sent = threadId
      ? send.mutateAsync(content)
      : start.mutateAsync(content).then(({ thread: created }) => {
          if (!shown.current) return;
          moveDraft(place, created.id);
          void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: created.id } });
        });
    sent.catch(() => restoreDraft(place, content));
  };
  const sendDraft = (content: string) => {
    follow();
    writeDraft(place, "");
    // Behind messages already waiting, a new one waits too, so they go out in the order sent.
    if (connection === "reconnecting" || waiting.length > 0) {
      enqueue(place, content);
      return;
    }
    deliver(content);
  };
  const error = send.error ?? start.error;
  const queueError = remove.error ?? sendNow.error;
  const brainProblem = brain.data ?? null;
  // Waking clears a send the paused hob refused, so the draft can simply be sent again.
  const wake = () =>
    pause.mutate(false, {
      onSuccess: () => {
        send.reset();
        start.reset();
      },
    });
  // A hob with no threads yet has just arrived, so its first page says hello.
  const newHob = threadId === undefined && threadCount.data === 0;
  const empty = threadId === undefined || messages.data?.length === 0;

  return (
    <main aria-label="Chat" className="flex min-w-[360px] flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
        {!navOpen && (
          <Button variant="icon" size="icon" onClick={onShowNav} aria-label={copy.showNav} title={copy.showNav}>
            »
          </Button>
        )}
        <HobSprite hob={current} size={36} state={state} badge />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-pixel text-xl font-semibold whitespace-nowrap">{current.name}</span>
            <span className="text-sm font-bold whitespace-nowrap text-moonlight">{current.roleTitle}</span>
            <span className="truncate text-secondary-text">{title}</span>
          </span>
          <span className="text-xs text-label">{stateLabel[state]}</span>
        </div>
        <RuntimeChip />
        <Button asChild variant="outline">
          <Link to="/hobs/$hobId/profile" params={{ hobId }}>
            Edit hob
          </Link>
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onTogglePanel}
          aria-label={panelOpen ? copy.hidePanel : copy.showPanel}
          title={panelOpen ? copy.hidePanel : copy.showPanel}
        >
          {panelOpen ? "»" : "«"}
        </Button>
      </header>

      <div
        onScroll={(event) => {
          const view = event.currentTarget;
          if (holding && view.scrollHeight - view.scrollTop - view.clientHeight < 24) follow();
        }}
        ref={stayAtEnd}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-[18px]"
      >
        {threadId && messages.isPending && <p className="text-label">Loading messages…</p>}
        {empty && !messages.isLoading && (
          <div className="m-auto flex max-w-[420px] animate-hb-in flex-col items-center gap-3 text-center">
            <HobSprite hob={current} size={72} state="working" />
            <span className="font-pixel text-[22px] font-bold text-moonlight">
              {newHob ? copy.hello(current) : copy.freshPage}
            </span>
            <span className="text-secondary-text">{newHob ? copy.helloBody : copy.freshBody(current)}</span>
            <div className="flex flex-wrap justify-center gap-1.5">
              {copy.ideas.map((idea) => (
                <Button key={idea} variant="chip" onClick={() => writeDraft(place, idea)}>
                  {idea}
                </Button>
              ))}
            </div>
          </div>
        )}
        {transcript?.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            hob={current}
            focused={message.id === focusMessageId}
            resume={
              message.id === resumable?.id
                ? { pending: resume.isPending, onContinue: () => resume.mutate(message.id) }
                : undefined
            }
          >
            <ReplyApprovals threadId={message.threadId} messageId={message.id} hob={current} />
          </MessageRow>
        ))}
        {queued.map((message) => (
          <QueuedRow
            key={message.id}
            message={message}
            hob={current}
            replying={streaming}
            pending={remove.isPending || sendNow.isPending}
            onRemove={() => remove.mutate(message.id)}
            onSendNow={() => sendNow.mutate(message.id)}
          />
        ))}
        {waiting.map((message, index) => (
          <section
            key={message.id}
            aria-label={copy.waiting}
            className="flex max-w-[460px] animate-hb-in flex-col items-end gap-1.5 self-end"
          >
            <div className="bg-line px-3.5 py-2.5 leading-[1.45] whitespace-pre-wrap opacity-80">{message.content}</div>
            <span className="text-xs text-label">
              {outbox.refused && index === 0
                ? copy.waitingRefused
                : connection === "live"
                  ? copy.waitingSending
                  : copy.waitingOffline}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={outbox.sending === message.id}
                onClick={() => {
                  const content = takeBack(place, message.id);
                  if (content === undefined) return;
                  appendDraft(place, content);
                }}
              >
                {copy.edit}
              </Button>
              {outbox.refused && index === 0 && (
                <Button variant="outline" size="xs" onClick={() => tryAgain(place)}>
                  {copy.tryAgain}
                </Button>
              )}
            </span>
          </section>
        ))}
        {resume.isError && (
          <p role="alert" className="text-sm text-rose">
            {copy.continueFailed({ name: current.name, why: sendErrorText(resume.error, current) })}
          </p>
        )}
        {queueError && (
          <p role="alert" className="text-sm text-rose">
            {copy.queueGone}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose">
            {sendErrorText(error, current)}
          </p>
        )}
        {pause.isError && (
          <p role="alert" className="text-sm text-rose">
            {copy.wakeFailed(current)}
          </p>
        )}
        <div ref={bottom} />
      </div>

      {brainProblem !== null && (
        <section
          aria-label={copy.brainUnavailable}
          className="mx-4 mb-2 flex flex-wrap items-center gap-2.5 bg-card px-3.5 py-2.5 text-sm"
        >
          <span className="flex-1 text-lantern">
            {copy.brainProblem({ name: current.name, problem: copy.brain[brainProblem] })}
          </span>
          <Button asChild variant="outline" size="xs">
            <Link to="/settings" hash="ai-providers">
              {copy.fixInSettings}
            </Link>
          </Button>
        </section>
      )}
      <Composer
        placeholder={copy.placeholder({ name: current.name, title })}
        place={place}
        lastSent={lastSent}
        busy={streaming}
        stopping={stopping}
        sending={start.isPending || send.isPending}
        onSend={sendDraft}
        onStop={() => interrupt.mutate()}
        paused={
          paused
            ? { name: current.name, waking: pause.isPending, onWake: wake, canQueue: threadId !== undefined }
            : undefined
        }
      />
    </main>
  );
}
