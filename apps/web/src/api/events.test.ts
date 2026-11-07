import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  Message,
  MessageId,
  type RemoteAccessStatus,
  Revision,
  Skill,
  SkillFeedback,
  SkillId,
  SkillName,
  SkillRevisionHash,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { activityQuery } from "./activity.ts";
import { approvalsKey } from "./approvals.ts";
import { applyEvent, remoteAccessChanged } from "./events.ts";
import { queryKeys } from "./queries.ts";
import { remoteAccessQuery } from "./remote-access.ts";
import { skillProposalsQuery } from "./skill-proposals.ts";
import { skillFeedbackQuery, skillQuery, skillRevisionQuery, skillsListQuery } from "./skills.ts";

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
  it("[TC-UX-1062-01] reads the Skills page again when a skill changes elsewhere, but not a revision, which never changes", async () => {
    const client = new QueryClient();
    const hash = SkillRevisionHash.make("a".repeat(64));
    const skill = new Skill({
      id: SkillId.make("s1"),
      name: SkillName.make("release"),
      description: "Use when releasing.",
      latest: hash,
      revisions: 1,
      sourceId: null,
      createdAt: now,
      updatedAt: now,
      revision: Revision.make(1),
    });
    const list = skillsListQuery.queryKey;
    const detail = skillQuery(skill.id).queryKey;
    const revision = skillRevisionQuery(skill.id, hash).queryKey;
    for (const key of [list, detail, revision]) client.setQueryData(key, {} as never);
    applyEvent(client, { _tag: "SkillRemoved", skill });
    await vi.waitFor(() => expect(client.getQueryState(list)?.isInvalidated).toBe(true));
    expect(client.getQueryState(detail)?.isInvalidated).toBe(true);
    expect(client.getQueryState(revision)?.isInvalidated).toBe(false);
  });

  // covers ADR 029 (skill_feedback), STD-REACT-012, #1062
  it("[TC-UX-1062-09] a note left while a skill's first read of its notes is under way is read again, not lost", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const skillId = SkillId.make("s1");
    const reads: Array<(answer: { feedback: ReadonlyArray<SkillFeedback> }) => void> = [];
    const observer = new QueryObserver(client, {
      ...skillFeedbackQuery(skillId),
      queryFn: () => new Promise<{ feedback: ReadonlyArray<SkillFeedback> }>((resolve) => reads.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => {});
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const note = new SkillFeedback({
      id: "f1",
      agentId: AgentId.make("pip"),
      skillId,
      kind: "unclear",
      note: "Step 1 does not say which diff.",
      revision: null,
      threadId: null,
      messageId: null,
      createdAt: now,
    });

    // The note lands before the first read answers: that read started without it, so a new one runs.
    applyEvent(client, { _tag: "SkillFeedbackLeft", feedback: note });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[0]?.({ feedback: [] });
    reads[1]?.({ feedback: [note] });
    await tick();
    expect(observer.getCurrentResult().data).toEqual([note]);
    unsubscribe();
  });

  it("makes a reply that lands its thread's last line in the hob's thread list", () => {
    const client = new QueryClient();
    const agentId = AgentId.make("aldric");
    const thread = new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now });
    client.setQueryData(queryKeys.threads(agentId), [thread]);
    const lastLine = () => client.getQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId))?.[0]?.lastLine;

    // A reply with no text yet, such as one still calling tools, leaves the line as it is.
    applyEvent(client, { _tag: "MessageUpserted", message: reply("streaming", "") });
    expect(lastLine()).toBeNull();
    applyEvent(client, { _tag: "MessageUpserted", message: reply("complete", "Done.\nThe copy is ready") });
    expect(lastLine()).toBe("Done. The copy is ready");
  });

  it("does not create a partial list for a thread that was never loaded", () => {
    const client = new QueryClient();
    applyEvent(client, { _tag: "MessageUpserted", message: reply("streaming", "") });
    applyEvent(client, {
      _tag: "ThreadUpserted",
      thread: new Thread({
        id: threadId,
        agentId: AgentId.make("aldric"),
        title: "Hi",
        createdAt: now,
        updatedAt: now,
      }),
    });
    expect(client.getQueryData(queryKeys.messages(threadId))).toBeUndefined();
    expect(client.getQueryData(queryKeys.threads(AgentId.make("aldric")))).toBeUndefined();
  });

  it("moves a thread archived or restored elsewhere between its hob's two lists", () => {
    const client = new QueryClient();
    const hobId = AgentId.make("aldric");
    const live = new Thread({ id: threadId, agentId: hobId, title: "Hi", createdAt: now, updatedAt: now, revision: 1 });
    const archived = new Thread({ ...live, archivedAt: "2026-10-29T09:00:00.000Z", revision: 2 });
    const restored = new Thread({ ...live, revision: 3 });
    client.setQueryData(queryKeys.threads(hobId), [live]);
    client.setQueryData(queryKeys.archivedThreads(hobId), []);

    applyEvent(client, { _tag: "ThreadUpserted", thread: archived });
    expect(client.getQueryData(queryKeys.threads(hobId))).toEqual([]);
    expect(client.getQueryData(queryKeys.archivedThreads(hobId))).toEqual([archived]);

    // An older version arriving late does not move it back.
    applyEvent(client, { _tag: "ThreadUpserted", thread: live });
    expect(client.getQueryData(queryKeys.archivedThreads(hobId))).toEqual([archived]);

    applyEvent(client, { _tag: "ThreadUpserted", thread: restored });
    expect(client.getQueryData(queryKeys.threads(hobId))).toEqual([restored]);
    expect(client.getQueryData(queryKeys.archivedThreads(hobId))).toEqual([]);
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
    // Brought back elsewhere, it leaves the retired hobs.
    const back = new Agent({ ...wren, status: "active", retiredAt: null, revision: wren.revision + 1 });
    applyEvent(client, { _tag: "AgentUpserted", agent: back });
    expect(client.getQueryData(queryKeys.archivedAgents)).toEqual([older]);
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

// Settings reads remote access again as its stream connects, and the menu-bar icon pauses it while
// that read is on its way: the read was answered before the pause, and lands after its event.
// covers DP-004
it("[TC-DP-140] a read answered before a pause never undoes the pause the hub announced after it", async () => {
  vi.stubGlobal("location", new URL("http://127.0.0.1:4317/#/settings"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads: Array<(answer: RemoteAccessStatus) => void> = [];
  const observer = new QueryObserver(client, {
    ...remoteAccessQuery,
    queryFn: () => new Promise<RemoteAccessStatus>((resolve) => reads.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const connected: RemoteAccessStatus = {
    enabled: true,
    paused: false,
    port: 4317,
    tailscale: { state: "running", dnsName: "studio-desk.example.ts.net", addresses: ["100.101.102.103"] },
    listening: ["100.101.102.103"],
    https: { enabled: false, port: 4318, listening: false, forwarding: null, detail: null },
    problem: null,
    detail: null,
  };
  const paused: RemoteAccessStatus = { ...connected, paused: true, problem: "paused", listening: [] };

  reads[0]?.(connected);
  await tick();
  void client.invalidateQueries({ queryKey: remoteAccessQuery.queryKey });
  await tick();
  expect(reads).toHaveLength(2);
  remoteAccessChanged(client, paused);
  reads[1]?.(connected);
  await tick();
  expect(observer.getCurrentResult().data).toEqual(paused);
  unsubscribe();
  vi.unstubAllGlobals();
});

describe("a proposal's review", () => {
  it("is read again when the library it is drawn from changes, and not for an opt-out", async () => {
    const client = new QueryClient();
    client.setQueryData(skillProposalsQuery.queryKey, { proposals: [] });
    const stale = () => client.getQueryState(skillProposalsQuery.queryKey)?.isInvalidated;
    applyEvent(client, { _tag: "SkillOptOutChanged", optOut: {} as never, optedOut: true });
    await Promise.resolve();
    expect(stale()).toBe(false);
    for (const event of [
      { _tag: "SkillRevisionAdded", revision: {} as never },
      { _tag: "SkillHeld", assignment: {} as never },
    ] as const) {
      client.setQueryData(skillProposalsQuery.queryKey, { proposals: [] });
      applyEvent(client, event as never);
      await vi.waitFor(() => expect(stale()).toBe(true));
    }
  });
});
