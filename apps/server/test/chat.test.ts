import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatService, HobAdmission, HobbotsRepository, HobTools, type ToolAccess } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  isInProgress,
  type Message,
  type MessageId,
  type ThreadId,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FAKE_DIRECTIVES, FakeRuntimeLayer, fakeCutOffError } from "@hobbots/runtimes";
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Schedule } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");

// New installations start without hobs, so each test summons its own.
const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "You are Aldric.",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

const Persistence = HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase));
const testLayer = (runtime = FakeRuntimeLayer(), tools = HobTools.chatOnly) =>
  ChatService.layer
    .pipe(Layer.provide(tools))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(Persistence)),
          EventBus.layer,
          HobAdmission.layer,
          runtime,
        ),
      ),
    );
const TestLayer = testLayer();

describe("ChatService", () => {
  // covers CH-002, CH-004, DP-003
  it("[TC-CH-001] streams a turn, completes it, stores the session id and resumes it on the next prompt", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;

      const thread = yield* chat.createThread(HOB_ID);
      // Waits until no message in the thread is still streaming or queued.
      const settled = repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) =>
          // A started message is saved a moment before its reply, so wait for the reply too.
          messages.some((m) => m.status === "streaming" || m.status === "queued") ||
          messages.at(-1)?.role !== "assistant"
            ? Effect.fail("busy" as const)
            : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );

      yield* chat.sendPrompt(thread.id, "hello");
      yield* settled;
      const afterFirst = yield* repo.findThread(thread.id);
      yield* chat.sendPrompt(thread.id, "again");
      yield* settled;

      return {
        messages: yield* repo.listMessages(thread.id),
        threadAfterFirst: afterFirst,
        threadAfterSecond: yield* repo.findThread(thread.id),
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "hello", "complete"],
      ["assistant", "Echo: hello", "complete"],
      ["user", "again", "complete"],
      ["assistant", "Echo: again", "complete"],
    ]);
    const firstSession = Option.getOrUndefined(result.threadAfterFirst);
    const secondSession = Option.getOrUndefined(result.threadAfterSecond);
    expect(firstSession?.title).toBe("hello");
    expect(firstSession?.sessions).toMatchObject([
      { runtime: "claude-code", sessionId: expect.stringMatching(/^fake-/) },
    ]);
    expect(secondSession?.sessions[0]?.sessionId).toBe(firstSession?.sessions[0]?.sessionId);
  });

  // covers EX-005
  it("[TC-EX-001] lists a thread as active while its turn runs and drops it once the turn ends", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const thread = yield* chat.createThread(HOB_ID);

      yield* chat.sendPrompt(thread.id, "hello");
      const during = yield* chat.activeThreads;
      yield* repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      // The turn's fiber leaves the map just after it saves the final message.
      const after = yield* chat.activeThreads.pipe(
        Effect.flatMap((ids) => (ids.length > 0 ? Effect.fail("active" as const) : Effect.succeed(ids))),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      return { threadId: thread.id, during, after };
    }).pipe(Effect.provide(testLayer(FakeRuntimeLayer({ delay: "20 millis" }))), Effect.scoped, Effect.runPromise);

    expect(result.during).toEqual([result.threadId]);
    expect(result.after).toEqual([]);
  });
});

describe("a reply that ends early", () => {
  /** Waits until the thread's latest reply has ended, however it ended, and nothing waits behind it. */
  const settled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const messages = yield* repo.listMessages(threadId);
      const reply = messages.at(-1);
      return reply?.role !== "assistant" || isInProgress(reply.status) || messages.some((m) => m.status === "queued")
        ? yield* Effect.fail("busy" as const)
        : reply;
    }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  const replyTo = (threadId: ThreadId, prompt: string) =>
    Effect.gen(function* () {
      yield* (yield* ChatService).sendPrompt(threadId, prompt);
      return yield* settled(threadId);
    });
  // A reply is saved as ended a moment before its turn lets go of the thread.
  const continueSoon = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      return yield* (yield* ChatService).continueReply(threadId, messageId);
    }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }));

  // covers CH-004, CH-007
  it("[TC-CH-098] keeps a cut-off reply with its reason, and Continue resumes it in the same message", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const resumed = yield* continueSoon(thread.id, cut.id);
      const finished = yield* settled(thread.id);
      const again = yield* chat.continueReply(thread.id, cut.id).pipe(Effect.flip);
      return { cut, resumed, finished, again };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cut).toMatchObject({ status: "interrupted", error: fakeCutOffError });
    expect(result.resumed).toMatchObject({ id: result.cut.id, status: "streaming", error: null });
    expect(result.finished.status).toBe("complete");
    expect(result.finished.content.startsWith(result.cut.content)).toBe(true);
    expect(result.finished.content.length).toBeGreaterThan(result.cut.content.length);
    // A finished reply cannot be continued.
    expect(result.again._tag).toBe("ReplyNotResumable");
  });

  // covers CH-004, AG-004
  it("[TC-CH-101] stores the configuration a continued reply runs on, after the hob was edited", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const hob = Option.getOrThrow(yield* repo.findAgent(HOB_ID));
      yield* repo.updateAgentConfig(
        new Agent({ ...hob, instructions: "Be brief.", configVersion: hob.configVersion + 1 }),
      );
      const resumed = yield* continueSoon(thread.id, cut.id);
      yield* settled(thread.id);
      const stored = (yield* repo.listMessages(thread.id)).find((m) => m.id === cut.id);
      return { cut, resumed, stored };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cut.configVersion).toBe(1);
    expect(result.resumed.configVersion).toBe(2);
    expect(result.stored?.configVersion).toBe(2);
  });

  // covers CH-004
  it("[TC-CH-099] marks a reply the provider limit ended with when the allowance refills", async () => {
    const limited = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      return yield* replyTo(thread.id, `${FAKE_DIRECTIVES.limit} please`);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(limited.status).toBe("limited");
    expect(limited.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(limited.content.length).toBeGreaterThan(0);
  });

  // covers CH-004
  it("[TC-CH-100] continues only the thread's latest reply", async () => {
    const error = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      yield* replyTo(thread.id, "next");
      return yield* chat.continueReply(thread.id, cut.id).pipe(Effect.flip);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);
    expect(error._tag).toBe("ReplyNotResumable");
  });
});

describe("tool calls in a reply", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-chat-tools-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "work");
  mkdirSync(folder);
  const tools = Layer.succeed(
    HobTools,
    HobTools.of({
      access: () =>
        Effect.succeed({
          policy: {
            preset: "balanced",
            sharedFolders: [folder],
            hob: EMPTY_HOB_POLICY,
            dataFolder: join(root, "data"),
            restrictions: [],
          },
          folders: [folder],
          runtimeFolder: join(root, "runtimes", HOB_ID),
        }),
    }),
  );

  // covers CH-004, PE-002
  it("[TC-CH-109] saves each tool call as a step of the reply, a refused one with its reason, and journals every change", async () => {
    const { stored, journaled } = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const bus = yield* EventBus;
      const repo = yield* HobbotsRepository;
      const subscription = yield* bus.subscribe;
      const thread = yield* chat.createThread(HOB_ID);
      yield* chat.sendPrompt(
        thread.id,
        `Fix it\nfake:tool Edit ${join(folder, "a.ts")}\nfake:tool Bash pnpm test\nfake:tool Write ${join(root, "outside.txt")}`,
      );
      const reply = yield* repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) => {
          const last = messages.at(-1);
          return last?.role === "assistant" && !isInProgress(last.status) ? Effect.succeed(last) : Effect.fail("busy");
        }),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      const events = yield* PubSub.takeAll(subscription);
      // The reply's upserts carry its steps, so a client replaying the journal sees each change.
      const upserts = events.flatMap(
        (event): ReadonlyArray<Message> =>
          event._tag === "Journaled" &&
          event.entry.payload._tag === "MessageUpserted" &&
          event.entry.payload.message.id === reply.id
            ? [event.entry.payload.message]
            : [],
      );
      return { stored: reply.steps, journaled: upserts.map((m) => m.steps.map((step) => `${step.id}:${step.state}`)) };
    }).pipe(
      Effect.provide(testLayer(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)), tools)),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(stored).toEqual([
      { id: "thinking-1", kind: "thinking", label: "Thinking", state: "done" },
      {
        id: "fake-tool-1",
        kind: "tool",
        label: "Editing a.ts",
        state: "done",
        call: { tool: "Edit", operation: "edit-files", targets: [join(folder, "a.ts")] },
      },
      {
        id: "fake-tool-2",
        kind: "tool",
        label: "Running pnpm test",
        state: "done",
        call: { tool: "Bash", operation: "run-commands", targets: [folder] },
      },
      expect.objectContaining({
        id: "fake-tool-3",
        kind: "tool",
        state: "denied",
        decidedBy: "policy",
        reason: expect.any(String),
        call: expect.objectContaining({ tool: "Write", operation: "outside-folders" }),
      }),
    ]);
    expect(journaled).toContainEqual(["thinking-1:done", "fake-tool-1:running"]);
    expect(journaled.at(-1)).toEqual(["thinking-1:done", "fake-tool-1:done", "fake-tool-2:done", "fake-tool-3:denied"]);
  });

  // covers PE-008
  it("[TC-PE-021] stops a running turn once its hob's policy narrows, and keeps it when the policy widens", async () => {
    // The policy as saved right now; each case changes it while the turn runs.
    let restrictions: ToolAccess["policy"]["restrictions"] = [{ "edit-files": "ask" }];
    let folders = [folder];
    let hob: ToolAccess["policy"]["hob"] = EMPTY_HOB_POLICY;
    const changing = Layer.succeed(
      HobTools,
      HobTools.of({
        access: () =>
          Effect.sync(() => ({
            policy: {
              preset: "balanced" as const,
              sharedFolders: folders,
              hob,
              dataFolder: join(root, "data"),
              restrictions,
            },
            folders,
            runtimeFolder: join(root, "runtimes", HOB_ID),
          })),
      }),
    );
    const statusAfter = (change: () => void) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* chat.createThread(HOB_ID);
        yield* chat.sendPrompt(thread.id, "one two three four five six seven eight nine ten");
        const reply = repo.listMessages(thread.id).pipe(Effect.map((messages) => messages.at(-1)));
        // Text is streaming, so the turn already holds what it was given.
        yield* chat.streamingReplies.pipe(
          Effect.flatMap((replies) => (replies.some((m) => m.content !== "") ? Effect.void : Effect.fail("waiting"))),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        change();
        yield* chat.reviewAuthority(HOB_ID);
        return (yield* reply)?.status;
      }).pipe(
        Effect.provide(testLayer(FakeRuntimeLayer({ delay: "40 millis" }), changing)),
        Effect.scoped,
        Effect.runPromise,
      );

    // Narrower: an operation's answer, or a folder taken away. The turn has ended when review returns.
    expect(await statusAfter(() => (restrictions = [{ "edit-files": "deny" }]))).toBe("interrupted");
    restrictions = [];
    expect(await statusAfter(() => (folders = []))).toBe("interrupted");
    // Wider or the same: the turn goes on.
    folders = [folder];
    restrictions = [{ "edit-files": "ask" }];
    expect(await statusAfter(() => (restrictions = []))).toBe("streaming");
    // Signing with the user's key taken away stops the turn, since it holds the agent's socket.
    restrictions = [];
    hob = { ...EMPTY_HOB_POLICY, signCommits: true };
    expect(await statusAfter(() => (hob = EMPTY_HOB_POLICY))).toBe("interrupted");
    // Given, it waits for the next turn.
    hob = EMPTY_HOB_POLICY;
    expect(await statusAfter(() => (hob = { ...EMPTY_HOB_POLICY, signCommits: true }))).toBe("streaming");
  });

  // covers PE-008
  it("[TC-PE-022] stops a turn whose grant was still being read when the policy narrowed", async () => {
    let restrictions: ToolAccess["policy"]["restrictions"] = [];
    const status = await Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const policy = (current: typeof restrictions): ToolAccess => ({
        policy: {
          preset: "balanced",
          sharedFolders: [folder],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(root, "data"),
          restrictions: current,
        },
        folders: [folder],
        runtimeFolder: join(root, "runtimes", HOB_ID),
      });
      // The turn's grant reads the policy, then holds on until released.
      const slow = Layer.succeed(
        HobTools,
        HobTools.of({
          access: () =>
            Effect.gen(function* () {
              const read = policy(restrictions);
              if (yield* Deferred.succeed(reading, undefined)) yield* Deferred.await(release);
              return read;
            }),
        }),
      );
      return yield* Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* chat.createThread(HOB_ID);
        yield* chat.sendPrompt(thread.id, "one two three four five six seven eight nine ten");
        yield* Deferred.await(reading);
        // The narrower policy is saved while the grant still holds the older one.
        restrictions = [{ "edit-files": "deny" }];
        const review = yield* Effect.forkChild(chat.reviewAuthority(HOB_ID));
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(review);
        return (yield* repo.listMessages(thread.id)).at(-1)?.status;
      }).pipe(Effect.provide(testLayer(FakeRuntimeLayer({ delay: "40 millis" }), slow)));
    }).pipe(Effect.scoped, Effect.runPromise);
    expect(status).toBe("interrupted");
  });
});
