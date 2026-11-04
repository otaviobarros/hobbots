import { ApprovalRequest, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, COPY, memberApproval, QUILL, question, stuckItem, THREAD, task } from "../../test/quests.ts";
import { shownEntry, trayEntries } from "./tray-entries.ts";

const pending = new ApprovalRequest({ ...memberApproval(COPY, QUILL), state: "pending" });
const decided = new ApprovalRequest({ ...memberApproval(COPY, QUILL), state: "approved" });
const asked = {
  question: question(COPY, ADA, "Monthly or yearly price?", { recipientId: null, chain: [ALDRIC] }),
  task: task(COPY, { ownerId: ADA }),
};

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
