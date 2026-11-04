import type { Agent, AgentId, HistoryEvent } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { dayLabel, historyRow } from "./history-model.ts";

const aldric = { id: "aldric", name: "Aldric" } as unknown as Agent;
const ada = { id: "ada", name: "Ada" } as unknown as Agent;
const hobs = new Map<AgentId, Agent>([
  [aldric.id, aldric],
  [ada.id, ada],
]);
const quest = { id: "q1", goal: "Spring launch" };

const base = (agentId: string, rest: Record<string, unknown>) =>
  ({
    id: `${rest._tag}:1`,
    at: "2026-11-04T12:00:00.000Z",
    agentId,
    taskId: "t1",
    threadId: "th1",
    threadAgentId: "aldric",
    attemptId: null,
    quest: null,
    ...rest,
  }) as unknown as HistoryEvent;

const row = (event: HistoryEvent) => historyRow(event, aldric, hobs);

describe("historyRow", () => {
  it("marks finished work done and opens its Workbench on the Attempt that did it", () => {
    const done = row(
      base("aldric", {
        _tag: "TaskEnded",
        brief: "Weekly report",
        state: "completed",
        summary: "Sent the weekly report",
        attempts: 1,
        attemptId: "a1",
      }),
    );
    expect(done).toMatchObject({ mark: "done", glyph: "✓", line: "Sent the weekly report", who: null, waiting: false });
    expect(done.bench).toEqual({ hobId: "aldric", threadId: "th1", taskId: "t1", attemptId: "a1" });
    expect(done.chat).toEqual({ hobId: "aldric", threadId: "th1" });
  });

  it("says how many tries a failed Task took", () => {
    const failed = row(
      base("aldric", { _tag: "TaskEnded", brief: "Send it", state: "failed", summary: null, attempts: 3 }),
    );
    expect(failed).toMatchObject({ mark: "fail", line: "Stopped “Send it” after 3 tries" });
  });

  it("names the party hob that did the work and its Quest, and opens the chat of the hob you asked", () => {
    const picked = row(base("ada", { _tag: "TaskPickedUp", brief: "Build the page", leadId: "aldric", quest }));
    expect(picked).toMatchObject({
      mark: "quest",
      line: "Picked up “Build the page” from Aldric",
      who: { name: "Ada", hob: ada },
      quest: "Spring launch",
    });
    // The Quest's thread is Aldric's chat, where you asked for the work, never Ada's.
    expect(picked.chat).toEqual({ hobId: "aldric", threadId: "th1" });
  });

  it("asks you to Review an approval that waits, and credits you with one you decided", () => {
    const approval = { _tag: "Approval", approvalId: "ap1", operation: "exec", label: "git push", action: "git push" };
    const waiting = row(base("aldric", { ...approval, state: "pending", lifetime: null, denyReason: null }));
    expect(waiting).toMatchObject({ mark: "ask", glyph: "!", waiting: true, review: "ap1" });
    const allowed = row(base("aldric", { ...approval, state: "approved", lifetime: "always", denyReason: null }));
    expect(allowed).toMatchObject({ mark: "you", line: "You allowed “git push”, always", who: { name: "You" } });
    expect(allowed.review).toBeNull();
    const denied = row(base("aldric", { ...approval, state: "denied", lifetime: null, denyReason: "No" }));
    expect(denied).toMatchObject({ mark: "you", glyph: "✕", line: "You denied “git push”" });
  });

  it("sends an open question to its Inbox entry", () => {
    const open = row(base("aldric", { _tag: "Question", questionId: "qq", text: "Which list?", answer: null }));
    expect(open).toMatchObject({ mark: "ask", review: "question:qq", line: "Asks you: Which list?" });
    const answered = row(base("aldric", { _tag: "Question", questionId: "qq", text: "Which list?", answer: "Team" }));
    expect(answered).toMatchObject({ mark: "you", review: null, line: "You answered: Team" });
  });

  it("names the party a Quest started with, and stars a Quest that finished", () => {
    const started = row(base("aldric", { _tag: "QuestStarted", quest, party: ["aldric", "ada"] }));
    expect(started.line).toBe("Started Spring launch with Ada");
    const ended = row(base("aldric", { _tag: "QuestEnded", quest, state: "completed" }));
    expect(ended).toMatchObject({ mark: "quest", glyph: "★", line: "Spring launch finished" });
  });

  it("leaves out Chat and Workbench when the event has no thread", () => {
    const asked = row(base("aldric", { _tag: "TaskAsked", brief: "Plan it", threadId: null }));
    expect(asked).toMatchObject({ chat: null, bench: null, who: { name: "You" } });
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 10, 4, 15, 0);
  it("says Today and Yesterday, then the weekday and date", () => {
    expect(dayLabel("2026-11-04", now, "en-US")).toBe("Today");
    expect(dayLabel("2026-11-03", now, "en-US")).toBe("Yesterday");
    expect(dayLabel("2026-11-01", now, "en-US")).toBe("Sun, Nov 1");
    expect(dayLabel("2025-12-30", now, "en-US")).toBe("Tue, Dec 30, 2025");
  });
});
