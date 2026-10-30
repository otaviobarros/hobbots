import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentId,
  AgentTransitions,
  InvalidAgentTransition,
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
  configVersion: 1,
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

describe("AgentTransitions", () => {
  const hob = new Agent({
    id: AgentId.make("wren"),
    name: "Wren",
    craft: "Scribe",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 7,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  it("starts a new hob active, pauses, wakes and retires it", () => {
    expect(hob.status).toBe("active");
    const paused = AgentTransitions.pause(hob) as Agent;
    expect(paused.status).toBe("paused");
    expect((AgentTransitions.wake(paused) as Agent).status).toBe("active");
    expect((AgentTransitions.retire(paused, "2026-10-30T12:00:00.000Z") as Agent).status).toBe("retired");
  });

  it("returns the hob unchanged when it is already in the requested state", () => {
    expect(AgentTransitions.wake(hob)).toBe(hob);
    const retired = AgentTransitions.retire(hob, "2026-10-30T12:00:00.000Z") as Agent;
    expect(AgentTransitions.retire(retired, "2026-10-31T12:00:00.000Z")).toBe(retired);
  });

  it("records when a hob retired, and only the first time", () => {
    expect(hob.retiredAt).toBeNull();
    const retired = AgentTransitions.retire(hob, "2026-10-30T12:00:00.000Z") as Agent;
    expect(retired.retiredAt).toBe("2026-10-30T12:00:00.000Z");
    expect((AgentTransitions.retire(retired, "2026-10-31T12:00:00.000Z") as Agent).retiredAt).toBe(
      "2026-10-30T12:00:00.000Z",
    );
  });

  it("keeps a retired hob retired", () => {
    const retired = AgentTransitions.retire(hob, "2026-10-30T12:00:00.000Z") as Agent;
    expect(AgentTransitions.pause(retired)).toMatchObject({ _tag: "InvalidAgentTransition", from: "retired" });
    expect(AgentTransitions.wake(retired)).toBeInstanceOf(InvalidAgentTransition);
  });
});
