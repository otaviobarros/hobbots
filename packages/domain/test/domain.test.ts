import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentId,
  AgentTransitions,
  InvalidAgentTransition,
  InvalidMessageTransition,
  isInProgress,
  isResumable,
  Message,
  MessageId,
  MessageTransitions,
  QueuedMessageTransitions,
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

  it("keeps a stopping reply in progress until its turn ends, then marks it stopped", () => {
    const stopping = MessageTransitions.requestStop(MessageTransitions.appendDelta(streaming, "Hel") as Message);
    expect(stopping).toMatchObject({ content: "Hel", status: "stopping" });
    expect(isInProgress((stopping as Message).status)).toBe(true);
    const more = MessageTransitions.appendDelta(stopping as Message, "lo") as Message;
    expect(MessageTransitions.interrupt(more)).toMatchObject({ content: "Hello", status: "stopped" });
    // A turn that finished before the runtime honoured the stop stays complete.
    expect(MessageTransitions.complete(more)).toMatchObject({ status: "complete" });
  });

  it("marks a turn Hobbots ended itself as interrupted, and rejects stopping a finished reply", () => {
    expect(MessageTransitions.interrupt(streaming)).toMatchObject({ status: "interrupted" });
    const stopped = MessageTransitions.interrupt(MessageTransitions.requestStop(streaming) as Message) as Message;
    expect(isInProgress(stopped.status)).toBe(false);
    expect(MessageTransitions.requestStop(stopped)).toBeInstanceOf(InvalidMessageTransition);
  });
});

describe("a reply cut off or limited by the provider", () => {
  it("keeps a reply with text as interrupted with the reason, and fails one with none", () => {
    const partial = MessageTransitions.appendDelta(streaming, "Hel") as Message;
    expect(MessageTransitions.cutOff(partial, "Claude stopped responding")).toMatchObject({
      status: "interrupted",
      error: "Claude stopped responding",
      content: "Hel",
    });
    expect(MessageTransitions.cutOff(streaming, "Claude stopped responding")).toMatchObject({ status: "failed" });
  });

  it("records when a limited reply's allowance refills", () => {
    const limited = MessageTransitions.limit(streaming, "2026-10-28T01:00:00.000Z") as Message;
    expect(limited).toMatchObject({ status: "limited", resetsAt: "2026-10-28T01:00:00.000Z" });
    expect(isResumable(limited.status)).toBe(true);
  });

  it("resumes only an interrupted or limited reply, clearing why it ended", () => {
    const cut = MessageTransitions.cutOff(MessageTransitions.appendDelta(streaming, "Hel") as Message, "gone");
    expect(MessageTransitions.resume(cut as Message)).toMatchObject({
      status: "streaming",
      error: null,
      content: "Hel",
    });
    const limited = MessageTransitions.limit(streaming, null) as Message;
    expect(MessageTransitions.resume(limited)).toMatchObject({ status: "streaming", resetsAt: null });
    const done = MessageTransitions.complete(streaming, "x") as Message;
    expect(MessageTransitions.resume(done)).toBeInstanceOf(InvalidMessageTransition);
    const stopped = MessageTransitions.interrupt(MessageTransitions.requestStop(streaming) as Message) as Message;
    expect(MessageTransitions.resume(stopped)).toBeInstanceOf(InvalidMessageTransition);
  });
});

describe("a reply's steps when its turn ends", () => {
  // covers CH-004, CH-007
  it("[TC-CH-113] leaves running and awaiting steps unfinished for good, so Continue cannot revive them", () => {
    const call = { tool: "Bash", operation: "run-commands", targets: ["/work"] } as const;
    const withSteps = MessageTransitions.setSteps(MessageTransitions.appendDelta(streaming, "Hel") as Message, [
      { id: "t1", kind: "tool", label: "Running pnpm test", state: "running", call },
      { id: "t2", kind: "tool", label: "Pushing", state: "awaiting", call, approvalId: "a1" },
      { id: "t3", kind: "tool", label: "Editing a.ts", state: "done", call },
    ]) as Message;
    for (const ended of [
      MessageTransitions.interrupt(withSteps),
      MessageTransitions.cutOff(withSteps, "gone"),
      MessageTransitions.limit(withSteps, null),
      MessageTransitions.complete(withSteps),
    ]) {
      expect((ended as Message).steps.map((step) => step.state)).toEqual(["unfinished", "unfinished", "done"]);
    }
    const resumed = MessageTransitions.resume(MessageTransitions.interrupt(withSteps) as Message) as Message;
    expect(resumed.status).toBe("streaming");
    expect(resumed.steps.map((step) => step.state)).toEqual(["unfinished", "unfinished", "done"]);
  });
});

describe("QueuedMessageTransitions", () => {
  const queued = new Message({ ...streaming, role: "user", status: "queued", configVersion: null });

  it("starts a queued user message", () => {
    expect(QueuedMessageTransitions.start(queued)).toMatchObject({ status: "complete" });
  });

  it("starts nothing that is not a queued user message", () => {
    const started = QueuedMessageTransitions.start(queued) as Message;
    expect(QueuedMessageTransitions.start(started)).toBeInstanceOf(InvalidMessageTransition);
    expect(QueuedMessageTransitions.start(new Message({ ...queued, role: "assistant" }))).toBeInstanceOf(
      InvalidMessageTransition,
    );
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
    roleTitle: "Writer",
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
