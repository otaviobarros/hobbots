import { ChatService, HobAdmission, HobbotsRepository, HobLifecycle, HobTools } from "@hobbots/agents";
import { ChannelArchived, ChannelArchiveRefused } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type JournaledEvent,
  type Message,
  OWNER_ACTOR,
  SkillName,
  SkillRevisionHash,
  SkillTrial,
  type ChannelId,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, SearchIndex } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Exit, Layer, Option, Schedule, type Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");

const summonHob = HobbotsRepository.use((repo) =>
  repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ),
);

const testLayer = HobLifecycle.layer.pipe(
  Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(summonHob).pipe(
        Layer.provideMerge(
          Layer.mergeAll(HobbotsRepositoryLive, SearchIndex.layer).pipe(Layer.provideMerge(TestDatabase)),
        ),
      ),
      EventBus.layer,
      HobAdmission.layer,
      // Slow enough that a reply is still running when the channel is archived.
      FakeRuntimeLayer({ delay: "15 millis" }),
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof testLayer> | Scope.Scope>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

// Waits until the channel has no turn running and nothing streaming or queued.
const settled = (channelId: ChannelId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const messages = yield* repo.listMessages(channelId);
    const busy = messages.some((m) => m.status === "streaming" || m.status === "queued");
    if (busy || (yield* chat.activeChannels).includes(channelId)) return yield* Effect.fail("busy" as const);
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));

// A channel with one finished turn, as a channel the user is done with looks.
const finishedChannel = (prompt = "Plan the kettle repair") =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const channel = yield* chat.createChannel(HOB_ID);
    yield* chat.sendPrompt(channel.id, prompt);
    yield* settled(channel.id);
    return yield* HobbotsRepository.use((repo) => repo.findChannel(channel.id)).pipe(Effect.map(Option.getOrThrow));
  });

// Records the channel events published from here on.
/** What `pick` takes from every entry the bus journals from now on. */
const recordJournaled = <A>(pick: (payload: JournaledEvent) => A | undefined) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const picked: Array<A> = [];
    yield* bus.stream.pipe(
      Stream.runForEach((published) =>
        Effect.sync(() => {
          const value = published._tag === "Journaled" ? pick(published.entry.payload) : undefined;
          if (value !== undefined) picked.push(value);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return picked;
  });

const recordChannelEvents = recordJournaled((payload) =>
  payload._tag === "ChannelUpserted" ? payload.channel : undefined,
);

/** Every member change (ADR 039). */
const recordMemberEvents = recordJournaled((payload) =>
  payload._tag === "ChannelMemberChanged" ? payload.member : undefined,
);

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined;

describe("archived channels", () => {
  it("archives and restores a channel once each, durably and live, without moving it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const channel = yield* finishedChannel();
        const events = yield* recordChannelEvents;

        const archived = yield* chat.archive(channel.id);
        const again = yield* chat.archive(channel.id);
        const lists = {
          live: (yield* repo.listChannels(HOB_ID)).map((t) => t.id),
          archived: (yield* repo.listArchivedChannels(HOB_ID)).map((t) => t.id),
        };
        const restored = yield* chat.restore(channel.id);
        const restoredAgain = yield* chat.restore(channel.id);
        yield* Effect.yieldNow;
        return {
          channel,
          archived,
          again,
          lists,
          restored,
          restoredAgain,
          liveAfter: (yield* repo.listChannels(HOB_ID)).map((t) => t.id),
          archivedAfter: yield* repo.listArchivedChannels(HOB_ID),
          events: events.map((t) => t.archivedAt !== null),
        };
      }),
    );

    expect(result.channel.archivedAt).toBeNull();
    expect(result.archived.archivedAt).not.toBeNull();
    expect(result.archived.updatedAt).toBe(result.channel.updatedAt);
    expect(result.again).toEqual(result.archived);
    expect(result.lists).toEqual({ live: [], archived: [result.channel.id] });
    expect(result.restored.archivedAt).toBeNull();
    expect(result.restored.updatedAt).toBe(result.channel.updatedAt);
    expect(result.restoredAgain).toEqual(result.restored);
    expect(result.liveAfter).toEqual([result.channel.id]);
    expect(result.archivedAfter).toEqual([]);
    // One journaled change each; the repeats change nothing.
    expect(result.events).toEqual([true, false]);
  });

  it("lists a hob's archived channels newest-archived first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const first = yield* finishedChannel("first");
        const second = yield* finishedChannel("second");
        yield* chat.archive(second.id);
        yield* Effect.sleep("2 millis");
        yield* chat.archive(first.id);
        const archived = yield* HobbotsRepository.use((repo) => repo.listArchivedChannels(HOB_ID));
        return { order: archived.map((t) => t.id), expected: [first.id, second.id] };
      }),
    );
    expect(result.order).toEqual(result.expected);
  });

  it("refuses to archive while a reply runs or a message waits, then archives once it ends", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const lifecycle = yield* HobLifecycle;
        const channel = yield* chat.createChannel(HOB_ID);

        yield* chat.sendPrompt(channel.id, "one");
        const running = yield* Effect.exit(chat.archive(channel.id));
        yield* settled(channel.id);

        // A paused hob keeps the message waiting in the queue.
        yield* lifecycle.pause(HOB_ID);
        yield* chat.sendPrompt(channel.id, "two");
        const queued = yield* Effect.exit(chat.archive(channel.id));
        yield* lifecycle.wake(HOB_ID);
        yield* settled(channel.id);

        const archived = yield* chat.archive(channel.id);
        return { running: refusal(running), queued: refusal(queued), archived };
      }),
    );
    expect(result.running).toEqual(new ChannelArchiveRefused({ channelId: result.archived.id, reason: "reply-running" }));
    expect(result.queued).toEqual(new ChannelArchiveRefused({ channelId: result.archived.id, reason: "reply-running" }));
    expect(result.archived.archivedAt).not.toBeNull();
  });

  it("takes no new message, Continue or brain switch in an archived channel until it is restored", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const channel = yield* finishedChannel();
        const archived = yield* chat.archive(channel.id);
        const reply = (yield* repo.listMessages(channel.id)).at(-1) as Message;
        const sent = yield* Effect.exit(chat.sendPrompt(channel.id, "more"));
        const continued = yield* Effect.exit(chat.continueReply(channel.id, reply.id));
        const switched = yield* Effect.exit(
          chat.setBrain(channel.id, { runtime: "claude-code", model: "fable", effort: null }),
        );
        const before = (yield* repo.listMessages(channel.id)).length;
        yield* chat.restore(channel.id);
        yield* chat.sendPrompt(channel.id, "more");
        yield* settled(channel.id);
        return {
          archived,
          refusals: [sent, continued, switched].map(refusal),
          before,
          after: (yield* repo.listMessages(channel.id)).length,
        };
      }),
    );
    const expected = new ChannelArchived({ channelId: result.archived.id, archivedAt: result.archived.archivedAt ?? "" });
    expect(result.refusals).toEqual([expected, expected, expected]);
    expect(result.before).toBe(2);
    expect(result.after).toBe(4);
  });

  it("keeps a retired hob's archived channels as they are, and refuses to archive or restore them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const lifecycle = yield* HobLifecycle;
        const archived = yield* chat.archive((yield* finishedChannel("old")).id);
        const live = yield* finishedChannel("current");
        yield* lifecycle.retire(HOB_ID, "finish");
        const repo = yield* HobbotsRepository;
        return {
          archived,
          stored: yield* repo.findChannel(archived.id),
          liveIds: (yield* repo.listChannels(HOB_ID)).map((t) => t.id),
          live,
          restore: refusal(yield* Effect.exit(chat.restore(archived.id))),
          archive: refusal(yield* Effect.exit(chat.archive(live.id))),
          archivedAgain: yield* chat.archive(archived.id),
        };
      }),
    );
    expect(Option.getOrNull(result.stored)).toEqual(result.archived);
    expect(result.liveIds).toEqual([result.live.id]);
    expect(result.restore).toEqual(new ChannelArchiveRefused({ channelId: result.archived.id, reason: "hob-retired" }));
    expect(result.archive).toEqual(new ChannelArchiveRefused({ channelId: result.live.id, reason: "hob-retired" }));
    expect(result.archivedAgain).toEqual(result.archived);
  });

  it("still finds an archived channel by search, marked archived", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const archived = yield* chat.archive((yield* finishedChannel("Plan the kettle repair")).id);
        const hits = yield* SearchIndex.use((index) => index.search("kettle"));
        return { archived, hits: hits.map((hit) => [hit.channel.id, hit.channel.archivedAt]) };
      }),
    );
    expect(result.hits).toEqual([[result.archived.id, result.archived.archivedAt]]);
  });
});

describe("renamed and pinned channels", () => {
  it("renames and pins a channel durably and live, without moving it by last activity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const older = yield* finishedChannel("Plan the kettle repair");
        const newer = yield* finishedChannel("Draft the release notes");
        const events = yield* recordChannelEvents;

        const renamed = yield* chat.rename(older.id, "Kettle repair");
        const renamedAgain = yield* chat.rename(older.id, "Kettle repair");
        const pinned = yield* chat.setPinned(older.id, true);
        const pinnedAgain = yield* chat.setPinned(older.id, true);
        const stored = yield* repo.findChannel(older.id);
        const order = (yield* repo.listChannels(HOB_ID)).map((t) => t.id);
        const unpinned = yield* chat.setPinned(older.id, false);
        yield* Effect.yieldNow;
        return {
          older,
          newer,
          renamed,
          renamedAgain,
          pinned,
          pinnedAgain,
          stored,
          order,
          unpinned,
          events: events.map((t) => [t.title, t.pinnedAt !== null]),
        };
      }),
    );
    expect(result.renamed.title).toBe("Kettle repair");
    expect(result.renamed.updatedAt).toBe(result.older.updatedAt);
    expect(result.renamedAgain).toEqual(result.renamed);
    expect(result.pinned.pinnedAt).not.toBeNull();
    expect(result.pinned.updatedAt).toBe(result.older.updatedAt);
    expect(result.pinnedAgain).toEqual(result.pinned);
    expect(Option.getOrNull(result.stored)).toEqual(result.pinned);
    expect(result.order).toEqual([result.newer.id, result.older.id]);
    expect(result.unpinned.pinnedAt).toBeNull();
    expect(result.events).toEqual([
      ["Kettle repair", false],
      ["Kettle repair", true],
      ["Kettle repair", false],
    ]);
  });

  it("refuses to rename or pin an archived channel", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const archived = yield* chat.archive((yield* finishedChannel()).id);
        return {
          archived,
          rename: refusal(yield* Effect.exit(chat.rename(archived.id, "Kettle repair"))),
          pin: refusal(yield* Effect.exit(chat.setPinned(archived.id, true))),
        };
      }),
    );
    const refused = new ChannelArchived({ channelId: result.archived.id, archivedAt: result.archived.archivedAt ?? "" });
    expect(result.rename).toEqual(refused);
    expect(result.pin).toEqual(refused);
  });
});

describe("read channels", () => {
  it("marks a channel read for every device once you read the hob's reply, and unread again when it writes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const unread = (channelId: ChannelId) =>
          chat.unreadChannels.pipe(Effect.map((listed) => listed.channelIds.includes(channelId)));
        const channel = yield* finishedChannel("Plan the kettle repair");
        const before = yield* unread(channel.id);
        const reply = (yield* repo.listMessages(channel.id)).at(-1);
        if (reply === undefined) throw new Error("no reply");
        const events = yield* recordMemberEvents;
        const read = yield* chat.markRead(channel.id, reply.id, reply.revision);
        const afterRead = yield* unread(channel.id);
        const readAgain = yield* chat.markRead(channel.id, reply.id, reply.revision);
        yield* chat.sendPrompt(channel.id, "And the lid?");
        yield* settled(channel.id);
        const written = yield* unread(channel.id);
        const missing = yield* Effect.exit(chat.markRead("nope" as ChannelId, reply.id, reply.revision));
        yield* Effect.yieldNow;
        return {
          before,
          read,
          afterRead,
          readAgain,
          written,
          missing: Exit.isFailure(missing),
          events: events.filter((member) => member.channelId === channel.id),
        };
      }),
    );
    expect(result.before).toBe(true);
    // Your own member row moves: the owner's, since no device asked.
    expect(result.read).toMatchObject({ actor: OWNER_ACTOR, role: "owner" });
    expect(result.read?.readRevision).toBeGreaterThan(0);
    expect(result.afterRead).toBe(false);
    expect(result.readAgain).toBeNull();
    expect(result.written).toBe(true);
    expect(result.missing).toBe(true);
    // The read goes out to every device; reading the same message again sends nothing.
    expect(result.events).toEqual([result.read]);
  });

  it("gives a hob one open chat, and brings an archived chat back as a camp once another opened", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const first = yield* chat.createChannel(HOB_ID);
        const second = yield* chat.createChannel(HOB_ID);
        const trial = yield* chat.createChannel(HOB_ID, {
          title: "Try lamps",
          skillTrial: new SkillTrial({
            name: SkillName.make("lamps"),
            description: "Lights lamps",
            hash: SkillRevisionHash.make("a".repeat(64)),
            skillId: null,
            base: null,
            proposalId: null,
          }),
        });
        // With its chat archived the hob has none open, so its next channel is its chat.
        yield* chat.archive(first.id);
        const next = yield* chat.createChannel(HOB_ID);
        const restored = yield* chat.restore(first.id);
        const open = yield* repo.listChannels(HOB_ID);
        return { first, second, trial, next, restored, chats: open.filter((t) => t.kind === "direct").map((t) => t.id) };
      }),
    );

    expect(result.first).toMatchObject({ kind: "direct", state: "open" });
    expect(result.second).toMatchObject({ kind: "camp", state: "open" });
    expect(result.trial).toMatchObject({ kind: "camp", state: "open" });
    expect(result.next).toMatchObject({ kind: "direct", state: "open" });
    expect(result.restored).toMatchObject({ id: result.first.id, kind: "camp", state: "open", archivedAt: null });
    expect(result.chats).toEqual([result.next.id]);
  });
});
