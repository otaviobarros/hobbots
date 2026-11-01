import {
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  RuntimeAdapter,
  type RuntimeEvent,
} from "@hobbots/agents";
import { Agent, AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { EventJournal, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Schedule, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import {
  CONNECTION_BUFFER,
  EventStream,
  encodeFrame,
  formatCursor,
  parseCursor,
  resumePoint,
  type StreamFrame,
} from "../src/event-stream.ts";

const HOB_ID = AgentId.make("odo");

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Odo",
      roleTitle: "Scribe",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 3,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

// A runtime the test drives: each turn streams whatever the test offers to `turn`.
const makeHub = Effect.gen(function* () {
  const turn = yield* Queue.unbounded<RuntimeEvent>();
  const runtime = Layer.succeed(
    RuntimeAdapter,
    RuntimeAdapter.of({
      health: Effect.die("unused"),
      models: Effect.die("unused"),
      enforcement: Effect.die("unused"),
      sendPrompt: () => Stream.fromQueue(turn),
    }),
  );
  const layer = EventStream.layer.pipe(
    Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
    Layer.provideMerge(Layer.mergeAll(EventBus.layer, HobAdmission.layer, runtime)),
    Layer.provideMerge(
      Layer.effectDiscard(summonHob).pipe(
        Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer)),
        Layer.provideMerge(TestDatabase),
      ),
    ),
  );
  return { turn, layer };
});

type Services =
  | EventStream
  | ChatService
  | HobbotsRepository
  | EventJournal
  | EventBus
  | HobAdmission
  | SqlClient.SqlClient
  | Scope.Scope;

const run = <A, E>(test: (turn: Queue.Queue<RuntimeEvent>) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const { turn, layer } = yield* makeHub;
    return yield* test(turn).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.runPromise);

// Opens a connection and records its frames until the returned fiber is interrupted (a disconnect).
const connect = (cursor: string | undefined, through?: EventStream["Service"]) =>
  Effect.gen(function* () {
    const events = through ?? (yield* EventStream);
    const frames: Array<StreamFrame> = [];
    const fiber = yield* Stream.runForEach(events.connect(cursor), (frame) =>
      Effect.sync(() => void frames.push(frame)),
    ).pipe(Effect.forkScoped);
    return { frames, fiber };
  });

const waitFor = (check: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("not yet" as const))).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    Effect.orDie,
  );

const entries = (frames: ReadonlyArray<StreamFrame>) =>
  frames.flatMap((frame) => (frame._tag === "Entry" ? [frame.entry] : []));
const deltas = (frames: ReadonlyArray<StreamFrame>) =>
  frames.flatMap((frame) =>
    frame._tag === "Transient" && frame.event._tag === "MessageDelta"
      ? [[frame.event.offset, frame.event.delta] as const]
      : [],
  );
const lastCursor = (frames: ReadonlyArray<StreamFrame>) =>
  frames.flatMap((frame) => (frame._tag === "Ready" || frame._tag === "Entry" ? [frame.cursor] : [])).at(-1);

describe("event stream", () => {
  // covers CH-004
  it("[TC-CH-071] resumes after a cursor: replays exactly the missed entries, the streaming text, then continues live", async () => {
    const result = await run((turn) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const journal = yield* EventJournal;
        const first = yield* connect(undefined);
        yield* waitFor(() => first.frames.length > 0);

        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "hello");
        yield* Queue.offerAll(turn, [
          { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
          { _tag: "TextDelta", text: "Hel" },
        ]);
        yield* waitFor(() => deltas(first.frames).length === 1);
        const cursor = lastCursor(first.frames) ?? "";

        // The client goes away mid-reply; the reply streams on and another thread starts meanwhile.
        yield* Fiber.interrupt(first.fiber);
        yield* Queue.offer(turn, { _tag: "TextDelta", text: "lo" });
        yield* chat.createThread(HOB_ID);
        const missed = yield* journal.readAfter(parseCursor(cursor)?.sequence ?? 0);

        const second = yield* connect(cursor);
        yield* waitFor(() => deltas(second.frames).length === 1);
        yield* Queue.offer(turn, { _tag: "Completed", sessionId: "s1", text: "Hello" });
        yield* waitFor(() =>
          entries(second.frames).some(
            (e) => e.payload._tag === "MessageUpserted" && e.payload.message.status === "complete",
          ),
        );
        return { first: first.frames, second: second.frames, cursor, missed, replyId: assistantMessage?.id };
      }),
    );

    // The first connection started fresh and saw the chunk with its offset.
    expect(result.first[0]).toMatchObject({ _tag: "Ready", resumed: false });
    expect(deltas(result.first)).toEqual([[0, "Hel"]]);
    // The second resumed at the cursor and replayed exactly what it missed, in order.
    expect(result.second[0]).toEqual({ _tag: "Ready", cursor: result.cursor, resumed: true });
    expect(result.missed.length).toBeGreaterThan(0);
    const sent = entries(result.second);
    expect(sent.slice(0, result.missed.length)).toEqual(result.missed);
    // Then the reply's full text at offset 0, then live entries with no gap or repeat.
    expect(deltas(result.second)).toEqual([[0, "Hello"]]);
    const sequences = sent.map((e) => e.sequence);
    const from = parseCursor(result.cursor)?.sequence ?? 0;
    expect(sequences).toEqual(sequences.map((_, index) => from + index + 1));
    // Each entry's frame carries its own cursor as the SSE id.
    for (const frame of result.second) {
      if (frame._tag === "Entry") expect(parseCursor(frame.cursor)?.sequence).toBe(frame.entry.sequence);
    }
  });

  // covers CH-004, PE-002
  it("[TC-CH-110] replays a reply's tool steps to a client that reconnects after they ran", async () => {
    const result = await run((turn) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const first = yield* connect(undefined);
        yield* waitFor(() => first.frames.length > 0);
        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "Fix the cart and run the tests");
        yield* waitFor(() => entries(first.frames).some((e) => e.payload._tag === "MessageUpserted"));
        const cursor = lastCursor(first.frames) ?? "";

        // The client goes away; the hob edits a file and runs the tests meanwhile.
        yield* Fiber.interrupt(first.fiber);
        const call = { operation: "edit-files", targets: ["/work/src/cart.ts"] } as const;
        yield* Queue.offerAll(turn, [
          { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
          { _tag: "ToolStarted", id: "t1", tool: "Edit", ...call, label: "Editing cart.ts" },
          { _tag: "ToolFinished", id: "t1", failed: false },
          {
            _tag: "ToolStarted",
            id: "t2",
            tool: "Bash",
            operation: "run-commands",
            targets: ["/work"],
            label: "Running pnpm test",
          },
          { _tag: "ToolFinished", id: "t2", failed: true },
          { _tag: "Completed", sessionId: "s1", text: "Fixed; one test still fails." },
        ]);
        const repo = yield* HobbotsRepository;
        yield* repo.listMessages(thread.id).pipe(
          Effect.flatMap((messages) => (messages.at(-1)?.status === "complete" ? Effect.void : Effect.fail("busy"))),
          Effect.retry(Schedule.spaced("5 millis")),
        );

        const second = yield* connect(cursor);
        yield* waitFor(() =>
          entries(second.frames).some(
            (e) => e.payload._tag === "MessageUpserted" && e.payload.message.status === "complete",
          ),
        );
        return { second: second.frames, replyId: assistantMessage?.id };
      }),
    );

    const replayed = entries(result.second).flatMap((e) =>
      e.payload._tag === "MessageUpserted" && e.payload.message.id === result.replyId ? [e.payload.message] : [],
    );
    expect(replayed.at(-1)?.steps.map((step) => [step.label, step.state])).toEqual([
      ["Editing cart.ts", "done"],
      ["Running pnpm test", "failed"],
    ]);
  });

  // covers CH-004, CH-007
  it("[TC-CH-114] keeps a tool step cut off by an interruption unfinished when Continue resumes the reply", async () => {
    const steps = await run((turn) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "Run the tests");
        const reply = repo.listMessages(thread.id).pipe(Effect.map((messages) => messages.at(-1)));
        const until = (check: (status: string | undefined) => boolean) =>
          reply.pipe(
            Effect.flatMap((m) => (check(m?.status) && m?.steps.length ? Effect.succeed(m) : Effect.fail("busy"))),
            Effect.retry(Schedule.spaced("5 millis")),
          );
        const tests = {
          tool: "Bash",
          operation: "run-commands",
          targets: ["/work"],
          label: "Running pnpm test",
        } as const;
        yield* Queue.offerAll(turn, [
          { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
          { _tag: "TextDelta", text: "Running" },
          { _tag: "ToolStarted", id: "t1", ...tests },
        ]);
        yield* until((status) => status === "streaming");
        // Hobbots ends the turn mid-tool, as a pause or restart does.
        yield* chat.interruptAgent(HOB_ID);
        const interrupted = yield* until((status) => status === "interrupted");

        // The thread is free once the ended turn's drain has run.
        yield* chat
          .continueReply(thread.id, assistantMessage?.id ?? MessageId.make(""))
          .pipe(Effect.retry(Schedule.spaced("5 millis")));
        yield* Queue.offerAll(turn, [
          { _tag: "ToolStarted", id: "t1", ...tests },
          { _tag: "ToolFinished", id: "t1", failed: false },
          { _tag: "Completed", sessionId: "s1", text: " done." },
        ]);
        const completed = yield* until((status) => status === "complete");
        return { interrupted: interrupted.steps, completed: completed.steps };
      }),
    );

    expect(steps.interrupted.map((step) => [step.id, step.state])).toEqual([["t1", "unfinished"]]);
    expect(steps.completed.map((step) => [step.id, step.state])).toEqual([
      ["t1", "unfinished"],
      ["t1@1", "done"],
    ]);
  });

  // covers CH-004
  it("[TC-CH-072] starts fresh at the head for a missing, malformed, foreign or future cursor", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const journal = yield* EventJournal;
        yield* chat.createThread(HOB_ID);
        const head = yield* journal.head;
        const readies: Array<StreamFrame | undefined> = [];
        for (const cursor of [
          undefined,
          "garbage",
          formatCursor("another-epoch", 1),
          formatCursor(head.epoch, head.sequence + 5),
        ]) {
          const connection = yield* connect(cursor);
          yield* waitFor(() => connection.frames.length > 0);
          yield* Fiber.interrupt(connection.fiber);
          readies.push(connection.frames[0]);
        }
        return { readies, head };
      }),
    );
    for (const ready of result.readies) {
      expect(ready).toEqual({
        _tag: "Ready",
        cursor: formatCursor(result.head.epoch, result.head.sequence),
        resumed: false,
      });
    }
  });

  // covers CH-004, DP-003
  it("[TC-CH-073] reads entries the bus never announced from the journal, in order", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const chat = yield* ChatService;
        const connection = yield* connect(undefined);
        yield* waitFor(() => connection.frames.length > 0);
        // Committed but never published, as when the process dies between commit and publish.
        const now = "2026-01-02T00:00:00.000Z";
        const silent = yield* repo.upsertThread(
          new Thread({
            id: ThreadId.make("silent"),
            agentId: HOB_ID,
            title: "Quiet",
            createdAt: now,
            updatedAt: now,
          }),
        );
        const announced = yield* chat.createThread(HOB_ID);
        yield* waitFor(() => entries(connection.frames).length === 2);
        return { frames: connection.frames, silent: silent.entries, announced };
      }),
    );
    const sent = entries(result.frames);
    expect(sent[0]).toEqual(result.silent[0]);
    expect(sent[1]?.payload).toMatchObject({ _tag: "ThreadUpserted", thread: { id: result.announced.id } });
    expect(sent[1]?.sequence).toBe((sent[0]?.sequence ?? 0) + 1);
  });

  // covers CH-004
  it("[TC-CH-074] ends a connection whose client falls more than the buffer behind, while the client still is not reading", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const events = yield* EventStream;
        const bus = yield* EventBus;
        const reading = yield* Deferred.make<void>();
        // The client reads Ready, then stops reading for good, as a stalled socket would.
        const fiber = yield* events.connect(undefined).pipe(
          Stream.runForEach(() => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))),
          Effect.forkScoped,
        );
        yield* Deferred.await(reading);
        let published = 0;
        while (fiber.pollUnsafe() === undefined && published < 3 * CONNECTION_BUFFER) {
          yield* bus.publishTransient({
            _tag: "MessageDelta",
            threadId: ThreadId.make("t"),
            messageId: MessageId.make("m"),
            offset: published++,
            delta: "x",
          });
          // Publishers yield on their writes; let the connection take each event as it would.
          yield* Effect.yieldNow;
        }
        return { exit: yield* Fiber.await(fiber), published };
      }),
    );
    // The connection ended (releasing its subscription) once the buffer overflowed, without the
    // client draining it; the client resumes from its cursor.
    expect(Exit.hasInterrupts(result.exit)).toBe(true);
    expect(result.published).toBeGreaterThan(CONNECTION_BUFFER);
    expect(result.published).toBeLessThan(3 * CONNECTION_BUFFER);
  });
});

describe("reliable chat (#118)", () => {
  // covers CH-004, DP-003
  it("[TC-CH-124] starts fresh for a cursor whose entries compaction removed, and still replays one right before the oldest kept", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const journal = yield* EventJournal;
        const sql = yield* SqlClient.SqlClient;
        const expired = (yield* journal.head).sequence;
        for (let i = 0; i < 3; i++) yield* chat.createThread(HOB_ID);
        // Compaction keeps the latest entries; here the client's cursor and the one after it are gone.
        yield* sql`DELETE FROM event_journal WHERE sequence <= ${expired + 1}`;
        const head = yield* journal.head;
        const oldest = (yield* journal.oldest) ?? 0;
        const readies: Array<StreamFrame | undefined> = [];
        const replayed: Array<ReadonlyArray<number>> = [];
        for (const cursor of [formatCursor(head.epoch, expired), formatCursor(head.epoch, oldest - 1)]) {
          const connection = yield* connect(cursor);
          yield* waitFor(() => connection.frames.length > 0);
          // Entries the connection replays arrive right after Ready.
          yield* Effect.sleep("20 millis");
          yield* Fiber.interrupt(connection.fiber);
          readies.push(connection.frames[0]);
          replayed.push(entries(connection.frames).map((e) => e.sequence));
        }
        return { readies, replayed, head, oldest };
      }),
    );
    const { readies, replayed, head, oldest } = result;
    // The expired cursor gets a fresh Ready at the head and no partial replay, so the client fetches again.
    expect(readies[0]).toEqual({ _tag: "Ready", cursor: formatCursor(head.epoch, head.sequence), resumed: false });
    expect(replayed[0]).toEqual([]);
    // A cursor whose next entry is the oldest kept still replays every entry after it.
    expect(readies[1]).toEqual({ _tag: "Ready", cursor: formatCursor(head.epoch, oldest - 1), resumed: true });
    expect(replayed[1]).toEqual(Array.from({ length: head.sequence - oldest + 1 }, (_, i) => oldest + i));
  });

  // covers CH-004, DP-003
  it("[TC-CH-125] after a crash mid-reply, a client resuming from before the crash gets each missed entry once, ending with the reply interrupted", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        const before = yield* connect(undefined);
        yield* waitFor(() => before.frames.length > 0);
        const cursor = lastCursor(before.frames) ?? "";
        yield* Fiber.interrupt(before.fiber);

        // What a hub that dies mid-reply leaves behind: the prompt, and a reply still streaming
        // with the text it last checkpointed. Each write was journaled as it happened.
        const now = "2026-01-02T00:00:00.000Z";
        const threadId = ThreadId.make("crashed");
        yield* repo.upsertThread(
          new Thread({
            id: threadId,
            agentId: HOB_ID,
            title: "Crash",
            createdAt: now,
            updatedAt: now,
          }),
        );
        const message = (id: string, role: "user" | "assistant", content: string, status: Message["status"]) =>
          new Message({
            id: MessageId.make(id),
            threadId,
            role,
            content,
            status,
            error: null,
            configVersion: role === "assistant" ? 1 : null,
            createdAt: now,
          });
        yield* repo.upsertMessage(message("prompt", "user", "Tell me a story", "complete"));
        yield* repo.upsertMessage(message("reply", "assistant", "Once upon", "streaming"));

        // The hub starts again over the same database and recovers the reply. A new memo map builds
        // new services instead of handing back the running hub's.
        const restarted = yield* Layer.buildWithMemoMap(
          EventStream.layer.pipe(
            Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
            Layer.provideMerge(
              Layer.mergeAll(
                EventBus.layer,
                Layer.succeed(
                  RuntimeAdapter,
                  RuntimeAdapter.of({
                    health: Effect.die("unused"),
                    models: Effect.die("unused"),
                    enforcement: Effect.die("unused"),
                    sendPrompt: () => Stream.never,
                  }),
                ),
              ),
            ),
          ),
          yield* Layer.makeMemoMap,
          yield* Effect.scope,
        );
        const missed = yield* journal.readAfter(parseCursor(cursor)?.sequence ?? 0);
        const after = yield* connect(cursor, Context.get(restarted, EventStream));
        yield* waitFor(() => entries(after.frames).length === missed.length);
        yield* Effect.sleep("20 millis");
        return { cursor, missed, frames: after.frames, messages: yield* repo.listMessages(threadId) };
      }),
    );
    const { cursor, missed, frames, messages } = result;
    expect(frames[0]).toEqual({ _tag: "Ready", cursor, resumed: true });
    const sent = entries(frames);
    // Exactly the entries after the cursor, each once, in order, with nothing streaming afterwards.
    expect(sent).toEqual(missed);
    const from = parseCursor(cursor)?.sequence ?? 0;
    expect(sent.map((e) => e.sequence)).toEqual(sent.map((_, index) => from + index + 1));
    expect(deltas(frames)).toEqual([]);
    const replyStates = sent.flatMap((e) =>
      e.payload._tag === "MessageUpserted" && e.payload.message.id === "reply"
        ? [[e.payload.message.status, e.payload.message.content]]
        : [],
    );
    expect(replyStates).toEqual([
      ["streaming", "Once upon"],
      ["interrupted", "Once upon"],
    ]);
    expect(messages.map((m) => [m.id, m.status])).toEqual([
      ["prompt", "complete"],
      ["reply", "interrupted"],
    ]);
  });
});

describe("cursors", () => {
  const head = { epoch: "e", sequence: 20 };

  it("resumes only when every entry after the cursor is still in this epoch's journal", () => {
    expect(resumePoint("e.20", head, 1)).toBe(20);
    expect(resumePoint("e.5", head, 6)).toBe(5);
    expect(resumePoint("e.4", head, 6)).toBeNull();
    expect(resumePoint("e.21", head, 1)).toBeNull();
    expect(resumePoint("f.5", head, 1)).toBeNull();
    expect(resumePoint("e.x", head, 1)).toBeNull();
    expect(resumePoint(undefined, head, 1)).toBeNull();
    expect(resumePoint("e.0", { epoch: "e", sequence: 0 }, null)).toBe(0);
  });

  it("writes SSE frames with an id only for Ready and journal entries", () => {
    expect(encodeFrame({ _tag: "Ready", cursor: "e.3", resumed: true })).toBe(
      'id: e.3\nevent: ready\ndata: {"cursor":"e.3","resumed":true}\n\n',
    );
    expect(
      encodeFrame({
        _tag: "Transient",
        event: {
          _tag: "MessageDelta",
          threadId: ThreadId.make("t"),
          messageId: MessageId.make("m"),
          offset: 2,
          delta: "a\nb",
        },
      }),
    ).toBe('event: delta\ndata: {"_tag":"MessageDelta","threadId":"t","messageId":"m","offset":2,"delta":"a\\nb"}\n\n');
    expect(encodeFrame({ _tag: "KeepAlive" })).toBe(": keep-alive\n\n");
  });
});
