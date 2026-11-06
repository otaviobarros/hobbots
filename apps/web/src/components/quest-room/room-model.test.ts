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
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `r${from + i}`);

  it("marks a reply that came while folded, and clears once the chat is back in view", () => {
    const read = nextSeen(undefined, "a", ids(10), false);
    expect(hasUnread(nextSeen(read, "a", ids(11), true), "a", ids(11))).toBe(true);
    const back = nextSeen(nextSeen(read, "a", ids(11), true), "a", ids(11), false);
    expect(hasUnread(back, "a", ids(11))).toBe(false);
  });

  it("starts another thread from its own replies, so its first new reply is marked", () => {
    const longA = nextSeen(undefined, "a", ids(10), false);
    const openB = nextSeen(longA, "b", ids(2), true);
    expect(openB).toEqual({ thread: "b", ids: new Set(ids(2)) });
    expect(hasUnread(openB, "b", ids(2))).toBe(false);
    expect(hasUnread(nextSeen(openB, "b", ids(3), true), "b", ids(3))).toBe(true);
    // A thread with more replies than the last one is not marked just for being longer.
    expect(hasUnread(nextSeen(openB, "c", ids(40), true), "c", ids(40))).toBe(false);
  });

  it("marks the next reply after one folded away as routine progress while you were not looking (#1006)", () => {
    // You fold the chat while r3 streams; it completes quiet and leaves the chat's replies.
    const streaming = nextSeen(undefined, "a", ids(3), false);
    const folded = nextSeen(streaming, "a", ids(2), true);
    expect(hasUnread(folded, "a", ids(2))).toBe(false);
    // The lead's question, r4, comes next: the chat holds as many replies as when you folded it.
    const question = [...ids(2), "r4"];
    expect(hasUnread(nextSeen(folded, "a", question, true), "a", question)).toBe(true);
  });
});
