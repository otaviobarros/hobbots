import type { WaitingDevice } from "@hobbots/api";
import { type AgentId, ApprovalRequest, PairingRequest, type TaskId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  BUILD,
  CAMPAIGN,
  COPY,
  memberApproval,
  QUILL,
  quest,
  question,
  stuckItem,
  THREAD,
  task,
  tree,
} from "../../test/quests.ts";
import {
  approvalEntry,
  byUrgency,
  deviceEntry,
  entryRow,
  failedEntry,
  groupByPlace,
  namesRequest,
  needsEntries,
  questionEntry,
  selectedEntry,
  soonestExpiry,
  stuckEntry,
  topQuests,
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

const failedCopy = {
  task: task(BUILD, { ownerId: QUILL, state: "failed", brief: "Build the page\nWith the hero" }),
  leadId: null,
};

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
      chain: ["You", "Aldric", "Quill"],
      kind: "Approval",
      tag: "needs-you",
      what: "Delete files",
      when: "Expires in 20 minutes",
      tone: "urgent",
    });
    const later = entryRow(approvalEntry(request("2026-11-01T13:00:00.000Z")), names, QUILL, now);
    expect([later.chain, later.when, later.tone]).toEqual([["You", "Quill"], "Expires in 3 hours", "plain"]);
  });

  it("says how a closed request ended, quietly", () => {
    const row = entryRow(approvalEntry(request(null, "expired")), names, undefined, now);
    expect([row.kind, row.tag, row.when, row.tone]).toEqual(["Expired", "muted", "Expired · nothing ran", "plain"]);
  });

  it("shows a question as the chain it climbed up to you, with its first line", () => {
    const row = entryRow(questionEntry(asked), names, ALDRIC, now);
    expect(row).toEqual({
      chain: ["Ada", "Aldric", "you"],
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
      chain: ["Aldric", "Quill"],
      kind: "Stuck",
      tag: "failed",
      what: "Reading a message",
      when: "Stuck after 3 tries",
      tone: "stuck",
    });
    expect(entryRow(stuckEntry(stuck(THREAD, true)), names, undefined, now).when).toBe("Quill retired");
  });

  // covers IN-004, OR-006
  it("[TC-IN-543] shows a member's failed Task in rose under its lead, by the Task's first line", () => {
    const row = entryRow(failedEntry(failedCopy), names, ALDRIC, now);
    expect(row).toEqual({
      chain: ["Aldric", "Quill"],
      kind: "Failed",
      tag: "failed",
      what: "Build the page",
      when: "Quill's task failed",
      tone: "stuck",
    });
    expect(entryRow(failedEntry({ ...failedCopy, leadId: ADA }), names, undefined, now).chain).toEqual([
      "Ada",
      "Quill",
    ]);
  });

  it("shows a device asking to join with its name and when the request runs out", () => {
    const row = entryRow(deviceEntry(device("2026-11-01T10:08:00.000Z")), names, undefined, now);
    expect(row).toEqual({
      chain: ["MacBook Air", "you"],
      kind: "New device",
      tag: "needs-you",
      what: "A new device asks to join",
      when: "Expires in 8 minutes",
      tone: "urgent",
    });
  });
});

describe("topQuests", () => {
  it("finds the outermost Quest above each Task in the tree", () => {
    const top = quest();
    const found = topQuests([tree({ tasks: [task(CAMPAIGN), task(COPY)], quests: [top] })]);
    expect(found.get(COPY)).toBe(top);
    expect(found.get(CAMPAIGN)).toBe(top);
    expect(topQuests([tree({ tasks: [task(CAMPAIGN), task(COPY)] })]).size).toBe(0);
  });
});

describe("byUrgency", () => {
  it("puts high-risk requests first, then what expires soonest, then what waited longest, and decided ones last", () => {
    const risky = approvalEntry(
      new ApprovalRequest({ ...memberApproval(BUILD, ADA), onceOnly: true, expiresAt: "2026-11-01T15:00:00.000Z" }),
    );
    const soon = approvalEntry(request("2026-11-01T10:20:00.000Z"));
    const old = questionEntry(asked);
    const decided = approvalEntry(new ApprovalRequest({ ...memberApproval(CAMPAIGN, ADA), state: "denied" }));
    const sorted = [decided, old, soon, risky].sort(byUrgency);
    expect(sorted).toEqual([risky, soon, old, decided]);
  });
});

describe("entries", () => {
  const other = ThreadId.make("other");
  const entries = needsEntries({
    devices: [device("2026-11-01T10:08:00.000Z")],
    questions: [asked],
    blockers: [stuck(other)],
    failed: [],
    requests: [request(null)],
  });

  it("lists devices, questions, stuck work, failed Tasks and requests in one list, the requests by their own id", () => {
    const all = needsEntries({
      devices: [device("2026-11-01T10:08:00.000Z")],
      questions: [asked],
      blockers: [stuck(other)],
      failed: [failedCopy],
      requests: [request(null)],
    });
    expect(all.map((entry) => entry.key)).toEqual([
      "device:p1",
      "question:q-copy",
      "stuck:b1",
      "failed:build",
      "ap-copy",
    ]);
    expect(all.map((entry) => namesRequest(entry.key))).toEqual([false, false, false, false, true]);
  });

  it("groups by quest, or by thread outside one, with this hub's devices apart, the most urgent first", () => {
    const top = quest();
    const questOf = (taskId: TaskId) => (taskId === COPY ? top : undefined);
    expect(
      groupByPlace(entries, questOf).map((group) => [group.key, group.entries.map((entry) => entry.kind)]),
    ).toEqual([
      ["hub", ["device"]],
      ["quest:quest-bf", ["stuck", "approval", "question"]],
    ]);
    const outside = groupByPlace(entries, () => undefined).map((group) => group.key);
    expect(outside).toEqual(["hub", "thread:other", `thread:${THREAD}`]);
  });

  it("shows the entry the address names when the list has it, otherwise the first", () => {
    expect(selectedEntry(entries, "stuck:b1")?.kind).toBe("stuck");
    expect(selectedEntry(entries, "gone")?.kind).toBe("device");
    expect(selectedEntry([], "ap-copy")).toBeUndefined();
  });
});

describe("soonestExpiry", () => {
  it("names the pending request or device due first, loud under an hour, and none when nothing expires", () => {
    const late = approvalEntry(request("2026-11-01T13:00:00.000Z"));
    const pairing = deviceEntry(device("2026-11-01T10:20:00.000Z"));
    expect(soonestExpiry([late, pairing], names, now)).toEqual({
      expiresAt: "2026-11-01T10:20:00.000Z",
      name: "MacBook Air",
      urgent: true,
    });
    expect(soonestExpiry([late], names, now)).toEqual({
      expiresAt: "2026-11-01T13:00:00.000Z",
      name: "Quill",
      urgent: false,
    });
    const decided = approvalEntry(request("2026-11-01T10:05:00.000Z", "approved"));
    expect(soonestExpiry([decided, approvalEntry(request(null)), questionEntry(asked)], names, now)).toBeUndefined();
  });
});
