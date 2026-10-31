import { Agent, AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { activityQuery } from "./activity.ts";
import { applyEvent } from "./events.ts";
import { setSteps } from "./live.ts";
import { queryKeys } from "./queries.ts";

const threadId = ThreadId.make("t1");
const now = "2026-10-28T12:00:00.000Z";
const reply = (status: Message["status"], content: string) =>
  new Message({
    id: MessageId.make("m1"),
    threadId,
    role: "assistant",
    content,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
  });

describe("applyEvent", () => {
  it("does not create a partial list for a thread that was never loaded", () => {
    const client = new QueryClient();
    applyEvent(client, { _tag: "MessageUpserted", message: reply("streaming", "") });
    applyEvent(client, {
      _tag: "ThreadUpserted",
      thread: new Thread({
        id: threadId,
        agentId: AgentId.make("aldric"),
        title: "Hi",
        runtimeSessionId: null,
        createdAt: now,
        updatedAt: now,
      }),
    });
    expect(client.getQueryData(queryKeys.messages(threadId))).toBeUndefined();
    expect(client.getQueryData(queryKeys.threads(AgentId.make("aldric")))).toBeUndefined();
  });

  it("adds a hob created elsewhere to a loaded hob list", () => {
    const client = new QueryClient();
    const hob = new Agent({
      id: AgentId.make("wren"),
      name: "Wren",
      roleTitle: "Writer",
      runtime: "claude-code",
      model: "sonnet",
      effort: "high",
      instructions: "",
      lookSeed: 7,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    });
    applyEvent(client, { _tag: "AgentUpserted", agent: hob });
    expect(client.getQueryData(queryKeys.agents)).toBeUndefined();
    client.setQueryData(queryKeys.agents, []);
    applyEvent(client, { _tag: "AgentUpserted", agent: hob });
    expect(client.getQueryData(queryKeys.agents)).toEqual([hob]);
  });

  it("drops a hob from the hob list once it is retired and keeps a paused one", () => {
    const client = new QueryClient();
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
      createdAt: now,
    });
    client.setQueryData(queryKeys.agents, [hob]);
    const paused = new Agent({ ...hob, status: "paused" });
    applyEvent(client, { _tag: "AgentUpserted", agent: paused });
    expect(client.getQueryData(queryKeys.agents)).toEqual([paused]);
    applyEvent(client, { _tag: "AgentUpserted", agent: new Agent({ ...hob, status: "retired" }) });
    expect(client.getQueryData(queryKeys.agents)).toEqual([]);
  });

  it("adds a hob retired elsewhere to loaded Archived hobs, most recently retired first", () => {
    const client = new QueryClient();
    const hob = (id: string, retiredAt: string | null) =>
      new Agent({
        id: AgentId.make(id),
        name: id,
        roleTitle: "Writer",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 7,
        lookColor: "moss",
        configVersion: 1,
        createdAt: now,
        status: "retired",
        retiredAt,
      });
    const older = hob("fern", null);
    const wren = hob("wren", "2026-10-30T12:00:00.000Z");
    applyEvent(client, { _tag: "AgentUpserted", agent: wren });
    expect(client.getQueryData(queryKeys.archivedAgents)).toBeUndefined();
    client.setQueryData(queryKeys.archivedAgents, [older]);
    applyEvent(client, { _tag: "AgentUpserted", agent: wren });
    expect(client.getQueryData(queryKeys.archivedAgents)).toEqual([wren, older]);
  });

  it("tracks what the hob is doing from the reply's events", () => {
    const client = new QueryClient();
    const activity = () => client.getQueryData(activityQuery.queryKey)?.[threadId];

    applyEvent(client, { _tag: "MessageUpserted", message: reply("streaming", "") });
    expect(activity()).toBe("thinking");
    applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), offset: 0, delta: "Hel" });
    expect(activity()).toBe("working");
    applyEvent(client, { _tag: "MessageUpserted", message: reply("complete", "Hello") });
    expect(activity()).toBeUndefined();
  });

  it("appends deltas to a loaded, streaming reply", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(threadId), [reply("streaming", "Hel")]);
    applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), offset: 3, delta: "lo" });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.[0]?.content).toBe("Hello");
  });

  it("keeps a stopping reply in progress until it is stopped", () => {
    const client = new QueryClient();
    const activity = () => client.getQueryData(activityQuery.queryKey)?.[threadId];
    client.setQueryData(queryKeys.messages(threadId), [reply("streaming", "Hel")]);

    applyEvent(client, { _tag: "MessageUpserted", message: reply("stopping", "Hel") });
    applyEvent(client, { _tag: "TurnStopRequested", threadId, messageId: MessageId.make("m1") });
    applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), offset: 3, delta: "lo" });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.[0]).toMatchObject({
      content: "Hello",
      status: "stopping",
    });
    expect(activity()).toBe("working");

    applyEvent(client, { _tag: "MessageUpserted", message: reply("stopped", "Hello") });
    applyEvent(client, { _tag: "TurnStopped", threadId, messageId: MessageId.make("m1") });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.[0]?.status).toBe("stopped");
    expect(activity()).toBeUndefined();
  });

  it("moves a queued message that starts to the end and drops one that was removed", () => {
    const client = new QueryClient();
    const user = (id: string, status: Message["status"]) =>
      new Message({ ...reply(status, id), id: MessageId.make(id), role: "user", configVersion: null });
    client.setQueryData(queryKeys.messages(threadId), [
      user("first", "complete"),
      user("q1", "queued"),
      user("q2", "queued"),
      reply("streaming", ""),
    ]);
    applyEvent(client, { _tag: "MessageUpserted", message: user("q2", "complete") });
    applyEvent(client, { _tag: "MessageDequeued", threadId, messageId: MessageId.make("q2"), reason: "started" });
    applyEvent(client, { _tag: "MessageDequeued", threadId, messageId: MessageId.make("q1"), reason: "removed" });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.map((m) => m.id)).toEqual([
      "first",
      "m1",
      "q2",
    ]);
  });

  it("replaces a reply's steps with each update, which carries the whole list", () => {
    const client = new QueryClient();
    const messageId = MessageId.make("m-steps");
    const threadId = ThreadId.make("t-steps");
    const thinking = { id: "thinking-1", kind: "thinking", label: "Thinking" } as const;
    applyEvent(client, { _tag: "MessageSteps", threadId, messageId, steps: [{ ...thinking, state: "running" }] });
    applyEvent(client, { _tag: "MessageSteps", threadId, messageId, steps: [{ ...thinking, state: "done" }] });
    expect(client.getQueryData(["steps", messageId])).toEqual([{ ...thinking, state: "done" }]);
    setSteps(client, messageId, []);
    expect(client.getQueryData(["steps", messageId])).toEqual([]);
  });
});
