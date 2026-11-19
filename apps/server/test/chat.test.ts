import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Charms, ChatService, HobAdmission, HobbotsRepository, HobTools, type ToolAccess } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type ChannelId,
  EMPTY_HOB_POLICY,
  isInProgress,
  Message,
  MessageId,
  OWNER_ACTOR,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FAKE_DIRECTIVES, FAKE_SAY_ANSWERS_DIRECTIVE, FakeRuntimeLayer, fakeCutOffError } from "@hobbots/runtimes";
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
  it("streams a turn, completes it, stores the session id and resumes it on the next prompt", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;

      const channel = yield* chat.createChannel(HOB_ID);
      // Waits until no message in the channel is still streaming or queued.
      const settled = repo.listMessages(channel.id).pipe(
        Effect.flatMap((messages) =>
          // A started message is saved a moment before its reply, so wait for the reply too.
          messages.some((m) => m.status === "streaming" || m.status === "queued") ||
          messages.at(-1)?.role !== "assistant"
            ? Effect.fail("busy" as const)
            : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );

      yield* chat.sendPrompt(channel.id, "hello");
      yield* settled;
      const afterFirst = yield* repo.findChannel(channel.id);
      yield* chat.sendPrompt(channel.id, "again");
      yield* settled;

      return {
        messages: yield* repo.listMessages(channel.id),
        channelAfterFirst: afterFirst,
        channelAfterSecond: yield* repo.findChannel(channel.id),
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "hello", "complete"],
      ["assistant", "Echo: hello", "complete"],
      ["user", "again", "complete"],
      ["assistant", "Echo: again", "complete"],
    ]);
    const firstSession = Option.getOrUndefined(result.channelAfterFirst);
    const secondSession = Option.getOrUndefined(result.channelAfterSecond);
    expect(firstSession?.title).toBe("hello");
    expect(firstSession?.sessions).toMatchObject([
      { runtime: "claude-code", sessionId: expect.stringMatching(/^fake-/) },
    ]);
    expect(secondSession?.sessions[0]?.sessionId).toBe(firstSession?.sessions[0]?.sessionId);
  });

  it("lists a channel as active while its turn runs and drops it once the turn ends", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const channel = yield* chat.createChannel(HOB_ID);

      yield* chat.sendPrompt(channel.id, "hello");
      const during = yield* chat.activeChannels;
      yield* repo.listMessages(channel.id).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      // The turn's fiber leaves the map just after it saves the final message.
      const after = yield* chat.activeChannels.pipe(
        Effect.flatMap((ids) => (ids.length > 0 ? Effect.fail("active" as const) : Effect.succeed(ids))),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      return { channelId: channel.id, during, after };
    }).pipe(Effect.provide(testLayer(FakeRuntimeLayer({ delay: "20 millis" }))), Effect.scoped, Effect.runPromise);

    expect(result.during).toEqual([result.channelId]);
    expect(result.after).toEqual([]);
  });
});

describe("a reply that ends early", () => {
  /** Waits until the channel's latest reply has ended, however it ended, and nothing waits behind it. */
  const settled = (channelId: ChannelId) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const messages = yield* repo.listMessages(channelId);
      const reply = messages.at(-1);
      return reply?.role !== "assistant" || isInProgress(reply.status) || messages.some((m) => m.status === "queued")
        ? yield* Effect.fail("busy" as const)
        : reply;
    }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  const replyTo = (channelId: ChannelId, prompt: string) =>
    Effect.gen(function* () {
      yield* (yield* ChatService).sendPrompt(channelId, prompt);
      return yield* settled(channelId);
    });
  // A reply is saved as ended a moment before its turn lets go of the channel.
  const continueSoon = (channelId: ChannelId, messageId: MessageId) =>
    Effect.gen(function* () {
      return yield* (yield* ChatService).continueReply(channelId, messageId);
    }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }));

  it("keeps a cut-off reply with its reason, and Continue resumes it in the same message", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const channel = yield* chat.createChannel(HOB_ID);
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const resumed = yield* continueSoon(channel.id, cut.id);
      const finished = yield* settled(channel.id);
      const again = yield* chat.continueReply(channel.id, cut.id).pipe(Effect.flip);
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

  // covers ADR 017; regression for #398
  it("keeps each reply's latency and token usage next to its runtime and model (#398)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const channel = yield* chat.createChannel(HOB_ID);
      yield* replyTo(channel.id, "hello");
      yield* replyTo(channel.id, "again");
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      return { stored: yield* repo.listMessages(channel.id), cut };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const [first, second] = result.stored.filter((m) => m.role === "assistant");
    // The fake reports a quarter token a character, and a cache its session's first turn writes.
    expect(first).toMatchObject({
      runtime: "claude-code",
      usage: {
        timeToRequestMs: 5,
        timeToFirstStreamMs: 15,
        timeToFirstTokenMs: 20,
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 1000,
      },
    });
    // The resumed session reads what the first turn wrote.
    expect(second?.usage).toMatchObject({ cacheReadTokens: 1000, cacheWriteTokens: 0 });
    // A turn that ends without a result reports nothing.
    expect(result.cut.usage).toBeNull();
    expect(result.stored.find((m) => m.role === "user")?.usage).toBeNull();
  });

  it("stores the configuration a continued reply runs on, after the hob was edited", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const channel = yield* chat.createChannel(HOB_ID);
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const hob = Option.getOrThrow(yield* repo.findAgent(HOB_ID));
      yield* repo.updateAgentConfig(
        new Agent({ ...hob, instructions: "Be brief.", configVersion: hob.configVersion + 1 }),
      );
      const resumed = yield* continueSoon(channel.id, cut.id);
      yield* settled(channel.id);
      const stored = (yield* repo.listMessages(channel.id)).find((m) => m.id === cut.id);
      return { cut, resumed, stored };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cut.configVersion).toBe(1);
    expect(result.resumed.configVersion).toBe(2);
    expect(result.stored?.configVersion).toBe(2);
  });

  it("marks a reply the provider limit ended with when the allowance refills", async () => {
    const limited = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const channel = yield* chat.createChannel(HOB_ID);
      return yield* replyTo(channel.id, `${FAKE_DIRECTIVES.limit} please`);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(limited.status).toBe("limited");
    expect(limited.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(limited.content.length).toBeGreaterThan(0);
  });

  it("continues only the channel's latest reply", async () => {
    const error = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const channel = yield* chat.createChannel(HOB_ID);
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      yield* replyTo(channel.id, "next");
      return yield* chat.continueReply(channel.id, cut.id).pipe(Effect.flip);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);
    expect(error._tag).toBe("ReplyNotResumable");
  });

  // covers ADR 039 (Reply threads)
  it("continues the main line's latest reply past a reply only in a thread (#1484)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const channel = yield* chat.createChannel(HOB_ID);
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      // You reply in the thread of an earlier message, beside the main line, not after it.
      const [asked] = yield* repo.listMessages(channel.id);
      yield* repo.upsertMessage(
        new Message({
          ...cut,
          id: MessageId.make("aside"),
          actor: OWNER_ACTOR,
          role: "user",
          content: "An aside",
          status: "complete",
          error: null,
          rootMessageId: asked?.id ?? null,
          createdAt: new Date(Date.parse(cut.createdAt) + 1000).toISOString(),
        }),
      );
      const resumed = yield* continueSoon(channel.id, cut.id);
      // The resumed reply ends before the test lets go of the hub.
      yield* repo.findMessage(cut.id).pipe(
        Effect.flatMap((found) =>
          Option.isSome(found) && !isInProgress(found.value.status) ? Effect.void : Effect.fail("busy" as const),
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      return { cut, resumed };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);
    expect(result.resumed).toMatchObject({ id: result.cut.id, status: "streaming" });
  });

  // covers ADR 039 (A member hob works as itself)
  it("refuses to continue a reply by a hob that is not in the camp, as one moved here from another camp (#1461)", async () => {
    const error = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const rook = AgentId.make("rook");
      const aldric = Option.getOrThrow(yield* repo.findAgent(HOB_ID));
      yield* repo.insertAgent(new Agent({ ...aldric, id: rook, name: "Rook", configVersion: 1 }));
      const channel = yield* chat.createChannel(HOB_ID);
      const cut = yield* replyTo(channel.id, `${FAKE_DIRECTIVES.cutOff} please`);
      // Rook wrote it in a camp of its own, and the chapter moved here, where Rook is no member.
      const moved = new Message({
        ...cut,
        id: MessageId.make("moved-reply"),
        actor: { kind: "hob", id: rook },
        createdAt: new Date(Date.parse(cut.createdAt) + 1000).toISOString(),
      });
      yield* repo.upsertMessage(moved);
      return yield* continueSoon(channel.id, moved.id).pipe(Effect.flip);
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
          commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
        }),
    }),
  );

  it("saves each tool call as a step of the reply, a refused one with its reason, and journals every change", async () => {
    const { stored, journaled } = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const bus = yield* EventBus;
      const repo = yield* HobbotsRepository;
      const subscription = yield* bus.subscribe;
      const channel = yield* chat.createChannel(HOB_ID);
      yield* chat.sendPrompt(
        channel.id,
        `Fix it\nfake:tool Edit ${join(folder, "a.ts")}\nfake:tool Bash pnpm test\nfake:tool Write ${join(root, "outside.txt")}`,
      );
      const reply = yield* repo.listMessages(channel.id).pipe(
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
        startedAt: expect.any(String),
        call: { tool: "Edit", operation: "edit-files", targets: [join(folder, "a.ts")] },
      },
      {
        id: "fake-tool-2",
        kind: "tool",
        label: "Running pnpm test",
        state: "done",
        startedAt: expect.any(String),
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

  it("offers the hub's Charm tools beside the Task tools, with the hob's access read at each call", async () => {
    const seen: Array<ReadonlyArray<string> | null> = [];
    const charms = Layer.succeed(
      Charms,
      Charms.of({
        charms: [],
        forTurn: (turn) =>
          Effect.succeed([
            {
              owner: "the GitHub Charm",
              tools: {
                tools: [
                  {
                    name: "github_search",
                    description: "Search",
                    inputSchema: { type: "object" },
                    label: "Searching GitHub",
                  },
                ],
                call: (name, input) =>
                  turn.currentAccess.pipe(
                    Effect.map((access) => {
                      seen.push(access?.folders ?? null);
                      return { text: `${name} read ${JSON.stringify(input)}`, refused: false };
                    }),
                  ),
              },
            },
          ]),
      }),
    );
    const reply = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const channel = yield* chat.createChannel(HOB_ID);
      // The reply repeats the Charm's answer, so the test reads it in the turn that made the call (#1560).
      yield* chat.sendPrompt(
        channel.id,
        `How many issues?\nfake:hub github_search {"kind":"issue"}\n${FAKE_SAY_ANSWERS_DIRECTIVE}`,
      );
      return yield* repo.listMessages(channel.id).pipe(
        Effect.flatMap((messages) => {
          const last = messages.at(-1);
          return last?.role === "assistant" && !isInProgress(last.status) ? Effect.succeed(last) : Effect.fail("busy");
        }),
        Effect.retry(Schedule.spaced("5 millis")),
      );
    }).pipe(
      Effect.provide(testLayer(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)), Layer.merge(tools, charms))),
      Effect.scoped,
      Effect.runPromise,
    );
    expect(reply.content).toContain('github_search: github_search read {"kind":"issue"}');
    expect(reply.steps.map((step) => step.label)).toContain("Searching GitHub");
    expect(seen).toEqual([[folder]]);
  });

  it("stops a running turn once its hob's policy narrows, and keeps it when the policy widens", async () => {
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
            commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
          })),
      }),
    );
    const statusAfter = (change: () => void) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const channel = yield* chat.createChannel(HOB_ID);
        yield* chat.sendPrompt(channel.id, "one two three four five six seven eight nine ten");
        const reply = repo.listMessages(channel.id).pipe(Effect.map((messages) => messages.at(-1)));
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
    // Search the web set to Never stops the turn that could search (ADR 036); allowed again, it goes on.
    hob = EMPTY_HOB_POLICY;
    expect(await statusAfter(() => (hob = { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } }))).toBe(
      "interrupted",
    );
    expect(await statusAfter(() => (hob = EMPTY_HOB_POLICY))).toBe("streaming");
  });

  // covers ADR 031
  it("stops a running turn once its hob loses a Charm, and keeps it when the hob gains one", async () => {
    let hob: ToolAccess["policy"]["hob"] = { ...EMPTY_HOB_POLICY, charms: { granted: ["github"] } };
    const changing = Layer.succeed(
      HobTools,
      HobTools.of({
        access: () =>
          Effect.sync(() => ({
            policy: {
              preset: "balanced" as const,
              sharedFolders: [folder],
              hob,
              dataFolder: join(root, "data"),
              restrictions: [],
            },
            folders: [folder],
            runtimeFolder: join(root, "runtimes", HOB_ID),
            commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
          })),
      }),
    );
    const statusAfter = (granted: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const channel = yield* chat.createChannel(HOB_ID);
        yield* chat.sendPrompt(channel.id, "one two three four five six seven eight nine ten");
        yield* chat.streamingReplies.pipe(
          Effect.flatMap((replies) => (replies.some((m) => m.content !== "") ? Effect.void : Effect.fail("waiting"))),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        hob = { ...EMPTY_HOB_POLICY, charms: { granted } };
        yield* chat.reviewAuthority(HOB_ID);
        return (yield* repo.listMessages(channel.id)).at(-1)?.status;
      }).pipe(
        Effect.provide(testLayer(FakeRuntimeLayer({ delay: "40 millis" }), changing)),
        Effect.scoped,
        Effect.runPromise,
      );

    // Taking the GitHub Charm away stops the turn, which may already hold its tools.
    expect(await statusAfter([])).toBe("interrupted");
    // Given a Charm, the turn goes on; it is offered from the next turn.
    expect(await statusAfter(["github", "pip"])).toBe("streaming");
  });

  it("stops a turn whose grant was still being read when the policy narrowed", async () => {
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
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
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
        const channel = yield* chat.createChannel(HOB_ID);
        yield* chat.sendPrompt(channel.id, "one two three four five six seven eight nine ten");
        yield* Deferred.await(reading);
        // The narrower policy is saved while the grant still holds the older one.
        restrictions = [{ "edit-files": "deny" }];
        const review = yield* Effect.forkChild(chat.reviewAuthority(HOB_ID));
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(review);
        return (yield* repo.listMessages(channel.id)).at(-1)?.status;
      }).pipe(Effect.provide(testLayer(FakeRuntimeLayer({ delay: "40 millis" }), slow)));
    }).pipe(Effect.scoped, Effect.runPromise);
    expect(status).toBe("interrupted");
  });

  // Issue #1537
  it("stops a running turn once you take over what its command may write, and keeps it when you give it back (#1537)", async () => {
    const docs = join(folder, "docs");
    let taken: ReadonlyArray<string> = [];
    const changing = Layer.succeed(
      HobTools,
      HobTools.of({
        access: () =>
          Effect.sync(() => ({
            policy: {
              preset: "balanced" as const,
              sharedFolders: [folder],
              hob: EMPTY_HOB_POLICY,
              dataFolder: join(root, "data"),
              restrictions: [],
            },
            folders: [folder],
            runtimeFolder: join(root, "runtimes", HOB_ID),
            commitsAs: { _tag: "UserConfig" as const, config: { name: "Ada", email: "ada@example.com" } },
            ...(taken.length === 0 ? {} : { taken }),
          })),
      }),
    );
    // A test run that goes on until its turn ends, and would write the plan without naming it: the
    // reply waits on it, so the turn is running for as long as nothing stops it.
    const testRun = `fake:run ${JSON.stringify({
      command: "pnpm test --watch",
      writes: { "docs/plan.md": "written" },
      background: true,
      outlives: true,
    })}`;
    /** The reply's status once the hub reviewed the running turn after `change`. */
    const statusAfter = (change: () => void) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const channel = yield* chat.createChannel(HOB_ID);
        yield* chat.sendPrompt(channel.id, testRun);
        // The command is running.
        yield* chat.streamingReplies.pipe(
          Effect.flatMap((replies) =>
            replies.some((m) => m.steps.some((step) => step.kind === "tool" && step.state === "running"))
              ? Effect.void
              : Effect.fail("waiting"),
          ),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        change();
        // The turn has ended when review returns, if it stopped it.
        yield* chat.reviewAuthority(HOB_ID);
        return (yield* repo.listMessages(channel.id)).at(-1)?.status;
      }).pipe(
        Effect.provide(testLayer(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)), changing)),
        Effect.scoped,
        Effect.runPromise,
      );

    // Nothing changes: the turn goes on.
    expect(await statusAfter(() => undefined)).toBe("streaming");
    // You take over the folder while its command runs: the turn stops, and its command with it.
    expect(await statusAfter(() => (taken = [docs]))).toBe("interrupted");
    // You give it back: what runs keeps the sandbox it started with, closed, and goes on.
    expect(await statusAfter(() => (taken = []))).toBe("streaming");
  });
});
