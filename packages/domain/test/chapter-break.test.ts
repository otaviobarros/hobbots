import { describe, expect, it } from "vitest";
import {
  AFTER_A_BREAK,
  breakChapterId,
  breakTitle,
  CHAPTER_BREAK_IDLE_MINUTES,
  idleBreak,
  lastIdleBreak,
  MessageId,
  type TopicLine,
} from "../src/index.ts";

// Issue #1557 (ADR 039, Chapters run on their own): under No AI, a person's message after the chat sat
// idle starts its next chapter, titled by its first words.

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14) + minute * 60_000).toISOString();
const line = (id: string, minute: number, person = true): TopicLine => ({
  id: MessageId.make(id),
  person,
  at: at(minute),
});

describe("the idle rule", () => {
  // covers ADR 039 (Chapters run on their own), #1557
  it("[TC-CH-1557-02] breaks at the idle time and not a minute before", () => {
    expect(idleBreak(at(0), at(CHAPTER_BREAK_IDLE_MINUTES))).toBe(true);
    expect(idleBreak(at(0), at(CHAPTER_BREAK_IDLE_MINUTES - 1))).toBe(false);
  });

  // covers ADR 039 (Chapters run on their own), #1557
  it("[TC-CH-1557-03] finds where a chapter's last topic starts: a person's message after its last idle gap", () => {
    const gap = CHAPTER_BREAK_IDLE_MINUTES;
    expect(lastIdleBreak([])).toBeNull();
    expect(lastIdleBreak([line("a", 0), line("b", 1, false), line("c", 2)])).toBeNull();
    // A chapter's first message is never a break.
    expect(lastIdleBreak([line("a", gap * 4)])).toBeNull();
    expect(
      lastIdleBreak([
        line("a", 0),
        line("b", 1, false),
        line("c", gap + 1),
        line("d", gap + 2, false),
        line("e", gap * 3),
      ]),
    ).toBe(4);
    // A hob's reply after a gap, as from a Quest, starts no topic.
    expect(lastIdleBreak([line("a", 0), line("b", gap, false)])).toBeNull();
  });

  it("titles the new chapter by its message's first words, and names a chapter started at one with no text", () => {
    expect(breakTitle("  Back to the garden.\nWhat now?")).toBe("Back to the garden. What now?");
    expect(breakTitle("   ")).toBe(AFTER_A_BREAK);
    expect(breakChapterId(MessageId.make("m1"))).toBe("m1:break");
  });
});
