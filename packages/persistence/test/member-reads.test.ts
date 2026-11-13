import { CatchUpRepository, ChapterRepository, HobbotsRepository, ThreadMemberRepository } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  type Actor,
  Agent,
  AgentId,
  ChapterId,
  DeviceId,
  EVENT_SCHEMA_VERSIONS,
  Message,
  MessageId,
  OWNER_ACTOR,
  Thread,
  ThreadId,
  UserId,
} from "@hobbots/domain";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  CatchUpRepositoryLive,
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  keepsThreadMarker,
  migrations,
  ThreadMemberRepositoryLive,
  unreadByMember,
  unreadByThreadMarker,
} from "../src/index.ts";
import memberReads from "../src/migrations/0115_member_reads.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1454 (ADR 039, read markers per member): unread counts, the unread line and catch-up read
// the member row of the person asking. Migration 0115 drops the thread's own marker after moving the
// owner's forward to it, and takes `unread` out of every journaled thread, and unread counts read the
// same before and after. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-13T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CHAT = ThreadId.make("chat");
const CAMP = ThreadId.make("camp");
const QUIET = ThreadId.make("quiet");
const BRUNA: Actor = { kind: "user", id: "bruna" };

/** The migrations that ran before 0115, when each thread kept its own read marker. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0115")) as typeof migrations;

type Services =
  | HobbotsRepository
  | ThreadMemberRepository
  | CatchUpRepository
  | EventJournal
  | SqlClient.SqlClient
  | ChapterRepository;

const run = <A, E>(effect: Effect.Effect<A, E, Services>, database: typeof TestDatabase = TestDatabase) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        ThreadMemberRepositoryLive,
        CatchUpRepositoryLive,
        ChapterRepositoryLive,
        EventJournal.layer,
      ).pipe(Layer.provideMerge(database)),
    ),
    Effect.runPromise,
  );

/** A request from Bruna's phone: the session the hub's device middleware provides. */
const asBruna = Effect.provideService(
  UserSession,
  UserSession.of({
    deviceId: DeviceId.make("phone"),
    name: "Phone",
    kind: "browser",
    userId: UserId.make("bruna"),
    actor: BRUNA,
    whileApproved: (write) => write,
  }),
);

const aldric = new Agent({
  id: ALDRIC,
  name: "Aldric",
  roleTitle: "Guide",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: NOW,
});

const thread = (id: ThreadId, kind: Thread["kind"]) =>
  new Thread({ id, agentId: ALDRIC, title: id, kind, createdAt: NOW, updatedAt: NOW });

const reply = (threadId: ThreadId, id: string, content = "Done.") =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "assistant",
    actor: null,
    content,
    status: "complete",
    error: null,
    configVersion: 1 as Message["configVersion"],
    createdAt: NOW,
  });

/** Saves a reply and answers its revision. */
const say = (threadId: ThreadId, id: string, content?: string) =>
  Effect.flatMap(HobbotsRepository, (repo) => repo.upsertMessage(reply(threadId, id, content))).pipe(
    Effect.map((saved) => saved.value.revision),
  );

const unreadIds = Effect.flatMap(HobbotsRepository, (repo) => repo.listUnreadThreads).pipe(
  Effect.map((listed) => listed.threadIds),
);

describe("read markers per member", () => {
  // covers ADR 039 (Members: the read marker moves to the member)
  it("[TC-PE-1454-01] gives the owner the thread's marker where it lagged, drops the thread's, and unread counts read the same", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(aldric);
        for (const [id, kind] of [
          [CHAT, "chat"],
          [CAMP, "camp"],
          [QUIET, "camp"],
        ] as const) {
          yield* repo.upsertThread(thread(id, kind));
        }
        const read = yield* say(CHAT, "c1");
        yield* say(CHAT, "c2");
        yield* say(CHAT, "c3");
        const campRead = yield* say(CAMP, "k1");
        yield* say(QUIET, "q1");
        // The hub kept both markers until now; here the owner's lags behind the chat's.
        yield* sql`UPDATE threads SET read_revision = ${read} WHERE id = ${CHAT}`;
        yield* sql`UPDATE threads SET read_revision = ${campRead} WHERE id = ${CAMP}`;
        yield* sql`UPDATE thread_members SET read_revision = NULL WHERE thread_id = ${CHAT}`;
        yield* sql`UPDATE thread_members SET read_revision = ${campRead} WHERE thread_id = ${CAMP} AND role = 'owner'`;
        const before = yield* unreadByThreadMarker;
        yield* memberReads;
        const owners = yield* sql<{ readonly threadId: string; readonly readRevision: unknown }>`SELECT thread_id,
          read_revision FROM thread_members WHERE role = 'owner' ORDER BY thread_id`;
        return {
          before,
          after: yield* unreadByMember,
          owners: owners.map((row) => [row.threadId, row.readRevision == null ? null : Number(row.readRevision)]),
          marker: yield* keepsThreadMarker,
          dropped: Exit.isFailure(yield* Effect.exit(sql`SELECT read_revision FROM threads`)),
          read,
          campRead,
        };
      }),
      TestDatabaseAt(earlier),
    );
    expect(result.before.map((each) => [each.threadId, each.unread])).toEqual([
      ["camp", 0],
      ["chat", 2],
      ["quiet", 1],
    ]);
    expect(result.after).toEqual(result.before);
    expect(result.owners).toEqual([
      ["camp", result.campRead],
      ["chat", result.read],
      ["quiet", null],
    ]);
    expect(result.marker).toBe(false);
    expect(result.dropped).toBe(true);
  });

  // covers ADR 039 (Members), ADR 013
  it("[TC-PE-1454-02] takes `unread` out of every journaled thread, at its new version, and the entries decode", async () => {
    const carriers = { ThreadUpserted: 5, CampMade: 2, ChatStartedFresh: 2, ChapterMoved: 1 } as const;
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        yield* repo.insertAgent(aldric);
        const made = yield* repo.upsertThread(thread(CHAT, "chat"));
        // Each kind of entry that carries a thread, as the hub wrote it before: with its `unread`.
        const stored = { ...JSON.parse(JSON.stringify(made.value)), unread: true };
        const payloads = {
          ThreadUpserted: { _tag: "ThreadUpserted", thread: stored },
          CampMade: { _tag: "CampMade", thread: stored },
          ChatStartedFresh: { _tag: "ChatStartedFresh", superseded: stored, chat: stored, carried: [] },
        };
        let sequence = 1000;
        for (const [type, payload] of Object.entries(payloads)) {
          sequence += 1;
          yield* sql`INSERT INTO event_journal ${sql.insert({
            sequence,
            id: `old-${type}`,
            type,
            schemaVersion: carriers[type as keyof typeof carriers],
            occurredAt: NOW,
            agentId: ALDRIC,
            threadId: CHAT,
            messageId: null,
            causationId: null,
            payload: JSON.stringify(payload),
          })}`;
        }
        yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
        yield* memberReads;
        const rows = yield* sql<{ readonly type: string; readonly schemaVersion: unknown; readonly payload: string }>`
          SELECT type, schema_version, payload FROM event_journal WHERE id LIKE 'old-%' ORDER BY sequence`;
        const entries = yield* journal.readAfter(1000);
        return { rows, decoded: entries.map((entry) => entry.payload._tag) };
      }),
      TestDatabaseAt(earlier),
    );
    expect(result.rows.map((row) => [row.type, Number(row.schemaVersion)])).toEqual([
      ["ThreadUpserted", EVENT_SCHEMA_VERSIONS.ThreadUpserted],
      ["CampMade", EVENT_SCHEMA_VERSIONS.CampMade],
      ["ChatStartedFresh", EVENT_SCHEMA_VERSIONS.ChatStartedFresh],
    ]);
    expect(result.rows.every((row) => !row.payload.includes('"unread"'))).toBe(true);
    expect(result.decoded).toEqual(["ThreadUpserted", "CampMade", "ChatStartedFresh"]);
    // The migration lists every event type that carries a thread, at the version it writes.
    expect(EVENT_SCHEMA_VERSIONS).toMatchObject({
      ThreadUpserted: 6,
      CampMade: 3,
      ChatStartedFresh: 3,
      ChapterMoved: 2,
    });
  });

  // covers ADR 039 (Members: unread counts, the unread line and catch-up are per person)
  it("[TC-PE-1454-03] keeps each person's unread threads and unread line their own, in either reading order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const members = yield* ThreadMemberRepository;
        const catchUp = yield* CatchUpRepository;
        yield* repo.insertAgent(aldric);
        yield* repo.upsertThread(thread(CAMP, "camp"));
        yield* members.add(CAMP, BRUNA, OWNER_ACTOR);
        const seen = yield* say(CAMP, "k1");
        const both = { owner: yield* unreadIds, bruna: yield* asBruna(unreadIds) };
        // You read it; Bruna has not.
        const marked = yield* repo.markThreadRead(CAMP, MessageId.make("k1"), seen);
        const afterYours = {
          owner: yield* unreadIds,
          bruna: yield* asBruna(unreadIds),
          ownerLine: yield* catchUp.marker(CAMP),
          brunaLine: yield* asBruna(catchUp.marker(CAMP)),
        };
        // Bruna reads it on her phone: her own row moves, journaled as hers.
        const hers = yield* asBruna(repo.markThreadRead(CAMP, MessageId.make("k1"), seen));
        // Aldric writes again: unread for both.
        const next = yield* say(CAMP, "k2");
        const again = { owner: yield* unreadIds, bruna: yield* asBruna(unreadIds) };
        // The other order: Bruna reads first, then you read the same revision, and each row moves.
        yield* asBruna(repo.markThreadRead(CAMP, MessageId.make("k2"), next));
        const brunaFirst = { owner: yield* unreadIds, bruna: yield* asBruna(unreadIds) };
        const yoursAfter = yield* repo.markThreadRead(CAMP, MessageId.make("k2"), next);
        const bothRead = {
          owner: yield* unreadIds,
          bruna: yield* asBruna(unreadIds),
          lines: [yield* catchUp.marker(CAMP), yield* asBruna(catchUp.marker(CAMP))],
        };
        // A hob reads nothing, and someone outside the camp has no marker to move.
        const outsider = yield* Effect.provideService(
          repo.markThreadRead(CAMP, MessageId.make("k2"), Number.MAX_SAFE_INTEGER),
          UserSession,
          UserSession.of({
            deviceId: DeviceId.make("laptop"),
            name: "Laptop",
            kind: "browser",
            userId: UserId.make("ana"),
            actor: { kind: "user", id: "ana" },
            whileApproved: (write) => write,
          }),
        );
        return { both, marked, afterYours, hers, again, brunaFirst, yoursAfter, bothRead, next, outsider, seen };
      }),
    );
    expect(result.both).toEqual({ owner: [CAMP], bruna: [CAMP] });
    expect(result.afterYours).toEqual({ owner: [], bruna: [CAMP], ownerLine: result.seen, brunaLine: null });
    const changed = (committed: typeof result.marked) =>
      committed._tag === "Some"
        ? committed.value.entries.map((entry) => [
            entry.type,
            "member" in entry.payload ? entry.payload.member.actor : null,
          ])
        : [];
    expect(changed(result.marked)).toEqual([["ThreadMemberChanged", OWNER_ACTOR]]);
    expect(changed(result.hers)).toEqual([["ThreadMemberChanged", BRUNA]]);
    expect(result.again).toEqual({ owner: [CAMP], bruna: [CAMP] });
    expect(result.brunaFirst).toEqual({ owner: [CAMP], bruna: [] });
    expect(changed(result.yoursAfter)).toEqual([["ThreadMemberChanged", OWNER_ACTOR]]);
    expect(result.bothRead).toEqual({ owner: [], bruna: [], lines: [result.next, result.next] });
    expect(result.outsider._tag).toBe("None");
  });

  // covers ADR 039 (Members), ADR 037 (Chapters)
  it("[TC-PE-1454-04] keeps a person who had read the thread read when a chapter splits, and one who had not unread", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const members = yield* ThreadMemberRepository;
        const chapters = yield* ChapterRepository;
        yield* repo.insertAgent(aldric);
        yield* repo.upsertThread(thread(CAMP, "camp"));
        yield* members.add(CAMP, BRUNA, OWNER_ACTOR);
        yield* say(CAMP, "k1");
        const seen = yield* say(CAMP, "k2");
        yield* repo.markThreadRead(CAMP, MessageId.make("k2"), seen);
        // The split gives the moved messages a new revision, past your marker.
        yield* chapters.splitChapter(CAMP, {
          id: ChapterId.make("later"),
          messageId: MessageId.make("k2"),
          title: "Later",
        });
        return { owner: yield* unreadIds, bruna: yield* asBruna(unreadIds) };
      }),
    );
    expect(result).toEqual({ owner: [], bruna: [CAMP] });
  });
});
