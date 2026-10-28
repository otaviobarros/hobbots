import { describe, expect, it } from "vitest";
import {
  InvalidMessageTransition,
  Message,
  MessageId,
  MessageTransitions,
  ThreadId,
  titleFromPrompt,
} from "../src/index.ts";

const streaming = new Message({
  id: MessageId.make("m1"),
  threadId: ThreadId.make("t1"),
  role: "assistant",
  content: "",
  status: "streaming",
  error: null,
  createdAt: "2026-10-28T00:00:00.000Z",
});

describe("MessageTransitions", () => {
  it("appends deltas and completes a streaming message", () => {
    const partial = MessageTransitions.appendDelta(streaming, "Hello");
    expect(partial).toBeInstanceOf(Message);
    const done = MessageTransitions.complete(partial as Message);
    expect(done).toMatchObject({ content: "Hello", status: "complete" });
  });

  it("rejects changes to a finished message", () => {
    const done = MessageTransitions.complete(streaming, "final") as Message;
    expect(MessageTransitions.appendDelta(done, "x")).toBeInstanceOf(InvalidMessageTransition);
    expect(MessageTransitions.fail(done, "boom")).toBeInstanceOf(InvalidMessageTransition);
  });
});

describe("titleFromPrompt", () => {
  it("collapses whitespace and truncates long prompts", () => {
    expect(titleFromPrompt("  hi\n there ")).toBe("hi there");
    expect(titleFromPrompt("x".repeat(80))).toHaveLength(60);
    expect(titleFromPrompt("   ")).toBe("New thread");
  });
});
