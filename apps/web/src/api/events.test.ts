import { Agent, AgentId, ApprovalId, ApprovalRequest, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { activityQuery } from "./activity.ts";
import { approvalsKey } from "./approvals.ts";
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

  it("takes a reply's steps from its upsert, so a replayed entry restores them", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(threadId), [reply("streaming", "")]);
    const edit = {
      id: "tool-1",
      kind: "tool",
      label: "Editing src/cart.ts",
      state: "done",
      call: { tool: "Edit", operation: "edit-files", targets: ["/work/src/cart.ts"] },
    } as const;
    const withSteps = new Message({ ...reply("streaming", "Hi"), steps: [edit], revision: 5 });
    applyEvent(client, { _tag: "MessageUpserted", message: withSteps });
    // An older entry arriving late changes nothing.
    applyEvent(client, { _tag: "MessageUpserted", message: new Message({ ...reply("streaming", ""), revision: 3 }) });
    expect(client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId))?.[0]?.steps).toEqual([edit]);
  });
});

describe("approval events", () => {
  const approval = (state: ApprovalRequest["state"], revision: number) =>
    new ApprovalRequest({
      id: ApprovalId.make("a1"),
      agentId: AgentId.make("pip"),
      threadId,
      messageId: MessageId.make("m1"),
      stepId: "s1",
      tool: "Bash",
      operation: "push",
      targets: [],
      arguments: { command: "git push" },
      label: "Running git push",
      reason: "Pushing asks.",
      actionDigest: "d1",
      policyVersion: "p1",
      state,
      denyReason: null,
      createdAt: now,
      decidedAt: null,
      revision,
    });

  it("adds a new request to a loaded list and keeps the newest state", () => {
    const client = new QueryClient();
    applyEvent(client, { _tag: "ApprovalRequested", approval: approval("pending", 1) });
    expect(client.getQueryData(approvalsKey(threadId))).toBeUndefined();
    client.setQueryData(approvalsKey(threadId), []);
    applyEvent(client, { _tag: "ApprovalRequested", approval: approval("pending", 1) });
    applyEvent(client, { _tag: "ApprovalResolved", approval: approval("denied", 2) });
    // A late copy of the older version changes nothing.
    applyEvent(client, { _tag: "ApprovalRequested", approval: approval("pending", 1) });
    expect(client.getQueryData<ReadonlyArray<ApprovalRequest>>(approvalsKey(threadId))?.map((a) => a.state)).toEqual([
      "denied",
    ]);
  });
});
