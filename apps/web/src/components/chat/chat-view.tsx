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
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { appendDraft, moveDraft, restoreDraft, writeDraft } from "../../api/drafts.ts";
import { useHobSkills } from "../../api/hob-skills.ts";
import { useHobPresence, useThreadReplies } from "../../api/hub-status.ts";
import { useConnection } from "../../api/live.ts";
import { threadMemorySavesQuery } from "../../api/memory-saves.ts";
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
  useStopWaiting,
} from "../../api/queries.ts";
import { runtimeProblem } from "../../api/runtime-health.ts";
import { useReadThread } from "../../api/thread-reads.ts";
import { threadWebQuery } from "../../api/web.ts";
import { brainSwitches, lastReplyBrain } from "../../lib/brains.ts";
import { isQuietReply } from "../../lib/quiet-replies.ts";
import { minutesSince, type ReplyWait, replyWait } from "../../lib/reply-wait.ts";
import { sendErrorText } from "../../lib/send-error.ts";
import { ReplyApprovals } from "../approvals/reply-approvals.tsx";
import { ArchiveToastViewport } from "../archive/archive-toast.tsx";
import { WorkHeldNotice } from "../backup/work-held-notice.tsx";
import { messages as campCopy } from "../camps/messages.ts";
import { ChapterTranscript } from "../chapters/chapter-transcript.tsx";
import { ChatSearch } from "../chat-search/chat-search.tsx";
import { stateLabel, threadState } from "../hob-sprite/hob-sprite.tsx";
import { useNow } from "../inbox/use-now.ts";
import { replySaves } from "../memory-line/memory-line-model.ts";
import { MemorySavedLines, MemorySavesUnread } from "../memory-line/memory-saved-line.tsx";
import { messages } from "../messages.ts";
import { NeedsTray } from "../needs-tray/needs-tray.tsx";
import { useThreadNeeds } from "../needs-tray/use-thread-needs.ts";
import { BrainSwitchNote, useOtherReadyRuntimes } from "../providers/brain-picker.tsx";
import { PinNotes } from "../quest/pin-notes.tsx";
import { useWorkMoments } from "../quest/thread-work.tsx";
import type { Pins } from "../quest/use-work.ts";
import { ReconnectingCard } from "../shell/reconnecting.tsx";
import { skillPicking } from "../skill-line/skill-picker-model.ts";
import { SkillUsedLines } from "../skill-line/skill-used-line.tsx";
import { TrialNotice } from "../skills/trial-notice.tsx";
import { useSteerReceipts } from "../steer-receipt/steer-receipt.tsx";
import { repliesWeb, replyWebOf } from "../web/web-model.ts";
import { ChatHeader } from "./chat-header.tsx";
import { Composer } from "./composer.tsx";
import { EmptyThread } from "./empty-thread.tsx";
import { type ContinueReply, MessageRow, QueuedRow, useScrollToMessage, WaitingRow } from "./message-row.tsx";
import { TranscriptSkeleton } from "./transcript-skeleton.tsx";

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
const queuedCopy = messages.queued;
const composerCopy = messages.composer;

/** What the header says the hob does while its reply waits only on commands (#1056). */
const waitingWords = (wait: ReplyWait, now: Date): string => {
  const time = composerCopy.minutes({ count: minutesSince(wait.since, now) });
  const command = wait.commands.length === 1 ? wait.commands[0] : undefined;
  return command === undefined
    ? copy.waitingOnMany({ count: wait.commands.length, time })
    : copy.waitingOn({ command, time });
};
const brainCopy = messages.brain;

/** The middle of the chat workspace. Without a thread id it is the empty "fresh page". */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function ChatView({
  hobId,
  threadId,
  focusMessageId,
  pins,
  headerEnd,
  inView = true,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  focusMessageId?: string | undefined;
  /** The Quests pinned to every thread's header. */
  pins: Pins;
  /** What the header ends with, such as the fold button while the Quest room is open. */
  headerEnd?: ReactNode;
  /** Whether the chat is in view: not while it is folded away beside the Quest room. */
  inView?: boolean;
}) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  const thread = useQuery({
    ...threadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });
  const threadCount = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.length });
  // The hob's skills, which `/` in the composer picks one of (ADR 029).
  const skills = useHobSkills(hobId, hob.data?.configVersion);
  const messages = useQuery({ ...messagesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  // What waits on you in this chat shows in the tray above the composer.
  const needs = useThreadNeeds(threadId);
  const replies = useThreadReplies();
  const presence = useHobPresence();
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
  const stopWaiting = useStopWaiting(threadId ?? ("" as ThreadId));
  const pause = usePauseHob(hobId);
  const remove = useRemoveQueued(threadId ?? ("" as ThreadId));
  const sendNow = useSendNow(threadId ?? ("" as ThreadId));
  const resume = useContinueReply(threadId ?? ("" as ThreadId));
  const continueOn = useContinueOn(hobId, threadId ?? ("" as ThreadId), runtime, resume);

  const streaming = messages.data?.some((m) => isInProgress(m.status)) ?? false;
  // Stopping lasts from the hub recording the request until the runtime confirms the turn ended.
  const stopping =
    interrupt.isPending || stopWaiting.isPending || (messages.data?.some((m) => m.status === "stopping") ?? false);
  // What the reply waits on once its hob has answered, while only commands keep it open (#1056).
  const wait = replyWait(messages.data?.find((m) => isInProgress(m.status)));
  const waitCommand = wait?.commands.length === 1 ? (wait.commands[0] ?? null) : null;
  const waitsFor =
    wait === null
      ? null
      : waitCommand === null
        ? queuedCopy.waitsForCommands
        : queuedCopy.waitsForCommand({ command: waitCommand });
  const now = useNow(wait === null ? null : 60_000);
  // Queued messages wait above the composer, in the order they will start, until they join the transcript.
  const transcript = messages.data?.filter((m) => m.status !== "queued");
  const queued = messages.data?.filter((m) => m.status === "queued") ?? [];
  const lastContent = messages.data?.at(-1)?.content;
  // Reading the chat clears its unread dot on every device, while it is in view (ADR 027).
  useReadThread(hobId, thread.data, transcript, inView);
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
  // Each pick of a search result counts, so picking the same one again opens and scrolls to it again.
  const [picks, setPicks] = useState(0);
  const focusKey = focusMessageId === undefined ? undefined : `${focusMessageId}#${picks}`;
  // The search box under the header, opened from its magnifier, belongs to the thread it opened in.
  const [findingIn, setFindingIn] = useState<string>();
  const finding = threadId !== undefined && findingIn === threadId;
  const setFinding = (open: boolean) => setFindingIn(open ? threadId : undefined);
  const holding = focusKey !== undefined && released !== focusKey;
  const follow = () => setReleased(focusKey);

  useEffect(() => {
    if (lastContent !== undefined && !holding) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastContent, holding]);

  useScrollToMessage(messages.data, focusMessageId, picks);

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

  const state = threadState(presence[hobId], threadId ? replies[threadId] : undefined, current.status);
  const paused = current.status === "paused";
  // The composer names a camp; the hob's chat, and the empty chat before it, is just the hob's.
  const placeholder =
    thread.data?.kind === "camp"
      ? copy.placeholder({ name: current.name, title: thread.data.title })
      : campCopy.header.placeholder({ name: current.name });
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
    <main
      aria-label={copy.landmark}
      className="@container/chat flex min-w-chat-min flex-1 flex-col group-data-[room=open]/room:min-w-0"
    >
      {/* Back to the hob's chats, the tile, then the chat's title over who leads it and what they are doing (A2-02). */}
      <ChatHeader
        hob={current}
        hobId={hobId}
        threadId={threadId}
        thread={thread.data}
        state={state}
        doing={wait === null ? stateLabel[state] : waitingWords(wait, now)}
        pins={pins}
        finding={finding}
        onFinding={setFinding}
        headerEnd={headerEnd}
      />
      <ReconnectingCard className="mx-6 mt-2.5" />
      {threadId && finding && (
        <ChatSearch
          hob={current}
          threadId={threadId}
          transcript={messages.data ?? []}
          onClose={() => setFinding(false)}
          onPick={() => setPicks((count) => count + 1)}
        />
      )}
      {threadId && <PinNotes threadId={threadId} pins={pins} />}

      <section
        onScroll={(event) => {
          const view = event.currentTarget;
          if (holding && view.scrollHeight - view.scrollTop - view.clientHeight < 24) follow();
        }}
        ref={stayAtEnd}
        // A keyboard user scrolls the transcript once it has the focus (WCAG 2.1.1).
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area must take the focus to scroll from the keyboard
        tabIndex={0}
        aria-label={copy.transcript}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-[18px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring @max-[480px]/chat:px-4"
      >
        {/* The transcript, the tray and the composer share one centered column (A2-01). Long words
            and paths wrap inside it, so nothing in it is wider than the column (#874). */}
        <div className="mx-auto flex w-full max-w-measure flex-1 flex-col gap-3.5 wrap-anywhere">
          {threadId && messages.isPending && <TranscriptSkeleton onRetry={() => void messages.refetch()} />}
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
              focusPick={picks}
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
            <p role="alert" className="text-ui text-rose">
              {brainCopy.continueFailed({ name: current.name })}
            </p>
          )}
          {resume.isError && (
            <p role="alert" className="text-ui text-rose">
              {copy.continueFailed({ name: current.name, why: sendErrorText(resume.error, current) })}
            </p>
          )}
          {queueError && (
            <p role="alert" className="text-ui text-rose">
              {copy.queueGone}
            </p>
          )}
          {error && (
            <p role="alert" className="text-ui text-rose">
              {sendErrorText(error, current)}
            </p>
          )}
          {stopWaiting.isError && wait !== null && (
            <p role="alert" className="text-ui text-rose">
              {copy.stopWaitingFailed({ name: current.name, command: waitCommand ?? composerCopy.theCommands })}
            </p>
          )}
          {pause.isError && (
            <p role="alert" className="text-ui text-rose">
              {copy.wakeFailed(current)}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </section>

      {/* Folded away beside the room, the chat leaves its toasts to the room's own place. */}
      {inView && <ArchiveToastViewport />}
      <div className="flex-none px-6 pt-2 pb-5 @max-[480px]/chat:px-3 @max-[480px]/chat:pb-3">
        <div className="mx-auto flex w-full max-w-measure flex-col gap-2.5">
          {brainProblem !== null && (
            <section
              aria-label={copy.brainUnavailable}
              className="flex flex-wrap items-center gap-2.5 rounded-card bg-card px-3.5 py-2.5 text-ui"
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
          <WorkHeldNotice />
          <TrialNotice thread={thread.data} />
          <NeedsTray entries={needs} />
          {queued.length > 0 && (
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
              {queued.map((message) => (
                <QueuedRow
                  key={message.id}
                  message={message}
                  hob={current}
                  replying={streaming}
                  waitsFor={waitsFor}
                  pending={remove.isPending || sendNow.isPending}
                  onRemove={() => remove.mutate(message.id)}
                  onSendNow={() => sendNow.mutate(message.id)}
                />
              ))}
            </div>
          )}
          <Composer
            name={current.name}
            placeholder={placeholder}
            place={place}
            lastSent={lastSent}
            busy={streaming}
            stopping={stopping}
            sending={start.isPending || send.isPending}
            onSend={sendDraft}
            onStop={() => interrupt.mutate()}
            wait={wait}
            onStopWaiting={() => stopWaiting.mutate()}
            skills={skillPicking(skills, current.name, thread.data?.skillTrial)}
            paused={
              paused
                ? { name: current.name, waking: pause.isPending, onWake: wake, canQueue: threadId !== undefined }
                : undefined
            }
          />
        </div>
      </div>
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
  focusPick,
  streaming,
  resume,
}: {
  transcript: ReadonlyArray<Message>;
  hob: Agent;
  threadId: ThreadId | undefined;
  thread: Thread | undefined;
  focusMessageId: string | undefined;
  /** How many times a search result was picked here, so each pick opens its chapter again. */
  focusPick: number;
  streaming: boolean;
  resume: (message: Message) => ContinueReply | undefined;
}) {
  const switches = brainSwitches(transcript);
  const last = lastReplyBrain(transcript);
  const next = threadBrain(hob, thread);
  const changes = !streaming && last !== null && (last.runtime !== next.runtime || last.model !== next.model);
  // Tasks and Quests show under the request that started them, with only the moments that matter.
  const work = useWorkMoments(hob.id, threadId, transcript);
  // Under a message you sent while work ran, where it went next (ADR 027).
  const receipts = useSteerReceipts(hob.id, threadId, transcript);
  // Under a reply, what it saved to the hob's memory (ADR 028).
  const saves = useQuery({ ...threadMemorySavesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  // A reply's searches and pages, as step lines and sources (ADR 036).
  const webUsage = useQuery({ ...threadWebQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  const web = repliesWeb(webUsage.data, transcript);
  // The message before each, which tells a quiet reply; chapters lay the transcript out in pieces.
  const previous = new Map(transcript.map((message, index) => [message.id, transcript[index - 1]]));
  const row = (message: Message, split: ReactNode) => (
    <>
      {switches.has(message.id) && message.runtime !== null && (
        <BrainSwitchNote brain={{ runtime: message.runtime, model: message.model }} />
      )}
      {/* A lead that acted on arrived work and wrote nothing leaves no row; its work still shows. */}
      {!isQuietReply(message, previous.get(message.id)) && (
        <MessageRow
          message={message}
          hob={hob}
          focused={message.id === focusMessageId}
          resume={resume(message)}
          web={{ reply: replyWebOf(web, message.id), usage: webUsage.data }}
          actions={split}
          after={
            <>
              <SkillUsedLines message={message} hob={hob} />
              <MemorySavedLines saves={replySaves(saves.data, message.id)} hob={hob} />
            </>
          }
        >
          <ReplyApprovals threadId={message.threadId} messageId={message.id} hob={hob} />
        </MessageRow>
      )}
      {receipts.of(message)}
      {work.after(message.id)}
    </>
  );
  return (
    <>
      {work.before}
      {/* Divided by its chapters once the thread exists (ADR 037); the empty chat has none yet. */}
      {thread === undefined ? (
        transcript.map((message) => <Fragment key={message.id}>{row(message, undefined)}</Fragment>)
      ) : (
        <ChapterTranscript
          hob={hob}
          thread={thread}
          transcript={transcript}
          focusMessageId={focusMessageId}
          focusPick={focusPick}
          renderMessage={row}
        />
      )}
      {saves.isError && saves.data === undefined && (
        <MemorySavesUnread name={hob.name} retry={() => void saves.refetch()} />
      )}
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
