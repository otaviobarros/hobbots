import { HobbotsRepository, type NewTask, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  hobActor,
  MessageId,
  NoteId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Pause, Pause now and Resume on the records (#1446), and what a lead's retry and reassign write.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | EventJournal>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-13T00:00:00.000Z";
const later = "2026-11-13T00:05:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const BRAM = AgentId.make("bram");
const you = { kind: "user" as const, id: "owner" };
const threadId = ThreadId.make("t1");

const newTask = (id: string, ownerId: AgentId, parentId: string | null): NewTask => ({
  id: TaskId.make(id),
  ownerId,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: `Brief for ${id}`,
  dependsOn: [],
  createdAt: now,
});

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Aldric leads a Quest and delegates the copy to Quill; Bram is free to take it over. */
const campaign = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const each of [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(BRAM, "Bram")]) yield* repo.insertAgent(each);
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const root = yield* tasks.createTask({ task: newTask("campaign", ALDRIC, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: root.value.id,
    goal: "A campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const copy = yield* tasks.createTask({
    task: newTask("copy", QUILL, "campaign"),
    delegation: {
      id: DelegationId.make("d-copy"),
      brief: "Write the copy",
      expectedOutput: null,
      authority: { overrides: { push: "ask" }, folders: ["/work"] },
      timeoutMs: null,
    },
    milestones: [],
  });
  return { root: root.value, copy: copy.value };
});

const treeOf = Effect.map(
  TaskRepository.use((tasks) => tasks.readTree(TaskId.make("campaign"))),
  (tree) => Option.getOrThrow(tree),
);
const stateOf = (id: string) =>
  Effect.map(treeOf, (tree) => tree.tasks.find((each) => each.id === id) ?? Option.getOrThrow(Option.none()));

describe("pausing a Quest's work", () => {
  // covers OR-006
  it("[TC-OR-1446-10] pauses a Task with nothing running at once, the Quest with it, and resumes it where it stood", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const { root, copy } = yield* campaign;
        const paused = yield* tasks.pauseTask(root.id, root.revision, { at: later, by: you, now: false });
        const member = yield* tasks.pauseTask(copy.id, copy.revision, { at: later, by: you, now: false });
        const whilePaused = yield* treeOf;
        // No new Task lands under a paused one.
        const placed = yield* tasks
          .createTask({ task: newTask("more", ALDRIC, "campaign"), delegation: null, milestones: [] })
          .pipe(Effect.flip);
        // A member cannot be resumed while the Quest above it holds it.
        const early = yield* tasks.resumeTask(copy.id, member.value.revision, { at: later, by: you }).pipe(Effect.flip);
        const top = yield* tasks.resumeTask(root.id, paused.value.revision, { at: later, by: you });
        const resumed = yield* tasks.resumeTask(copy.id, member.value.revision, { at: later, by: you });
        return { paused, member, whilePaused, placed, early, top, resumed, after: yield* treeOf };
      }),
    );
    expect(result.paused.value).toMatchObject({ state: "paused", pause: { from: "queued", by: you, now: false } });
    const changed = result.paused.entries.find((entry) => entry.payload._tag === "TaskStateChanged")?.payload;
    expect(changed).toMatchObject({ control: { _tag: "Paused", by: you, now: false }, quest: { state: "paused" } });
    expect(result.whilePaused.quests[0]?.state).toBe("paused");
    expect(result.whilePaused.tasks.map((each) => each.state)).toEqual(["paused", "paused"]);
    expect(result.placed).toMatchObject({ reason: "parent-paused" });
    expect(result.early).toMatchObject({ reason: "parent-paused" });
    expect(result.top.value).toMatchObject({ state: "queued", pause: null });
    expect(result.resumed.value).toMatchObject({ state: "queued", pause: null });
    expect(result.after.quests[0]?.state).toBe("active");
  });

  // covers OR-006, EX-001
  it("[TC-OR-1446-11] waits for a running turn as pausing, and settles paused only once that turn has ended", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const { copy } = yield* campaign;
        const started = yield* tasks.startAttempt(copy.id, copy.revision, {
          id: AttemptId.make("a1"),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        const pausing = yield* tasks.pauseTask(copy.id, started.value.task.revision, { at: later, by: you, now: true });
        const listed = yield* tasks.listPausingTasks;
        const tooSoon = yield* tasks.settlePause(copy.id, pausing.value.revision, "waiting", later).pipe(Effect.flip);
        const ended = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Stopped", reason: "Paused" },
          at: later,
        });
        const settled = yield* tasks.settlePause(copy.id, ended.value.task.revision, "waiting", later);
        return { pausing, listed, tooSoon, settled, copy: yield* stateOf("copy") };
      }),
    );
    expect(result.pausing.value).toMatchObject({ state: "pausing", pause: { from: "active", now: true } });
    expect(result.listed.map((each) => each.id)).toEqual(["copy"]);
    expect(result.tooSoon).toMatchObject({ reason: "attempt-live" });
    expect(result.settled.value).toMatchObject({ state: "paused", pause: { from: "waiting" } });
    expect(result.copy.state).toBe("paused");
  });
});

describe("a lead's retry and reassign", () => {
  // covers EX-001, OR-006
  it("[TC-OR-1446-12] refuses a retry while the last Attempt may still run", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const { copy } = yield* campaign;
        yield* tasks.startAttempt(copy.id, copy.revision, {
          id: AttemptId.make("a1"),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        const ended = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Unconfirmed", reason: "Not confirmed" },
          at: later,
        });
        const failed = yield* tasks.moveTask(copy.id, ended.value.task.revision, "failed", later);
        const by = { actor: hobActor(ALDRIC), reason: "The tests were flaky" };
        const refused = yield* tasks.retryTask(copy.id, failed.value.revision, later, by).pipe(Effect.flip);
        return { failed, refused };
      }),
    );
    expect(result.failed.value).toMatchObject({ state: "failed" });
    expect(result.refused).toMatchObject({ reason: "attempt-unresolved" });
  });

  // covers OR-006, STD-SEC-003
  it("[TC-OR-1446-13] gives the new hob the authority worked out for it, and journals the lead and its reason", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const { copy } = yield* campaign;
        const authority = { overrides: { push: "deny" as const }, folders: ["/work/site"] };
        const by = { actor: hobActor(ALDRIC), reason: "Bram knows the site", authority };
        const moved = yield* tasks.reassignTask(copy.id, copy.revision, BRAM, later, by);
        return { moved, tree: yield* treeOf };
      }),
    );
    expect(result.moved.value).toMatchObject({ ownerId: BRAM, state: "queued" });
    const changed = result.moved.entries.find((entry) => entry.payload._tag === "TaskStateChanged")?.payload;
    expect(changed).toMatchObject({
      control: { _tag: "Reassigned", by: hobActor(ALDRIC), reason: "Bram knows the site", from: QUILL },
    });
    expect(result.tree.delegations[0]).toMatchObject({
      memberId: BRAM,
      authority: { overrides: { push: "deny" }, folders: ["/work/site"] },
    });
  });
});

describe("your note straight to a member", () => {
  // covers STD-ARCH-019
  it("[TC-OR-1446-14] reaches the member's Task as yours, from your message, and never its lead", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const { copy } = yield* campaign;
        const left = yield* tasks.leaveNote({
          id: NoteId.make("mention:m1:copy"),
          taskId: copy.id,
          text: "@Quill use the blue theme",
          createdAt: later,
          messageId: MessageId.make("m1"),
          delivery: "steer",
          author: you,
          direct: true,
        });
        // A note of yours without @mention still goes to the Task's nearest lead.
        const viaLead = yield* tasks.leaveNote({
          id: NoteId.make("n2"),
          taskId: copy.id,
          text: "FYI",
          createdAt: later,
        });
        return { left: left.value, viaLead: viaLead.value };
      }),
    );
    expect(result.left).toMatchObject({
      recipientId: QUILL,
      senderId: null,
      messageId: "m1",
      delivery: "steer",
      author: you,
    });
    expect(result.viaLead).toMatchObject({ recipientId: ALDRIC, author: { kind: "user" } });
  });
});
