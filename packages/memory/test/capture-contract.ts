import {
  MemoryCapture,
  MemoryCaptureLog,
  type MemoryCaptureSession,
  MemorySaves,
  MemoryStore,
  type MemoryStoreShape,
  makeRedactor,
  SecretRedaction,
} from "@hobbots/agents";
import {
  AgentId,
  EVENT_SCHEMA_VERSIONS,
  EventEnvelope,
  type JournaledEvent,
  MemoryPath,
  MemorySave,
  type MemorySaveState,
  Message,
  MessageId,
  Quest,
  QuestId,
  type ReplyStep,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Duration, Effect, Layer, Logger, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { makeMemorySavesFake } from "../src/testing.ts";

/**
 * The capture worker's tests (ADR 028, Capture and summaries, When memory is down), run on every
 * engine: the fake and the bundled ai-memory alike, so what they prove holds on the engine the hub
 * runs. The journal and the worker's cursor are kept in the test, as the hub's database keeps them.
 */
/**
 * The memory under test. It is opened, taken down and brought back on the real clock, as an engine's
 * process runs, while the worker runs on the test clock.
 */
export interface CaptureUnderTest {
  /** The memory under test. Its calls fail while it is down. */
  readonly store: MemoryStoreShape;
  /** How many observations memory keeps of a thread's session in a hob's memory. */
  readonly observations: (agentId: AgentId, threadId: ThreadId) => Effect.Effect<number>;
  /** Takes memory down: the fake stops answering, and ai-memory's engine stops. */
  readonly down: Effect.Effect<void>;
  /** Brings it back on the same data. */
  readonly up: Effect.Effect<void>;
}

const SECRET = "hobbots-test-secret-0123456789abcdef";
const pip = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000a1");
const pipsOwn = { _tag: "Hob", agentId: pip } as const;
const you = { _tag: "You" } as const;
const asPip = { _tag: "Hob", agentId: pip, projects: [] } as const;

/** A `memory_save` of Pip's as the hub records it, made at the test clock's time. */
const recordedSave = (path: MemoryPath, markdown: string, state: MemorySaveState, at: string) =>
  new MemorySave({
    id: crypto.randomUUID(),
    agentId: pip,
    work: "thread:tests",
    key: crypto.randomUUID(),
    input: "input",
    scope: pipsOwn,
    path,
    markdown,
    tags: ["release"],
    state,
    version: null,
    threadId: null,
    messageId: null,
    createdAt: at,
    updatedAt: at,
  });

/** The journal and the worker's record of it, kept in the test. */
const makeJournal = (start: string) => {
  const entries: Array<EventEnvelope> = [];
  let cursor = 0;
  let sessions: Array<MemoryCaptureSession> = [];
  let crashNextSave = false;
  let at = Date.parse(start);
  const append = (payload: JournaledEvent, threadId: ThreadId | null, agentId: AgentId | null = pip) => {
    at += 1_000;
    const entry = new EventEnvelope({
      id: crypto.randomUUID(),
      sequence: entries.length + 1,
      schemaVersion: EVENT_SCHEMA_VERSIONS[payload._tag],
      type: payload._tag,
      occurredAt: new Date(at).toISOString(),
      correlation: { agentId, threadId, messageId: null },
      causationId: null,
      payload,
    });
    entries.push(entry);
    return entry;
  };
  const log = MemoryCaptureLog.of({
    hold: Effect.sync(() => ({ sequence: cursor, sessions })),
    release: Effect.void,
    readAfter: (sequence, limit) =>
      Effect.sync(() => entries.filter((entry) => entry.sequence > sequence).slice(0, limit)),
    save: (sequence, active, ended) =>
      Effect.suspend(() => {
        // A hub that stops between memory's acknowledgement and saving the cursor.
        if (crashNextSave) {
          crashNextSave = false;
          return Effect.die(new Error("The hub stopped before it saved the cursor."));
        }
        const replaced = new Set([...active.map((session) => session.threadId), ...ended]);
        sessions = [...sessions.filter((session) => !replaced.has(session.threadId)), ...active];
        cursor = sequence;
        return Effect.void;
      }),
  });
  return {
    log,
    append,
    cursor: () => cursor,
    sessions: () => sessions,
    crashNextSave: () => {
      crashNextSave = true;
    },
    /** Moves the journal's own clock, so the next entries are committed `duration` later. */
    skip: (duration: Duration.Duration) => {
      at += Duration.toMillis(duration);
    },
  };
};

type Journal = ReturnType<typeof makeJournal>;

const message = (threadId: ThreadId, content: string, fields: Partial<Message> = {}) =>
  new Message({
    id: MessageId.make(crypto.randomUUID()),
    threadId,
    role: "user",
    content,
    status: "complete",
    error: null,
    configVersion: null,
    createdAt: "2026-11-05T12:00:00.000Z",
    ...fields,
  });

const step = (id: string, label: string, output: string): ReplyStep => ({
  id,
  kind: "tool",
  label,
  state: "done",
  call: { tool: "Bash", operation: "run-commands", targets: ["/work/app"] },
  output: { head: output, tail: "", omittedBytes: 0, totalBytes: output.length, logged: false },
});

/** You write in the thread, and the hob answers it on `runtime`, with `steps`. */
const exchange = (
  journal: Journal,
  threadId: ThreadId,
  prompt: string,
  answer: string,
  more: { readonly runtime?: "claude-code" | "codex"; readonly steps?: ReadonlyArray<ReplyStep> } = {},
) => {
  journal.append({ _tag: "MessageUpserted", message: message(threadId, prompt) }, threadId);
  const reply = message(threadId, "", {
    role: "assistant",
    status: "streaming",
    runtime: more.runtime ?? "claude-code",
    steps: more.steps ?? [],
  });
  // A reply is saved while it streams and again when its turn ends; only the end is captured.
  journal.append({ _tag: "MessageUpserted", message: reply }, threadId);
  journal.append(
    { _tag: "MessageUpserted", message: new Message({ ...reply, content: answer, status: "complete" }) },
    threadId,
  );
};

const archive = (journal: Journal, threadId: ThreadId) =>
  journal.append(
    {
      _tag: "ThreadUpserted",
      thread: new Thread({
        id: threadId,
        agentId: pip,
        title: "Tests",
        archivedAt: "2026-11-05T13:00:00.000Z",
        createdAt: "2026-11-05T12:00:00.000Z",
        updatedAt: "2026-11-05T13:00:00.000Z",
      }),
    },
    threadId,
  );

const sessionPage = (threadId: ThreadId) => MemoryPath.make(`sessions/${threadId}.md`);

export const captureContract = (name: string, open: () => Effect.Effect<CaptureUnderTest>) => {
  /**
   * Runs `body` with a worker over `memory` and a journal of its own. The test clock starts at the
   * journal's first entry, so the worker reads the entries as just committed.
   */
  const run = async <A>(
    body: (context: {
      memory: CaptureUnderTest;
      journal: Journal;
      capture: MemoryCapture["Service"];
      saves: ReturnType<typeof makeMemorySavesFake>;
    }) => Effect.Effect<A, unknown, Scope.Scope>,
    clock: "journal" | "now" = "journal",
  ) => {
    const memory = await Effect.runPromise(open());
    return Effect.gen(function* () {
      const start = "2026-11-05T12:00:00.000Z";
      // Saves are compared with the page's time as the engine wrote it, so their tests run at the real time.
      yield* TestClock.setTime(clock === "now" ? Date.now() : Date.parse(start));
      const journal = makeJournal(start);
      const saves = makeMemorySavesFake();
      const context = yield* Layer.build(
        MemoryCapture.make.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(MemoryStore, memory.store),
              Layer.succeed(MemoryCaptureLog, journal.log),
              Layer.succeed(MemorySaves, saves.service),
              Layer.succeed(SecretRedaction, makeRedactor([{ value: SECRET, kind: "TEST_TOKEN" }])),
            ),
          ),
        ),
      );
      return yield* body({ memory, journal, saves, capture: Context.get(context, MemoryCapture) });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise) as Promise<A>;
  };

  /** Moves the test clock past the quiet time, as the hub's clock would move. */
  const quietPassed = TestClock.adjust(Duration.sum(Duration.minutes(31), Duration.seconds(30)));

  describe(`memory capture: ${name}`, () => {
    // covers ADR 028 (Capture and summaries)
    it("[TC-GEN-300] leaves one session page for a thread whichever brains wrote it, and a replay does not duplicate it", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "How do the tests run in this repository?", "With pnpm test, on Vitest.", {
            steps: [step("s1", "Running pnpm test", "42 tests passed")],
          });
          // The thread switches brain (ADR 017): its session goes on.
          exchange(journal, threadId, "And the linter?", "Biome, through pnpm check.", { runtime: "codex" });
          expect(yield* capture.runOnce).toBe(true);
          expect(journal.cursor()).toBe(6);
          // start, two prompts, a tool step and two replies
          expect(yield* memory.observations(pip, threadId)).toBe(6);
          expect(yield* memory.store.page(you, pipsOwn, sessionPage(threadId))).toBeNull();

          yield* quietPassed;
          yield* capture.runOnce;
          const page = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          expect(page?.markdown).toContain("How do the tests run in this repository?");
          expect(page?.markdown).toContain("And the linter?");
          expect(journal.sessions()).toEqual([]);
          const ended = yield* memory.observations(pip, threadId);

          // Every entry sent again, as after a lost cursor, adds nothing.
          const replay = makeJournal("2026-11-05T12:00:00.000Z");
          const replayed = yield* Layer.build(
            MemoryCapture.make.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(MemoryStore, memory.store),
                  Layer.succeed(MemoryCaptureLog, { ...replay.log, readAfter: journal.log.readAfter }),
                ),
              ),
            ),
          );
          yield* Context.get(replayed, MemoryCapture).runOnce;
          expect(yield* memory.observations(pip, threadId)).toBe(ended);
          const history = yield* memory.store.history(you, pipsOwn, sessionPage(threadId));
          expect(history).toHaveLength(1);
        }),
      ));

    // covers ADR 028 (Capture and summaries), PE-006
    it("[TC-GEN-301] sends nothing that redaction removes", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, `Use the token ${SECRET} to deploy.`, `I deployed with ${SECRET}.`, {
            steps: [step("s1", `curl -H "Authorization: Bearer ${SECRET}"`, `token=${SECRET}`)],
          });
          archive(journal, threadId);
          yield* capture.runOnce;
          const page = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          expect(page).not.toBeNull();
          expect(page?.markdown).not.toContain(SECRET);
          expect(page?.markdown).toContain("[redacted");
        }),
      ));

    // covers ADR 028 (Capture and summaries)
    it("[TC-GEN-302] ends a session when its thread is archived, and the thread goes on in the same session", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "Where are the docs?", "In docs/.");
          archive(journal, threadId);
          yield* capture.runOnce;
          const first = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          expect(first?.markdown).toContain("Where are the docs?");
          expect(journal.sessions()).toEqual([]);

          exchange(journal, threadId, "And the decisions?", "In docs/decisions.");
          yield* capture.runOnce;
          yield* quietPassed;
          yield* capture.runOnce;
          const page = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          expect(page?.markdown).toContain("And the decisions?");
          expect(page?.markdown).toContain("Where are the docs?");
          // start, two prompts, two replies: the start is not sent again
          expect(yield* memory.observations(pip, threadId)).toBe(5);
        }),
      ));

    // covers ADR 028 (Capture and summaries)
    it("[TC-GEN-303] sends a page again once after a crash between memory's acknowledgement and the cursor's save, with no duplicate", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "Which branch do we work on?", "Always a feature branch.");
          journal.crashNextSave();
          expect(yield* capture.runOnce).toBe(false);
          expect(journal.cursor()).toBe(0);
          const sent = yield* memory.observations(pip, threadId);
          expect(sent).toBe(3);
          expect(yield* capture.runOnce).toBe(true);
          expect(journal.cursor()).toBe(3);
          expect(yield* memory.observations(pip, threadId)).toBe(sent);
        }),
      ));

    // covers ADR 028 (When memory is down)
    it("[TC-GEN-304] keeps everything while memory is down, past the journal's 7 days, and sends it all once memory is back", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "Do we squash merges?", "Yes, always.");
          yield* capture.runOnce;
          yield* memory.down;
          // The hob keeps working while memory is down, for longer than the journal keeps entries.
          exchange(journal, threadId, "And the changelog?", "release-please writes it.");
          expect(yield* capture.runOnce).toBe(false);
          journal.skip(Duration.days(8));
          yield* TestClock.adjust(Duration.days(8));
          exchange(journal, threadId, "Who reviews?", "You do.");
          archive(journal, threadId);
          expect(yield* capture.runOnce).toBe(false);
          expect(journal.cursor()).toBe(3);

          yield* memory.up;
          expect(yield* capture.runOnce).toBe(true);
          expect(journal.cursor()).toBe(10);
          const page = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          for (const prompt of ["Do we squash merges?", "And the changelog?", "Who reviews?"]) {
            expect(page?.markdown).toContain(prompt);
          }
          // start, three prompts, three replies
          expect(yield* memory.observations(pip, threadId)).toBe(7);
        }),
      ));

    // covers ADR 028 (Capture and summaries)
    it("[TC-GEN-305] tags a thread's session with the Quests its hob led there", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "Ship the release.", "I started a Quest for it.");
          const quest = new Quest({
            id: QuestId.make("quest-1"),
            taskId: TaskId.make("task-1"),
            leadId: pip,
            parentQuestId: null,
            threadId,
            goal: "Ship the release",
            acceptance: [],
            limits: { maxDepth: 2, deadline: null },
            depth: 1,
            state: "active",
            createdAt: "2026-11-05T12:00:00.000Z",
            endedAt: null,
          });
          journal.append({ _tag: "QuestStarted", quest }, threadId);
          archive(journal, threadId);
          yield* capture.runOnce;
          const page = yield* memory.store.page(you, pipsOwn, sessionPage(threadId));
          expect(page?.markdown).toContain("quest:quest-1");
          expect(page?.markdown).toContain(`thread:${threadId}`);
        }),
      ));

    // covers ADR 028 (Capture and summaries)
    it("[TC-GEN-306] waits for memory's 30 minutes of quiet by the time of a thread's last entry", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "What is the port?", "4180.");
          yield* capture.runOnce;
          yield* TestClock.adjust(Duration.minutes(29));
          yield* capture.runOnce;
          expect(yield* memory.store.page(you, pipsOwn, sessionPage(threadId))).toBeNull();
          expect(journal.sessions().map((session) => session.threadId)).toEqual([threadId]);
          yield* TestClock.adjust(Duration.minutes(2));
          yield* capture.runOnce;
          expect(yield* memory.store.page(you, pipsOwn, sessionPage(threadId))).not.toBeNull();
        }),
      ));

    // covers ADR 028 (When memory is down)
    it("[TC-GEN-309] settles a save memory took before the hub stopped without writing it again", () =>
      run(
        ({ memory, saves, capture }) =>
          Effect.gen(function* () {
            const path = MemoryPath.make("notes/release.md");
            const at = DateTime.formatIso(yield* DateTime.now);
            const save = recordedSave(path, "# Release\n\nTag from main.", "sending", at);
            yield* saves.service.begin(save);
            // Memory took the write; the hub stopped before it settled the save.
            const taken = yield* memory.store.write(
              asPip,
              pipsOwn,
              { path, markdown: save.markdown, tags: save.tags, pinned: false },
              { _tag: "Any" },
            );
            yield* TestClock.adjust(Duration.minutes(3));
            yield* capture.runOnce;
            expect(saves.saves().map((settled) => [settled.state, settled.version])).toEqual([["saved", taken]]);
            expect(yield* memory.store.history(you, pipsOwn, path)).toHaveLength(1);
          }),
        "now",
      ));

    // covers ADR 028 (When memory is down)
    it("[TC-GEN-310] never lets a save kept through an outage replace a page written after it", () =>
      run(
        ({ memory, saves, capture }) =>
          Effect.gen(function* () {
            const path = MemoryPath.make("notes/release.md");
            const at = DateTime.formatIso(yield* DateTime.now);
            const older = recordedSave(path, "# Release\n\nTag from a branch.", "queued", at);
            const kept = recordedSave(MemoryPath.make("notes/ports.md"), "# Ports\n\n4180.", "queued", at);
            yield* saves.service.begin(older);
            yield* saves.service.begin(kept);
            yield* TestClock.adjust(Duration.seconds(1));
            // Memory is back, and a newer save of the same page went through before the worker's round.
            const newer = "# Release\n\nTag from main.";
            yield* memory.store.write(
              asPip,
              pipsOwn,
              { path, markdown: newer, tags: [], pinned: false },
              { _tag: "Any" },
            );
            yield* capture.runOnce;
            expect((yield* memory.store.page(you, pipsOwn, path))?.markdown).toBe(newer);
            expect(saves.saves().map((settled) => settled.state)).toEqual(["refused", "saved"]);
            expect((yield* memory.store.page(you, pipsOwn, kept.path))?.markdown).toBe(kept.markdown);
          }),
        "now",
      ));

    // covers ADR 028 (When memory is down)
    it("[TC-GEN-311] warns when it sends entries older than memory's 30-day replay window", () =>
      run(({ memory, journal, capture }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(crypto.randomUUID());
          exchange(journal, threadId, "Which branch do releases tag from?", "From main.");
          yield* TestClock.adjust(Duration.days(31));
          const warnings: Array<string> = [];
          const recorder = Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(JSON.stringify(message));
          });
          yield* capture.runOnce.pipe(Effect.provide(Logger.layer([recorder])));
          expect(warnings.some((warning) => warning.includes("older than memory's 30-day replay window"))).toBe(true);
          expect(yield* memory.observations(pip, threadId)).toBeGreaterThan(0);
        }),
      ));
  });
};
