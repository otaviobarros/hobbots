import { ApprovalId, ApprovalRequest, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { COPY, memberApproval, QUILL, THREAD } from "../../test/quests.ts";
import { approvalEntry } from "./inbox-entries.ts";
import { inScope, inSearch, waitingIn } from "./inbox-scope.ts";

const CAMP = ThreadId.make("camp-launch");
const inChat = approvalEntry(new ApprovalRequest({ ...memberApproval(COPY, QUILL), state: "pending" }));
const inCamp = approvalEntry(
  new ApprovalRequest({
    ...memberApproval(COPY, QUILL),
    id: ApprovalId.make("in-camp"),
    threadId: CAMP,
    state: "pending",
  }),
);
const device = {
  kind: "device",
  key: "device:d1",
  device: { deviceId: "d1", name: "Phone", code: "1234", requestedAt: new Date(0) },
} as const;

// covers IN-002: the Inbox opened from a camp's tray lists that camp's entries, or all of them (#1423).
describe("inScope", () => {
  const entries = [inChat, inCamp, device as never];

  it("lists everything when the Inbox opened on no chat or camp, or shows everywhere", () => {
    expect(inScope(entries, undefined)).toBe(entries);
    expect(inScope(entries, { threadId: CAMP, scope: "everywhere" })).toBe(entries);
  });

  it("lists only what is about the chat or camp it opened on", () => {
    expect(inScope(entries, { threadId: CAMP, scope: "here" })).toEqual([inCamp]);
    expect(inScope(entries, { threadId: THREAD, scope: "here" })).toEqual([inChat]);
  });
});

describe("inSearch", () => {
  it("keeps the chat or camp, and Everywhere only when it is on", () => {
    expect(inSearch(undefined)).toEqual({});
    expect(inSearch({ threadId: CAMP, scope: "here" })).toEqual({ in: CAMP });
    expect(inSearch({ threadId: CAMP, scope: "everywhere" })).toEqual({ in: CAMP, scope: "everywhere" });
  });
});

describe("waitingIn", () => {
  it("counts what still waits, not a decided request kept in view", () => {
    const decided = approvalEntry(
      new ApprovalRequest({ ...memberApproval(COPY, QUILL), id: ApprovalId.make("decided"), state: "approved" }),
    );
    expect(waitingIn([inChat, inCamp, decided])).toBe(2);
    expect(waitingIn([decided])).toBe(0);
  });
});
