import { describe, expect, it } from "vitest";
import type { QuestInProgress } from "../../lib/quest-work.ts";
import { chatGroups, chatMatches, cleanTitle, groupOf, questsByThread, waitingByThread } from "./chats-model.ts";

// A Wednesday, so Earlier this week reaches back to the Thursday before.
const now = new Date(2026, 10, 4, 15, 0);
const at = (days: number, hour = 10) => new Date(2026, 10, 4 - days, hour).toISOString();
const chat = (id: string, updatedAt: string, pinnedAt: string | null = null) => ({
  id,
  title: id,
  updatedAt,
  pinnedAt,
});

describe("groupOf", () => {
  it("puts a pinned chat under Pinned, then sorts by the day of its last activity", () => {
    expect(groupOf(chat("a", at(40), at(1)), now)).toBe("pinned");
    expect(groupOf(chat("a", at(0, 0)), now)).toBe("today");
    expect(groupOf(chat("a", at(1, 23)), now)).toBe("week");
    expect(groupOf(chat("a", at(6)), now)).toBe("week");
    expect(groupOf(chat("a", at(7)), now)).toBe("older");
  });
});

describe("chatGroups", () => {
  it("leaves out empty groups and lists each newest first, pinned by when they were pinned", () => {
    const groups = chatGroups(
      [
        chat("old", at(30)),
        chat("pin-early", at(2), at(20)),
        chat("today", at(0)),
        chat("pin-late", at(40), at(1)),
        chat("older-newest", at(9)),
      ],
      now,
    );
    expect(groups.map(({ group, threads }) => [group, threads.map((t) => t.id)])).toEqual([
      ["pinned", ["pin-late", "pin-early"]],
      ["today", ["today"]],
      ["older", ["older-newest", "old"]],
    ]);
  });
});

describe("chatMatches", () => {
  const threads = [chat("Spring launch plan", at(3)), chat("Weekly report", at(1)), chat("Lisbon trip", at(0))];

  it("finds chats by their title here and by their messages from the hub, newest first, with marks", () => {
    const snippet = [
      { text: "codes used for the ", match: false },
      { text: "discount", match: true },
    ];
    const hits = [{ thread: { id: "Weekly report" }, matches: [{ snippet }] }];
    const matches = chatMatches(threads as never, hits as never, "spring discount");
    expect(matches.map((m) => m.thread.id)).toEqual(["Weekly report", "Spring launch plan"]);
    expect(matches[0]?.snippet).toEqual(snippet);
    expect(matches[1]?.title).toEqual([
      { text: "Spring", match: true },
      { text: " launch plan", match: false },
    ]);
    expect(matches[1]?.snippet).toBeNull();
  });

  it("matches nothing for a search without words", () => {
    expect(chatMatches(threads as never, [], " … ")).toEqual([]);
  });
});

describe("waitingByThread", () => {
  it("counts only the approvals still waiting, per chat", () => {
    const counts = waitingByThread([
      { threadId: "a", state: "pending" },
      { threadId: "a", state: "pending" },
      { threadId: "b", state: "approved" },
    ] as never);
    expect([...counts]).toEqual([["a", 2]]);
  });
});

describe("questsByThread", () => {
  const quest = (id: string, goal: string, threadId: string | null) =>
    ({ quest: { id, goal, threadId }, members: [] }) as unknown as QuestInProgress;
  const summary = (questId: string, done: number, working: number) =>
    [questId, { questId, tones: { needs: 0, working, waiting: 0, done, problem: 0, idle: 0 }, needsYou: 0 }] as never;
  it("gives each chat a chip per Quest it follows, with how many of its Tasks the hub counts done", () => {
    const chips = questsByThread(
      [
        quest("q1", "Spring launch", "th1"),
        quest("q2", "Keywords", "th1"),
        quest("q3", "Nowhere", null),
        quest("q4", "Not read yet", "th1"),
      ],
      new Map([summary("q1", 1, 2), summary("q2", 1, 0), summary("q3", 0, 1)]),
    );
    expect(chips.get("th1")).toEqual(["Spring launch · 1 of 3", "Keywords · 1 of 1"]);
    expect(chips.size).toBe(1);
  });
});

describe("cleanTitle", () => {
  it("keeps one trimmed line of at most 60 characters, and refuses an empty one", () => {
    expect(cleanTitle("  Kettle\n repair  ")).toBe("Kettle repair");
    expect(cleanTitle("x".repeat(70))).toHaveLength(60);
    expect(cleanTitle("   ")).toBeNull();
  });
});
