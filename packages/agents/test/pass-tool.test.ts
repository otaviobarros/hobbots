import {
  AgentId,
  hobActor,
  Message,
  MessageId,
  OWNER_ACTOR,
  type ReplyStep,
  ThreadId,
  type TurnCause,
  TurnRequest,
  TurnRequestId,
  type TurnRequestState,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { PASS_AFTER_TEXT, PASS_AFTER_WORK, PASS_NOT_ASKED, PASS_ONLY_HOB, passRefusal } from "../src/pass-tool.ts";

// Issue #1462 (ADR 039, One hob speaks at a time): a hob may pass only when someone asked it and
// before its turn said or did anything a removed reply would hide.

const NOW = "2026-11-14T10:00:00.000Z";
const PIP = AgentId.make("pip");

const reply = (content: string, steps: ReadonlyArray<ReplyStep> = []) =>
  new Message({
    id: MessageId.make("reply-pip"),
    threadId: ThreadId.make("camp"),
    actor: hobActor(PIP),
    role: "assistant",
    content,
    status: "streaming",
    error: null,
    configVersion: 1,
    steps,
    createdAt: NOW,
  });

const owed = (cause: TurnCause, state: TurnRequestState = "speaking") =>
  new TurnRequest({
    id: TurnRequestId.make(`r-${cause}`),
    threadId: ThreadId.make("camp"),
    rootMessageId: null,
    hobId: PIP,
    messageId: MessageId.make("plan"),
    causedBy: OWNER_ACTOR,
    cause,
    relayDepth: 0,
    state,
    replyId: MessageId.make("reply-pip"),
    droppedBy: null,
    queuedAt: 1,
    position: 0,
    createdAt: NOW,
  });

const step = (over: Partial<ReplyStep>): ReplyStep => ({
  id: "s-1",
  kind: "tool",
  label: "A step",
  state: "done",
  ...over,
});

describe("passRefusal", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("lets a hob that was asked pass after it only thought, read or called a hub tool", () => {
    const steps = [
      step({ kind: "thinking", label: "Thinking" }),
      step({ id: "s-2", call: { tool: "Read", operation: "read-files", targets: ["/notes.md"] } }),
      step({ id: "s-3", label: "Reading a message" }),
    ];
    expect(passRefusal(reply("", steps), 0, [owed("mention")])).toBeNull();
    expect(passRefusal(reply("  \n"), 0, [owed("relay")])).toBeNull();
  });

  // covers ADR 039 (One hob speaks at a time)
  it("refuses a pass once the turn wrote, changed something or asked, or when nobody else would answer", () => {
    const edit = step({ call: { tool: "Edit", operation: "edit-files", targets: ["/notes.md"] } });
    const asked = step({ state: "awaiting", approvalId: "approval-1" });
    expect(passRefusal(reply("Quill is right."), 0, [owed("mention")])).toBe(PASS_AFTER_TEXT);
    expect(passRefusal(reply("", [edit]), 0, [owed("mention")])).toBe(PASS_AFTER_WORK);
    expect(passRefusal(reply("", [asked]), 0, [owed("mention")])).toBe(PASS_AFTER_WORK);
    // Steps an earlier turn left on a continued reply are its own.
    expect(passRefusal(reply("", [edit]), 1, [owed("mention")])).toBeNull();
    expect(passRefusal(reply(""), 0, [])).toBe(PASS_NOT_ASKED);
    expect(passRefusal(reply(""), 0, [owed("mention", "dropped")])).toBe(PASS_NOT_ASKED);
    expect(passRefusal(reply(""), 0, [owed("only-hob")])).toBe(PASS_ONLY_HOB);
  });
});
