import { AgentId, ApprovalRequest, HubQuestion, HubQuestionId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, COPY, memberApproval, QUILL, question, stuckItem, THREAD, task } from "../../test/quests.ts";
import { shownEntry, trayEntries } from "./tray-entries.ts";

const pending = new ApprovalRequest({ ...memberApproval(COPY, QUILL), state: "pending" });
const decided = new ApprovalRequest({ ...memberApproval(COPY, QUILL), state: "approved" });
const asked = {
  question: question(COPY, ADA, "Monthly or yearly price?", { recipientId: null, chain: [ALDRIC] }),
  task: task(COPY, { ownerId: ADA }),
};

/** A question the hub itself asks (#976), about the chat `threadId` or about no chat. */
const fromHub = (id: string, threadId: ThreadId | null, state: "open" | "answered" = "open") =>
  new HubQuestion({
    id: HubQuestionId.make(id),
    key: id,
    chat: threadId === null ? null : { agentId: AgentId.make("aldric"), threadId },
    ask: { kind: "commit-identity", reason: "no-git-identity", github: null, unread: null },
    options: [],
    recommended: null,
    state,
    answer: null,
    picked: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    answeredAt: null,
    answeredByDeviceId: null,
    answeredVia: null,
    revision: 1,
  });

describe("trayEntries", () => {
  it("asks approvals first, then stuck work, then questions, leaving out what no longer waits", () => {
    const entries = trayEntries({ requests: [decided, pending], blockers: [stuckItem(THREAD)], questions: [asked] });
    expect(entries.map((entry) => entry.kind)).toEqual(["approval", "stuck", "question"]);
  });

  it("keeps only what is about the chat's thread", () => {
    const other = ThreadId.make("other");
    const entries = trayEntries({
      requests: [pending],
      blockers: [stuckItem(other)],
      questions: [asked],
      threadId: THREAD,
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["approval", "question"]);
  });
});

describe("trayEntries with the hub's own questions", () => {
  it("asks them after hobs' questions, in the chat they concern and on Home, while they are open", () => {
    const hubQuestions = [fromHub("here", THREAD), fromHub("nowhere", null), fromHub("done", THREAD, "answered")];
    const home = trayEntries({ requests: [], blockers: [], questions: [asked], hubQuestions });
    expect(home.map((entry) => entry.key)).toEqual([
      `question:${asked.question.id}`,
      "hub-question:here",
      "hub-question:nowhere",
    ]);
    const chat = trayEntries({ requests: [], blockers: [], questions: [], hubQuestions, threadId: THREAD });
    expect(chat.map((entry) => entry.key)).toEqual(["hub-question:here"]);
  });
});

describe("shownEntry", () => {
  const entries = trayEntries({ requests: [pending], blockers: [stuckItem(THREAD)], questions: [asked] });

  it("keeps showing the entry it showed while that one still waits", () => {
    expect(shownEntry(entries, entries[2]?.key, 0)?.index).toBe(2);
  });

  it("shows the one now in its place once it is decided, or the last one", () => {
    expect(shownEntry(entries, "gone", 1)?.entry.kind).toBe("stuck");
    expect(shownEntry(entries, "gone", 5)?.entry.kind).toBe("question");
  });

  it("shows nothing when nothing waits", () => {
    expect(shownEntry([], undefined, 0)).toBeUndefined();
  });
});
