import { Chapter, ChapterId, Message, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  chapterFocus,
  chapterOf,
  chapterSections,
  isFolded,
  shownWithoutOpening,
  showsChapters,
} from "./chapter-sections.ts";

const threadId = ThreadId.make("t1");
const at = "2026-11-12T10:00:00.000Z";

const chapter = (id: string, number: number, state: Chapter["state"], title: string | null = null) =>
  new Chapter({
    id: ChapterId.make(id),
    threadId,
    number,
    title,
    summary: null,
    state,
    startedAt: at,
    endedAt: state === "live" ? null : at,
    movedTo: null,
  });

const message = (id: string, chapterId: string | null) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "user",
    content: id,
    status: "complete",
    error: null,
    configVersion: 1,
    createdAt: at,
    chapterId: chapterId === null ? null : ChapterId.make(chapterId),
  });

const ids = (sections: ReturnType<typeof chapterSections>) =>
  sections.map((section) => [section.chapter?.id ?? null, section.messages.map((m) => m.id)]);

describe("chapterSections", () => {
  const one = chapter("c1", 1, "resting");
  const two = chapter("c2", 2, "resting", "The garden");
  const three = chapter("c3", 3, "live", "The orchard");

  it("lays the messages under their chapters, in order, and the live chapter shows even empty", () => {
    const transcript = [message("a", "c1"), message("b", "c1"), message("c", "c2")];
    expect(ids(chapterSections(transcript, [one, two, three]))).toEqual([
      ["c1", ["a", "b"]],
      ["c2", ["c"]],
      ["c3", []],
    ]);
  });

  it("keeps the transcript whole before the chapters are read", () => {
    expect(ids(chapterSections([message("a", "c1")], undefined))).toEqual([[null, ["a"]]]);
  });

  it("puts a message of a chapter it does not hold yet in the live one, and leaves out moved and empty ones", () => {
    const moved = new Chapter({ ...chapter("c2", 2, "moved"), movedTo: ThreadId.make("camp") });
    const transcript = [message("a", "c1"), message("b", "c9"), message("c", null)];
    const chapters = [one, moved, chapter("c4", 3, "resting"), chapter("c5", 4, "live")];
    expect(ids(chapterSections(transcript, chapters))).toEqual([
      ["c1", ["a"]],
      ["c5", ["b", "c"]],
    ]);
  });

  it("shows dividers once there is a second chapter, or the only one has a title", () => {
    const live = chapter("c1", 1, "live");
    expect(showsChapters(chapterSections([message("a", "c1")], [live]))).toBe(false);
    expect(showsChapters(chapterSections([message("a", "c1")], [chapter("c1", 1, "live", "Taxes")]))).toBe(true);
    expect(showsChapters(chapterSections([message("a", "c1")], [one, three]))).toBe(true);
  });

  it("folds resting chapters until opened, never the live one or one that shows anyway", () => {
    expect(isFolded(one, new Map(), new Set())).toBe(true);
    expect(isFolded(one, new Map([[one.id, "open"]]), new Set())).toBe(false);
    expect(isFolded(one, new Map(), new Set([one.id]))).toBe(false);
    // Folding one that shows anyway keeps it folded.
    expect(isFolded(one, new Map([[one.id, "folded"]]), new Set([one.id]))).toBe(true);
    expect(isFolded(three, new Map([[three.id, "folded"]]), new Set())).toBe(false);
    const sections = chapterSections([message("a", "c1"), message("b", "c3")], [one, three]);
    expect(chapterOf(sections, "a")).toBe(one.id);
    expect(chapterOf(sections, "zzz")).toBeNull();
    expect(chapterOf(sections, undefined)).toBeNull();
  });

  it("shows the chapter a search opened, and the one just ended while the live one is empty", () => {
    const busy = chapterSections([message("a", "c1"), message("b", "c3")], [one, three]);
    expect([...shownWithoutOpening(busy, null)]).toEqual([]);
    expect([...shownWithoutOpening(busy, one.id)]).toEqual([one.id]);
    const ended = chapterSections([message("a", "c1"), message("c", "c2")], [one, two, three]);
    expect([...shownWithoutOpening(ended, null)]).toEqual([two.id]);
  });

  it("tells the Focus chip the live chapter's title and how many rest", () => {
    expect(chapterFocus([one, two, three])).toEqual({ title: "The orchard", resting: 2 });
    expect(chapterFocus(undefined)).toEqual({ title: null, resting: 0 });
  });
});
