import type { WaitingDevice } from "@hobbots/api";
import {
  type AgentId,
  ApprovalRequest,
  BackpackBlocker,
  BackpackItem,
  BackpackItemId,
  PairingRequest,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, COPY, memberApproval, QUILL, question, stuckItem, THREAD, task } from "../../test/quests.ts";
import {
  approvalEntry,
  deviceEntry,
  entryRow,
  groupByThread,
  namesRequest,
  needsEntries,
  questionEntry,
  selectedEntry,
  stuckEntry,
} from "./inbox-entries.ts";

const now = new Date("2026-11-01T10:00:00.000Z");
const at = "2026-11-01T09:00:00.000Z";

const NAMES: Record<string, string> = { aldric: "Aldric", quill: "Quill", ada: "Ada" };
const names = (agentId: AgentId) => NAMES[agentId] ?? "A hob";

const request = (expiresAt: string | null, state: ApprovalRequest["state"] = "pending") =>
  new ApprovalRequest({ ...memberApproval(COPY, QUILL), state, expiresAt });

const stuck = stuckItem;

const device = (expiresAt: string): WaitingDevice => ({
  request: new PairingRequest({
    id: "p1",
    code: "482913",
    name: "MacBook Air",
    kind: "browser",
    platform: "macOS",
    tailscale: null,
    state: "pending",
    createdAt: at,
    expiresAt,
    decidedAt: null,
    deviceId: null,
  }),
  fromHub: false,
});

const asked = {
  question: question(COPY, ADA, "Monthly or yearly price?\nThe brief does not say.", {
    recipientId: null,
    chain: [ALDRIC],
  }),
  task: task(COPY, { ownerId: ADA }),
};

describe("entryRow", () => {
  it("shows a request as who asked from you down, the action, and when it expires, loud under an hour", () => {
    const row = entryRow(approvalEntry(request("2026-11-01T10:20:00.000Z")), names, ALDRIC, now);
    expect(row).toEqual({
      who: "You → Aldric → Quill",
      kind: "Approval",
      tag: "needs-you",
      what: "Delete files",
      when: "Expires in 20 minutes",
      tone: "urgent",
    });
    const later = entryRow(approvalEntry(request("2026-11-01T13:00:00.000Z")), names, QUILL, now);
    expect([later.who, later.when, later.tone]).toEqual(["You → Quill", "Expires in 3 hours", "plain"]);
  });

  it("says how a closed request ended, quietly", () => {
    const row = entryRow(approvalEntry(request(null, "expired")), names, undefined, now);
    expect([row.kind, row.tag, row.when, row.tone]).toEqual(["Expired", "muted", "Expired · nothing ran", "plain"]);
  });

  it("shows a question as the chain it climbed up to you, with its first line", () => {
    const row = entryRow(questionEntry(asked), names, ALDRIC, now);
    expect(row).toEqual({
      who: "Ada → Aldric → you",
      kind: "Question",
      tag: "needs-you",
      what: "Monthly or yearly price?",
      when: "Ada is waiting on this",
      tone: "plain",
    });
  });

  it("shows stuck work in rose with how many tries it took, or that its hob retired", () => {
    const row = entryRow(stuckEntry(stuck(THREAD)), names, ALDRIC, now);
    expect(row).toEqual({
      who: "Aldric → Quill",
      kind: "Stuck",
      tag: "failed",
      what: "Reading a message",
      when: "Stuck after 3 tries",
      tone: "stuck",
    });
    expect(entryRow(stuckEntry(stuck(THREAD, true)), names, undefined, now).when).toBe("Quill retired");
  });

  it("shows a device asking to join with its name and when the request runs out", () => {
    const row = entryRow(deviceEntry(device("2026-11-01T10:08:00.000Z")), names, undefined, now);
    expect(row).toEqual({
      who: "MacBook Air → you",
      kind: "New device",
      tag: "needs-you",
      what: "A new device asks to join",
      when: "Expires in 8 minutes",
      tone: "urgent",
    });
  });
});

describe("entries", () => {
  const other = ThreadId.make("other");
  const entries = needsEntries({
    devices: [device("2026-11-01T10:08:00.000Z")],
    questions: [asked],
    blockers: [stuck(other)],
    requests: [request(null)],
  });

  it("lists devices, questions, stuck work and requests in one list, the requests by their own id", () => {
    expect(entries.map((entry) => entry.key)).toEqual(["device:p1", "question:q-copy", "stuck:b1", "ap-copy"]);
    expect(entries.map((entry) => namesRequest(entry.key))).toEqual([false, false, false, true]);
  });

  it("groups by thread in the order each thread first appears, with this hub's devices apart", () => {
    expect(groupByThread(entries).map((group) => [group.threadId, group.entries.map((entry) => entry.kind)])).toEqual([
      [null, ["device"]],
      [THREAD, ["question", "approval"]],
      [other, ["stuck"]],
    ]);
  });

  it("shows the entry the address names when the list has it, otherwise the first", () => {
    expect(selectedEntry(entries, "stuck:b1")?.kind).toBe("stuck");
    expect(selectedEntry(entries, "gone")?.kind).toBe("device");
    expect(selectedEntry([], "ap-copy")).toBeUndefined();
  });
});
