import { chapterTitle } from "./chapter.ts";
import { ChapterId, type MessageId } from "./ids.ts";

/**
 * Chapters that start on their own (ADR 039, #1557). The hub starts a chat's next chapter when a
 * person's message opens a new topic, so each topic can become a camp by itself. The hub's brain
 * judges it; under No AI, or when the brain's answer does not decode, the idle rule here does: a
 * message after the chat sat idle for `CHAPTER_BREAK_IDLE_MINUTES` starts a new chapter.
 */

/** How long a chat sits idle before a person's next message starts a new chapter by the rule. */
export const CHAPTER_BREAK_IDLE_MINUTES = 180;

/** How sure the hub's brain must be, from 0 to 1, that a message opens a new topic. */
export const CHAPTER_BREAK_CONFIDENCE = 0.7;

/** What a chapter started at a message by the hub is titled when nothing better names it. */
export const AFTER_A_BREAK = "After a break";

/** The id of the chapter the hub starts at `messageId`: one per message, so a repeated start makes none twice. */
export const breakChapterId = (messageId: MessageId): ChapterId => ChapterId.make(`${messageId}:break`);

/** Whether a message written at `at` follows one written at `before` after the idle time or longer. */
export const idleBreak = (before: string, at: string): boolean =>
  Date.parse(at) - Date.parse(before) >= CHAPTER_BREAK_IDLE_MINUTES * 60_000;

/** A chapter's title from the message that starts it, as the rule names it: its first words. */
export const breakTitle = (content: string): string => chapterTitle(content) ?? AFTER_A_BREAK;

/** One message of a chapter, as the topic rule reads it. */
export interface TopicLine {
  readonly id: MessageId;
  /** Whether a person wrote it, rather than a hob. */
  readonly person: boolean;
  readonly at: string;
}

/**
 * Where a chapter's last topic starts by the idle rule: the index of the last person's message that
 * followed an idle gap, never the chapter's first; null when the chapter holds no such gap.
 */
export const lastIdleBreak = (lines: ReadonlyArray<TopicLine>): number | null => {
  for (let index = lines.length - 1; index > 0; index--) {
    const line = lines[index] as TopicLine;
    if (line.person && idleBreak((lines[index - 1] as TopicLine).at, line.at)) return index;
  }
  return null;
};
