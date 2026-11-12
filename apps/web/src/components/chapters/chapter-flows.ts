import type { ChapterChangeRefusal } from "@hobbots/api";
import { CHAPTER_TITLE_MAX, type ChapterId, type MessageId } from "@hobbots/domain";
import { Schema } from "effect";
import { ApiError } from "../../api/client.ts";

// Split here and Merge with previous (ADR 037, #1382), each one reducer over a union of its steps
// (STD-REACT-029). A split names its new chapter and is sent under a key, so trying a lost answer
// again splits once; a merge runs at once. A failure says why and can be tried again.

/** Why a split or a merge changed nothing: the hub's refusal, or no answer. */
export type ChapterChangeError = ChapterChangeRefusal | "unreachable";

const REFUSALS: ReadonlySet<string> = new Set<ChapterChangeRefusal>([
  "thread-closed",
  "empty-title",
  "live-chapter-empty",
  "message-not-found",
  "chapter-start",
  "first-chapter",
  "moved",
  "chapter-not-found",
]);

/** The failure a refused or lost request shows. */
export const chapterChangeError = (error: unknown): ChapterChangeError => {
  if (!(error instanceof ApiError) || error.tag !== "ChapterChangeRefused") return "unreachable";
  const reason = String(error.fields.reason);
  return REFUSALS.has(reason) ? (reason as ChapterChangeRefusal) : "unreachable";
};

/** Why the new chapter's title cannot be sent yet. */
export type TitleProblem = "title-missing" | "title-long";

// The rule the hub checks, stated once here for the sheet (STD-REACT-017).
const Title = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(CHAPTER_TITLE_MAX));

/** What is wrong with a title, read as the hub reads it: trimmed. */
export const titleProblem = (title: string): TitleProblem | null => {
  const trimmed = title.trim();
  const fits: boolean = Schema.is(Title)(trimmed);
  if (fits) return null;
  return trimmed.length === 0 ? "title-missing" : "title-long";
};

export type SplitChapter =
  | { readonly step: "closed" }
  /** `shown`: whether the title's problem shows, once a send found it. */
  | { readonly step: "naming"; readonly messageId: MessageId; readonly title: string; readonly shown: boolean }
  | { readonly step: "splitting"; readonly messageId: MessageId; readonly title: string; readonly key: ChapterId }
  | {
      readonly step: "failed";
      readonly messageId: MessageId;
      readonly title: string;
      readonly key: ChapterId;
      readonly error: ChapterChangeError;
    };

export type SplitChapterEvent =
  | { readonly _tag: "Open"; readonly messageId: MessageId }
  | { readonly _tag: "Edit"; readonly title: string }
  /** `key` is a new key, used unless a failed split is tried again unchanged. */
  | { readonly _tag: "Send"; readonly key: ChapterId }
  | { readonly _tag: "Failed"; readonly error: ChapterChangeError }
  /** The split went through, or you closed the sheet. */
  | { readonly _tag: "Close" };

export const SPLIT_CLOSED: SplitChapter = { step: "closed" };

export const splitStep = (state: SplitChapter, event: SplitChapterEvent): SplitChapter => {
  switch (event._tag) {
    case "Open":
      return state.step === "closed" ? { step: "naming", messageId: event.messageId, title: "", shown: false } : state;
    case "Edit":
      // Nothing changes while the split is sent. An edit after a failure asks under a new key.
      if (state.step === "closed" || state.step === "splitting") return state;
      return { step: "naming", messageId: state.messageId, title: event.title, shown: false };
    case "Send": {
      if (state.step === "closed" || state.step === "splitting") return state;
      if (titleProblem(state.title) !== null) return { ...state, step: "naming", shown: true };
      // The same request again: had the first gone through before its answer was lost, the hub
      // answers it as it did, instead of splitting twice.
      const key = state.step === "failed" ? state.key : event.key;
      return { step: "splitting", messageId: state.messageId, title: state.title, key };
    }
    case "Failed":
      return state.step === "splitting" ? { ...state, step: "failed", error: event.error } : state;
    case "Close":
      return SPLIT_CLOSED;
  }
};

export type MergeChapter =
  | { readonly step: "idle" }
  | { readonly step: "merging"; readonly chapterId: ChapterId }
  | { readonly step: "failed"; readonly chapterId: ChapterId; readonly error: ChapterChangeError };

export type MergeChapterEvent =
  | { readonly _tag: "Merge"; readonly chapterId: ChapterId }
  | { readonly _tag: "Merged" }
  | { readonly _tag: "Failed"; readonly error: ChapterChangeError }
  | { readonly _tag: "Dismiss" };

export const MERGE_IDLE: MergeChapter = { step: "idle" };

export const mergeStep = (state: MergeChapter, event: MergeChapterEvent): MergeChapter => {
  switch (event._tag) {
    case "Merge":
      // One merge at a time: the next one waits until the hub answered this one.
      return state.step === "merging" ? state : { step: "merging", chapterId: event.chapterId };
    case "Merged":
      return state.step === "merging" ? MERGE_IDLE : state;
    case "Failed":
      return state.step === "merging" ? { ...state, step: "failed", error: event.error } : state;
    case "Dismiss":
      return state.step === "failed" ? MERGE_IDLE : state;
  }
};

/** Whether trying again can help: a refusal stands until what caused it changes, but a lost answer may not. */
export const canRetry = (error: ChapterChangeError) => error === "unreachable";
