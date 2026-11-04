import {
  type Agent,
  type AgentId,
  isInProgress,
  isResumable,
  type Message,
  type MessageId,
  RUNTIME_NAMES,
  type RuntimeKind,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { useActivity } from "../../api/activity.ts";
import { appendDraft, moveDraft, restoreDraft, writeDraft } from "../../api/drafts.ts";
import { useConnection } from "../../api/live.ts";
import { enqueue, followed, takeBack, tryAgain, useOutbox, type WaitingPlace } from "../../api/outbox.ts";
import {
  agentsQuery,
  messagesQuery,
  runtimesQuery,
  threadBrain,
  threadsQuery,
  useContinueReply,
  useInterrupt,
  usePauseHob,
  useRemoveQueued,
  useSendNow,
  useSendPrompt,
  useSetBrain,
  useStartThread,
} from "../../api/queries.ts";
import { runtimeProblem } from "../../api/runtime-health.ts";
import { brainSwitches, lastReplyBrain } from "../../lib/brains.ts";
import { sendErrorText } from "../../lib/send-error.ts";
import { ReplyApprovals } from "../approvals/reply-approvals.tsx";
import { ArchiveToastViewport } from "../archive/archive-toast.tsx";
import { ThreadHeaderMenu } from "../archive/thread-menu.tsx";
import { WorkHeldNotice } from "../backup/work-held-notice.tsx";
import { ChatSearch, ChatSearchButton } from "../chat-search/chat-search.tsx";
import { HobSprite, stateLabel, threadState } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { NeedsTray } from "../needs-tray/needs-tray.tsx";
import { useThreadNeeds } from "../needs-tray/use-thread-needs.ts";
import { BrainPicker, BrainSwitchNote, useOtherReadyRuntimes } from "../providers/brain-picker.tsx";
import { PinNotes } from "../quest/pin-notes.tsx";
import { ThreadQuestButton, useWorkMoments } from "../quest/thread-work.tsx";
import type { Pins } from "../quest/use-work.ts";
import { ReconnectingCard } from "../shell/reconnecting.tsx";
import { ChatTitle } from "./chat-title.tsx";
import { Composer } from "./composer.tsx";
import { EmptyThread } from "./empty-thread.tsx";
import { type ContinueReply, MessageRow, messageElementId, QueuedRow, WaitingRow } from "./message-row.tsx";

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
const brainCopy = messages.brain;

/** The middle of the chat workspace. Without a thread id it is the empty "fresh page". */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function ChatView({
  hobId,
  threadId,
  focusMessageId,
  pins,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  focusMessageId?: string | undefined;
  /** The Quests pinned to every thread's header. */
  pins: Pins;
}) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  const thread = useQuery({
    ...threadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });
  const threadCount = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.length });
  const messages = useQuery({ ...messagesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  // What waits on you in this chat shows in the tray above the composer.
  const needs = useThreadNeeds(threadId);
  const activity = useActivity();
  const navigate = useNavigate();
  // Messages sent while the hub is out of reach wait in the outbox, which sends them when it is back.
  const place: WaitingPlace = threadId ?? `new-${hobId}`;
  const outbox = useOutbox(place);
  const waiting = outbox.messages;
  const connection = useConnection();
  // The problem of the runtime this thread thinks with, not only Claude Code's.
  const runtime = hob.data ? threadBrain(hob.data, thread.data).runtime : "claude-code";
  const brain = useQuery({
    ...runtimesQuery,
    select: (runtimes) => runtimeProblem(runtimes.find((health) => health.runtime === runtime)),
  });
  const bottom = useRef<HTMLDivElement>(null);

  const send = useSendPrompt(threadId ?? ("" as ThreadId));
  const start = useStartThread(hobId);
  const interrupt = useInterrupt(threadId ?? ("" as ThreadId));
  const pause = usePauseHob(hobId);
  const remove = useRemoveQueued(threadId ?? ("" as ThreadId));
  const sendNow = useSendNow(threadId ?? ("" as ThreadId));
  const resume = useContinueReply(threadId ?? ("" as ThreadId));
  const continueOn = useContinueOn(hobId, threadId ?? ("" as ThreadId), runtime, resume);

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
  // The search box under the header, opened from its magnifier, belongs to the thread it opened in.
  const [findingIn, setFindingIn] = useState<string>();
  const finding = threadId !== undefined && findingIn === threadId;
  const setFinding = (open: boolean) => setFindingIn(open ? threadId : undefined);
  const [renamingIn, setRenamingIn] = useState<string>();
  const renaming = threadId !== undefined && renamingIn === threadId;
  const setRenaming = (open: boolean) => setRenamingIn(open ? threadId : undefined);
  const holding = focusMessageId !== undefined && released !== focusMessageId;
  const follow = () => setReleased(focusMessageId);

  useEffect(() => {
    if (lastContent !== undefined && !holding) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastContent, holding]);

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
      <header className="@container/header flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
        {/* The tile and the name both open the hob's page; the tile is left out of the tab order. */}
        <Link to="/hobs/$hobId" params={{ hobId }} tabIndex={-1} aria-hidden className="shrink-0">
          <HobSprite hob={current} size={36} state={state} badge />
        </Link>
        {/* The hob's name keeps its room when the quest button and the brain picker crowd the header. */}
        <div className="flex min-w-[120px] flex-1 flex-col overflow-hidden">
          <span className="flex min-w-0 items-baseline gap-2">
            <Link
              to="/hobs/$hobId"
              params={{ hobId }}
              title={copy.openHob({ name: current.name })}
              className="font-heading text-xl font-semibold whitespace-nowrap text-text-strong no-underline hover:underline"
            >
              {current.name}
            </Link>
            <span className="text-sm font-bold whitespace-nowrap text-moonlight">{current.roleTitle}</span>
            <ChatTitle thread={thread.data} title={title} renaming={renaming} onDone={() => setRenaming(false)} />
          </span>
          <span className="text-xs text-label">{stateLabel[state]}</span>
        </div>
        {threadId && <ThreadQuestButton hobId={hobId} threadId={threadId} pins={pins} />}
        <BrainPicker hob={current} thread={thread.data} />
        {thread.data && <ChatSearchButton open={finding} onToggle={() => setFinding(!finding)} />}
        {thread.data && (
          <ThreadHeaderMenu
            hob={current}
            thread={thread.data}
            onRename={() => setRenaming(true)}
            onSearch={() => setFinding(true)}
          />
        )}
        <Button asChild variant="outline">
          <Link to="/hobs/$hobId/profile" params={{ hobId }}>
            Edit hob
          </Link>
        </Button>
      </header>
      <ReconnectingCard className="mx-6 mt-2.5" />
      {threadId && finding && (
        <ChatSearch
          hob={current}
          threadId={threadId}
          transcript={messages.data ?? []}
          onClose={() => setFinding(false)}
        />
      )}
      {threadId && <PinNotes threadId={threadId} pins={pins} />}

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
          <EmptyThread hob={current} newHob={newHob} onIdea={(idea) => writeDraft(place, idea)} />
        )}
        {transcript && (
          <Transcript
            transcript={transcript}
            hob={current}
            threadId={threadId}
            thread={thread.data}
            focusMessageId={focusMessageId}
            streaming={streaming}
            resume={(message) =>
              message.id === resumable?.id
                ? {
                    pending: resume.isPending || continueOn.isPending,
                    onContinue: () => resume.mutate(message.id),
                    alternatives: continueOn.alternatives(message.id),
                  }
                : undefined
            }
          />
        )}
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
          <WaitingRow
            key={message.id}
            message={message}
            refused={outbox.refused && index === 0}
            live={connection === "live"}
            sending={outbox.sending === message.id}
            onEdit={() => {
              const content = takeBack(place, message.id);
              if (content !== undefined) appendDraft(place, content);
            }}
            onTryAgain={() => tryAgain(place)}
          />
        ))}
        {continueOn.isError && (
          <p role="alert" className="text-sm text-rose">
            {brainCopy.continueFailed({ name: current.name })}
          </p>
        )}
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
            {copy.brainProblem({
              name: current.name,
              runtime: RUNTIME_NAMES[runtime],
              problem: copy.brain[brainProblem],
            })}
          </span>
          <Button asChild variant="outline" size="xs">
            <Link to="/settings/$section" params={{ section: "connections" }}>
              {copy.fixInSettings}
            </Link>
          </Button>
        </section>
      )}
      <ArchiveToastViewport />
      <WorkHeldNotice className="mx-6 mb-2" />
      <NeedsTray entries={needs} className="mx-6 mb-2" />
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

/**
 * The thread's messages, with a note where a reply's brain differs from the one before it, and at the
 * end when the next reply will think with another brain than the last one (ADR 017).
 */
function Transcript({
  transcript,
  hob,
  threadId,
  thread,
  focusMessageId,
  streaming,
  resume,
}: {
  transcript: ReadonlyArray<Message>;
  hob: Agent;
  threadId: ThreadId | undefined;
  thread: Thread | undefined;
  focusMessageId: string | undefined;
  streaming: boolean;
  resume: (message: Message) => ContinueReply | undefined;
}) {
  const switches = brainSwitches(transcript);
  const last = lastReplyBrain(transcript);
  const next = threadBrain(hob, thread);
  const changes = !streaming && last !== null && (last.runtime !== next.runtime || last.model !== next.model);
  // Tasks and Quests show under the request that started them, with only the moments that matter.
  const work = useWorkMoments(hob.id, threadId, transcript);
  return (
    <>
      {work.before}
      {transcript.map((message) => (
        <Fragment key={message.id}>
          {switches.has(message.id) && message.runtime !== null && (
            <BrainSwitchNote brain={{ runtime: message.runtime, model: message.model }} />
          )}
          <MessageRow message={message} hob={hob} focused={message.id === focusMessageId} resume={resume(message)}>
            <ReplyApprovals threadId={message.threadId} messageId={message.id} hob={hob} />
          </MessageRow>
          {work.after(message.id)}
        </Fragment>
      ))}
      {changes && <BrainSwitchNote brain={next} next />}
    </>
  );
}

/**
 * Continue on another brain: each other runtime that is ready offers it next to Continue. The thread
 * switches to that runtime's default model first, then the reply continues in place.
 */
function useContinueOn(
  hobId: AgentId,
  threadId: ThreadId,
  runtime: RuntimeKind,
  resume: ReturnType<typeof useContinueReply>,
) {
  const others = useOtherReadyRuntimes(runtime);
  const setBrain = useSetBrain(hobId, threadId);
  return {
    isPending: setBrain.isPending,
    isError: setBrain.isError,
    alternatives: (messageId: MessageId) =>
      others.map((other) => ({
        label: brainCopy.continueWith({ runtime: RUNTIME_NAMES[other] }),
        onContinue: () =>
          setBrain.mutate(
            { brain: { runtime: other, model: null, effort: null } },
            { onSuccess: () => resume.mutate(messageId) },
          ),
      })),
  };
}
