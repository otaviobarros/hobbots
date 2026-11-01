import { AgentId, ApprovalId, ApprovalRequest, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { archiveBlock, isArchiveKey, isTextField, isUndoKey, nextThread } from "./archive-rules.ts";

const now = "2026-11-01T12:00:00.000Z";
const threadId = ThreadId.make("t1");

const message = (status: Message["status"]) =>
  new Message({
    id: MessageId.make(`m-${status}`),
    threadId,
    role: "assistant",
    content: "",
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
  });

const approval = (state: ApprovalRequest["state"]) =>
  new ApprovalRequest({
    id: ApprovalId.make("a1"),
    agentId: AgentId.make("pip"),
    threadId,
    messageId: MessageId.make("m1"),
    stepId: "s1",
    tool: "Bash",
    operation: "run-commands",
    targets: [],
    arguments: {},
    label: "Running a command",
    reason: "",
    actionDigest: "d1",
    policyVersion: "p1",
    grantable: false,
    rules: [],
    state,
    denyReason: null,
    createdAt: now,
    decidedAt: null,
    revision: 1,
  });

const thread = (id: string) =>
  new Thread({
    id: ThreadId.make(id),
    agentId: AgentId.make("pip"),
    title: id,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });

describe("archiveBlock", () => {
  it("allows a thread that is quiet", () => {
    expect(
      archiveBlock({ messages: [message("complete")], approvals: [approval("approved")], live: false }),
    ).toBeNull();
    expect(archiveBlock({ messages: undefined, approvals: undefined, live: false })).toBeNull();
  });

  it("blocks while a reply runs, stops or waits in the queue, or live events say the hob works", () => {
    for (const status of ["streaming", "stopping", "queued"] as const)
      expect(archiveBlock({ messages: [message(status)], approvals: [], live: false })).toBe("reply-running");
    expect(archiveBlock({ messages: undefined, approvals: undefined, live: true })).toBe("reply-running");
  });

  it("names a pending approval first, as the hub does", () => {
    expect(archiveBlock({ messages: [message("streaming")], approvals: [approval("pending")], live: true })).toBe(
      "approval-pending",
    );
  });
});

describe("nextThread", () => {
  const list = [thread("a"), thread("b"), thread("c")];

  it("opens the thread below, else the one above, else none", () => {
    expect(nextThread(list, ThreadId.make("a"))?.id).toBe("b");
    expect(nextThread(list, ThreadId.make("b"))?.id).toBe("c");
    expect(nextThread(list, ThreadId.make("c"))?.id).toBe("b");
    expect(nextThread([thread("a")], ThreadId.make("a"))).toBeUndefined();
    expect(nextThread(list, ThreadId.make("missing"))).toBeUndefined();
  });
});

const key = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: "",
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcuts", () => {
  it("archives with ⌃⌘A or Ctrl+Alt+A only", () => {
    expect(isArchiveKey(key("KeyA", { ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isArchiveKey(key("KeyA", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isArchiveKey(key("KeyA", { metaKey: true }))).toBe(false);
    expect(isArchiveKey(key("KeyA", { ctrlKey: true }))).toBe(false);
    expect(isArchiveKey(key("KeyA", { ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("undoes with ⌘Z or Ctrl+Z, never with Shift (redo)", () => {
    expect(isUndoKey(key("KeyZ", { metaKey: true }))).toBe(true);
    expect(isUndoKey(key("KeyZ", { ctrlKey: true }))).toBe(true);
    expect(isUndoKey(key("KeyZ", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(key("KeyZ"))).toBe(false);
  });
});

describe("isTextField", () => {
  const element = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, ...extra }) as unknown as Element;

  it("knows text inputs, text areas and editable content from buttons and links", () => {
    expect(isTextField(element("TEXTAREA"))).toBe(true);
    expect(isTextField(element("INPUT", { type: "search" }))).toBe(true);
    expect(isTextField(element("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextField(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextField(element("BUTTON"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
