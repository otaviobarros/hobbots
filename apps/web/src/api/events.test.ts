import { Agent, AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { activityQuery } from "./activity.ts";
import { applyEvent } from "./events.ts";
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
      craft: "Scribe",
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
      craft: "Scribe",
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

  it("tracks what the hob is doing from the reply's events", () => {
    const client = new QueryClient();
    const activity = () => client.getQueryData(activityQuery.queryKey)?.[threadId];

    applyEvent(client, { _tag: "MessageUpserted", message: reply("streaming", "") });
    expect(activity()).toBe("thinking");
    applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), delta: "Hel" });
    expect(activity()).toBe("working");
    applyEvent(client, { _tag: "MessageUpserted", message: reply("complete", "Hello") });
    expect(activity()).toBeUndefined();
  });

  it("appends deltas to a loaded, streaming reply", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(threadId), [reply("streaming", "Hel")]);
    applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), delta: "lo" });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.[0]?.content).toBe("Hello");
  });
});
