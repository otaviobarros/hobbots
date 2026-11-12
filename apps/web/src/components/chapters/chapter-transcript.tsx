import { type Agent, ChapterId, ChapterStates, type Message, type Thread, ThreadLifecycle } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useReducer, useState } from "react";
import { chaptersQuery, useMergeChapter, useSplitChapter } from "../../api/chapters.ts";
import { CampSuggestions, chapterName } from "../camps/camp-suggestions.tsx";
import { type CampFrom, MakeCampSheet } from "../camps/make-camp-sheet.tsx";
import { messages as campCopy } from "../camps/messages.ts";
import { MessageMenu } from "../notes/message-menu.tsx";
import { ReadFailed } from "../web/read-failed.tsx";
import { ChapterDivider } from "./chapter-divider.tsx";
import {
  canRetry,
  chapterChangeError,
  MERGE_IDLE,
  mergeStep,
  SPLIT_CLOSED,
  type SplitChapterEvent,
  splitStep,
} from "./chapter-flows.ts";
import {
  type ChapterSection,
  chapterOf,
  chapterSections,
  foldStep,
  isFolded,
  shownWithoutOpening,
  showsChapters,
} from "./chapter-sections.ts";
import { messages } from "./messages.ts";
import { SplitChapterSheet } from "./split-chapter-sheet.tsx";

/**
 * The transcript under its chapters (ADR 037, #1382): a divider where each chapter starts, resting
 * chapters folded to their summary until you open them, Merge with previous and, in a chat, Make a
 * camp from this chapter on a divider's menu, and Pin and Split here on a message's. The hub's camp
 * suggestions follow the transcript. `renderMessage` draws one message, given its menu. A thread
 * that never changed topic shows no divider.
 */
export function ChapterTranscript({
  hob,
  thread,
  transcript,
  focusMessageId,
  focusPick = 0,
  renderMessage,
}: {
  hob: Agent;
  thread: Thread;
  transcript: ReadonlyArray<Message>;
  focusMessageId: string | undefined;
  /** Counts each pick of a search result, so picking the same one again opens its chapter again. */
  focusPick?: number;
  renderMessage: (message: Message, split: ReactNode) => ReactNode;
}) {
  const chapters = useQuery(chaptersQuery(thread.id));
  const sections = chapterSections(transcript, chapters.data);
  const [choices, dispatchFold] = useReducer(foldStep, new Map());
  const [split, dispatchSplit] = useReducer(splitStep, SPLIT_CLOSED);
  const [merge, dispatchMerge] = useReducer(mergeStep, MERGE_IDLE);
  // The chat chapter Make a camp opens with, which moves into the new camp.
  const [campFrom, setCampFrom] = useState<CampFrom>();
  const splitting = useSplitChapter(thread.id);
  const merging = useMergeChapter(thread.id);
  // An archived chat's chapters stay as they are, so it offers neither.
  const open = ThreadLifecycle.isOpen(thread);
  const focused = chapterOf(sections, focusMessageId);
  const shown = shownWithoutOpening(sections, focused);
  // Each pick of a search result opens its chapter, even one you folded, so it can scroll to it; a
  // pick of the same result again counts as a new one.
  const pick = `${focusMessageId}#${focusPick}`;
  const [revealed, setRevealed] = useState<string>();
  if (focused !== null && pick !== revealed) {
    setRevealed(pick);
    dispatchFold({ _tag: "Reveal", chapterId: focused });
  }

  const sendSplit = () => {
    // The reducer decides whether it sends and under which key; the request follows its answer.
    const event: SplitChapterEvent = { _tag: "Send", key: ChapterId.make(crypto.randomUUID()) };
    const next = splitStep(split, event);
    dispatchSplit(event);
    if (next.step !== "splitting") return;
    splitting.mutate(
      { key: next.key, messageId: next.messageId, title: next.title.trim() },
      {
        onSuccess: () => dispatchSplit({ _tag: "Close" }),
        onError: (error) => dispatchSplit({ _tag: "Failed", error: chapterChangeError(error) }),
      },
    );
  };
  const mergeInto = (chapterId: ChapterId) => {
    if (merge.step === "merging") return;
    dispatchMerge({ _tag: "Merge", chapterId });
    merging.mutate(chapterId, {
      onSuccess: () => dispatchMerge({ _tag: "Merged" }),
      onError: (error) => dispatchMerge({ _tag: "Failed", error: chapterChangeError(error) }),
    });
  };

  const dividers = showsChapters(sections);
  return (
    <>
      {/* Without its chapters the transcript still reads, undivided; this says why and reads again. */}
      {chapters.isError && <ReadFailed text={messages.unread} onRetry={() => void chapters.refetch()} />}
      {sections.map((section, index) => (
        <Section
          key={section.chapter?.id ?? "transcript"}
          section={section}
          first={index === 0}
          dividers={dividers}
          folded={section.chapter !== null && isFolded(section.chapter, choices, shown)}
          onToggle={(folded) =>
            section.chapter && dispatchFold({ _tag: "Toggle", chapterId: section.chapter.id, folded })
          }
          merge={
            open && section.chapter !== null && index > 0
              ? { pending: merge.step === "merging", onMerge: () => section.chapter && mergeInto(section.chapter.id) }
              : undefined
          }
          makeCamp={
            open && thread.kind === "chat" && section.chapter !== null && section.messages.length > 0
              ? () =>
                  section.chapter &&
                  setCampFrom({
                    chapter: section.chapter,
                    title: chapterName(section.chapter),
                    detail: campCopy.suggestion.messages({ count: section.messages.length }),
                  })
              : undefined
          }
          renderMessage={(message, at) =>
            renderMessage(
              message,
              open ? (
                <MessageMenu
                  threadId={thread.id}
                  messageId={message.id}
                  // A chapter's first message already starts it, so it splits nothing.
                  onSplit={
                    at > 0 && section.chapter !== null
                      ? () => dispatchSplit({ _tag: "Open", messageId: message.id })
                      : undefined
                  }
                />
              ) : undefined,
            )
          }
        />
      ))}
      {merge.step === "failed" && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-2 text-ui text-rose">
          {messages.errors[merge.error]()}
          {canRetry(merge.error) ? (
            <Button variant="outline" size="xs" onClick={() => mergeInto(merge.chapterId)}>
              {messages.split.tryAgain}
            </Button>
          ) : (
            <Button variant="outline" size="xs" onClick={() => dispatchMerge({ _tag: "Dismiss" })}>
              {messages.dismiss}
            </Button>
          )}
        </p>
      )}
      {split.step !== "closed" && (
        <SplitChapterSheet hob={hob} state={split} dispatch={dispatchSplit} onSend={sendSplit} />
      )}
      {open && <CampSuggestions hob={hob} thread={thread} chapters={chapters.data ?? []} onMake={setCampFrom} />}
      {campFrom && <MakeCampSheet hob={hob} from={campFrom} onClose={() => setCampFrom(undefined)} />}
    </>
  );
}

function Section({
  section,
  first,
  dividers,
  folded,
  onToggle,
  merge,
  makeCamp,
  renderMessage,
}: {
  section: ChapterSection;
  first: boolean;
  dividers: boolean;
  folded: boolean;
  /** Opens the chapter when `folded`, else folds it. */
  onToggle: (folded: boolean) => void;
  merge: { readonly pending: boolean; readonly onMerge: () => void } | undefined;
  makeCamp: (() => void) | undefined;
  renderMessage: (message: Message, at: number) => ReactNode;
}) {
  const { chapter } = section;
  // The thread's first chapter starts the transcript, so it needs no line until it has a title.
  const divider = chapter !== null && dividers && (!first || chapter.title !== null || !ChapterStates.isLive(chapter));
  return (
    <>
      {divider && (
        <ChapterDivider
          chapter={chapter}
          messageCount={section.messages.length}
          fold={ChapterStates.isLive(chapter) ? undefined : { folded, onToggle: () => onToggle(folded) }}
          merge={merge}
          makeCamp={makeCamp}
        />
      )}
      {!folded &&
        section.messages.map((message, at) => <Fragment key={message.id}>{renderMessage(message, at)}</Fragment>)}
    </>
  );
}
