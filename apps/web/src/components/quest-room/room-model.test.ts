import { TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { BUILD, blackFriday, COPY } from "../../test/quests.ts";
import { litTask } from "./room-model.ts";
import { hasUnread, nextSeen, parseFold } from "./use-chat-fold.ts";

describe("the lit lane", () => {
  it("lights the lane the address names, else the Task a link named, else none", () => {
    const quest = blackFriday();
    const [top, copy] = quest.tasks;
    if (top === undefined || copy === undefined) throw new Error("The tree has its Tasks");
    expect(litTask(quest, top, BUILD)).toBe(BUILD);
    expect(litTask(quest, copy, undefined)).toBe(COPY);
    expect(litTask(quest, top, undefined)).toBeUndefined();
    // A lane from another Quest lights nothing here.
    expect(litTask(quest, top, TaskId.make("elsewhere"))).toBeUndefined();
  });
});

describe("parseFold", () => {
  it("reads the fold this device kept, and the open column for anything else", () => {
    expect(parseFold({ v: 1, folded: true })).toBe(true);
    expect(parseFold({ v: 1, folded: false })).toBe(false);
    expect(parseFold(true)).toBe(false);
    expect(parseFold({ v: 2, folded: true })).toBe(false);
    expect(parseFold(null)).toBe(false);
  });
});

describe("the folded chat's unread mark", () => {
  it("marks a reply that came while folded, and clears once the chat is back in view", () => {
    const read = nextSeen(undefined, "a", 10, false);
    expect(hasUnread(nextSeen(read, "a", 11, true), "a", 11)).toBe(true);
    const back = nextSeen(nextSeen(read, "a", 11, true), "a", 11, false);
    expect(hasUnread(back, "a", 11)).toBe(false);
  });

  it("starts another thread from its own count, so its first new reply is marked", () => {
    const longA = nextSeen(undefined, "a", 10, false);
    const openB = nextSeen(longA, "b", 2, true);
    expect(openB).toEqual({ thread: "b", count: 2 });
    expect(hasUnread(openB, "b", 2)).toBe(false);
    expect(hasUnread(nextSeen(openB, "b", 3, true), "b", 3)).toBe(true);
    // A thread longer than the last one's count is not marked just for being longer.
    expect(hasUnread(nextSeen(openB, "c", 40, true), "c", 40)).toBe(false);
  });
});
