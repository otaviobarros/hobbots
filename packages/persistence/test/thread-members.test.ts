import { HobbotsRepository, ThreadMemberRepository } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  type Actor,
  Agent,
  AgentId,
  DeviceId,
  hobActor,
  MemberState,
  Message,
  MessageId,
  OWNER_ACTOR,
  Thread,
  ThreadId,
  type ThreadMember,
  UserId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations, ThreadMemberRepositoryLive } from "../src/index.ts";
import threadMembers, { MEMBER_ROLES, MEMBER_STATES } from "../src/migrations/0113_thread_members.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1453 (ADR 039, Members): every thread has members, a person or a hob each. The migration
// gives each thread its owner and its hob; a new thread starts with the person who made it and its
// hob; a direct message takes no third member; a retired hob leaves every thread and comes back when
// it returns. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-13T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const ROOK = AgentId.make("rook");
const CHAT = ThreadId.make("chat");
const CAMP = ThreadId.make("camp");
const BRUNA: Actor = { kind: "user", id: "bruna" };

/** The migrations that ran before 0113, when threads had no members. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0113")) as typeof migrations;

type Services = HobbotsRepository | ThreadMemberRepository | EventJournal | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>, database: typeof TestDatabase = TestDatabase) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive, EventJournal.layer).pipe(
        Layer.provideMerge(database),
      ),
    ),
    Effect.runPromise,
  );

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
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

const thread = (id: ThreadId, kind: Thread["kind"], agentId: AgentId = ALDRIC) =>
  new Thread({ id, agentId, title: id, kind, createdAt: NOW, updatedAt: NOW });

/** A request from Bruna's phone: the session the hub's device middleware provides. */
const brunaSession = UserSession.of({
  deviceId: DeviceId.make("phone"),
  name: "Phone",
  kind: "browser",
  userId: UserId.make("bruna"),
  actor: BRUNA,
  whileApproved: (write) => write,
});

/** What a test compares of a member: who, their role and state, and who added them. */
const shown = (member: ThreadMember) => ({
  actor: `${member.actor.kind}:${member.actor.id}`,
  role: member.role,
  state: member.state,
  addedBy: `${member.addedBy.kind}:${member.addedBy.id}`,
});

const members = (threadId: ThreadId) =>
  Effect.flatMap(ThreadMemberRepository, (repository) => repository.list(threadId)).pipe(
    Effect.map((rows) => rows.map(shown)),
  );

const retire = (agentId: AgentId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const agent = Option.getOrThrow(yield* repo.findAgent(agentId));
    return yield* repo.setAgentStatus(new Agent({ ...agent, status: "retired", retiredAt: NOW }), agent.status);
  });

const bringBack = (agentId: AgentId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const agent = Option.getOrThrow(yield* repo.findAgent(agentId));
    return yield* repo.setAgentStatus(new Agent({ ...agent, status: "active", retiredAt: null }), "retired");
  });

const types = (entries: ReadonlyArray<{ readonly type: string }>) => entries.map((entry) => entry.type);

describe("thread members", () => {
  // covers ADR 039 (Members)
  it("[TC-PE-1453-01] gives every thread its owner and its hob in one pass, with the owner's read marker", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fields = { roleTitle: "Guide", instructions: "", lookSeed: 1, lookColor: "moss", createdAt: NOW };
        yield* sql`INSERT INTO agents ${sql.insert({ id: ALDRIC, name: "Aldric", runtime: "claude-code", ...fields })}`;
        yield* sql`INSERT INTO agents ${sql.insert({
          id: ROOK,
          name: "Rook",
          runtime: "codex",
          status: "retired",
          retiredAt: NOW,
          ...fields,
        })}`;
        const old = { sessions: "[]", createdAt: NOW, updatedAt: NOW, revision: 4 };
        yield* sql`INSERT INTO threads ${sql.insert({ id: CHAT, agentId: ALDRIC, title: "Chat", kind: "chat", readRevision: 3, ...old })}`;
        yield* sql`INSERT INTO threads ${sql.insert({ id: CAMP, agentId: ROOK, title: "Camp", kind: "camp", ...old })}`;
        yield* threadMembers;
        const all = yield* Effect.flatMap(ThreadMemberRepository, (repository) => repository.list(CHAT));
        return { chat: all.map(shown), reads: all.map((member) => member.readRevision), camp: yield* members(CAMP) };
      }),
      TestDatabaseAt(earlier),
    );
    expect(result.chat).toEqual([
      { actor: "user:owner", role: "owner", state: "active", addedBy: "user:owner" },
      { actor: "hob:aldric", role: "member", state: "active", addedBy: "user:owner" },
    ]);
    expect(result.reads).toEqual([3, null]);
    // Rook retired before the upgrade, so it has already left its camp.
    expect(result.camp).toEqual([
      { actor: "user:owner", role: "owner", state: "active", addedBy: "user:owner" },
      { actor: "hob:rook", role: "member", state: "left", addedBy: "user:owner" },
    ]);
  });

  // covers ADR 039 (Members)
  it("[TC-PE-1453-02] starts a new thread with the person whose session made it and its hob, and Start fresh keeps them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(hob(ALDRIC));
        yield* repo.upsertThread(thread(CHAT, "chat"));
        // Bruna makes the camp from her phone.
        yield* repo.makeCamp(thread(CAMP, "camp")).pipe(Effect.provideService(UserSession, brunaSession));
        const chat = Option.getOrThrow(yield* repo.findThread(CHAT));
        const fresh = new Thread({
          ...thread(ThreadId.make("fresh"), "chat"),
          origin: { threadId: CHAT, chapterId: null },
        });
        yield* repo.startFresh({
          superseded: new Thread({ ...chat, state: "superseded", archivedAt: NOW }),
          chat: fresh,
        });
        // A later write of a thread leaves its members as they are.
        const camp = Option.getOrThrow(yield* repo.findThread(CAMP));
        yield* repo.upsertThread(new Thread({ ...camp, title: "Renamed" }));
        return { chat: yield* members(CHAT), camp: yield* members(CAMP), fresh: yield* members(fresh.id) };
      }),
    );
    const directMessage = [
      { actor: "user:owner", role: "owner", state: "active", addedBy: "user:owner" },
      { actor: "hob:aldric", role: "member", state: "active", addedBy: "user:owner" },
    ];
    expect(result.chat).toEqual(directMessage);
    expect(result.fresh).toEqual(directMessage);
    expect(result.camp).toEqual([
      { actor: "user:bruna", role: "owner", state: "active", addedBy: "user:bruna" },
      { actor: "hob:aldric", role: "member", state: "active", addedBy: "user:bruna" },
    ]);
  });

  // covers ADR 039 (Members)
  it("[TC-PE-1453-03] refuses a third member in a direct message, and adds one to a camp once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const repository = yield* ThreadMemberRepository;
        yield* repo.insertAgent(hob(ALDRIC));
        yield* repo.insertAgent(hob(ROOK));
        yield* repo.upsertThread(thread(CHAT, "chat"));
        yield* repo.makeCamp(thread(CAMP, "camp"));
        const refused = yield* Effect.exit(repository.add(CHAT, hobActor(ROOK), OWNER_ACTOR));
        const again = yield* repository.add(CHAT, hobActor(ALDRIC), OWNER_ACTOR);
        const added = yield* repository.add(CAMP, hobActor(ROOK), OWNER_ACTOR);
        const twice = yield* repository.add(CAMP, hobActor(ROOK), BRUNA);
        return {
          refused,
          again: types(again.entries),
          added: types(added.entries),
          twice: types(twice.entries),
          chat: yield* members(CHAT),
          camp: yield* members(CAMP),
          found: yield* repository.find(CAMP, hobActor(ROOK)),
        };
      }),
    );
    expect(Exit.isFailure(result.refused)).toBe(true);
    expect(JSON.stringify(result.refused)).toContain("direct-message");
    // Its own hob is already in it: nothing changes, and nothing is journaled.
    expect(result.again).toEqual([]);
    expect(result.chat.map((member) => member.actor)).toEqual(["user:owner", "hob:aldric"]);
    expect(result.added).toEqual(["ThreadMemberAdded"]);
    expect(result.twice).toEqual([]);
    expect(result.camp).toEqual([
      { actor: "user:owner", role: "owner", state: "active", addedBy: "user:owner" },
      { actor: "hob:aldric", role: "member", state: "active", addedBy: "user:owner" },
      { actor: "hob:rook", role: "member", state: "active", addedBy: "user:owner" },
    ]);
    expect(Option.map(result.found, (member) => member.state)).toEqual(Option.some("active"));
  });

  // covers ADR 039 (Members)
  it("[TC-PE-1453-04] takes a retired hob out of every thread it is in, and brings it back when it returns", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const repository = yield* ThreadMemberRepository;
        yield* repo.insertAgent(hob(ALDRIC));
        yield* repo.insertAgent(hob(ROOK));
        yield* repo.upsertThread(thread(CHAT, "chat"));
        yield* repo.makeCamp(thread(CAMP, "camp"));
        yield* repository.add(CAMP, hobActor(ROOK), OWNER_ACTOR);
        const retired = Option.getOrThrow(yield* retire(ROOK));
        const away = { chat: yield* members(CHAT), camp: yield* members(CAMP) };
        const back = Option.getOrThrow(yield* bringBack(ROOK));
        return { retired: types(retired.entries), away, back: types(back.entries), camp: yield* members(CAMP) };
      }),
    );
    expect(result.retired).toEqual(["AgentUpserted", "ThreadMemberChanged"]);
    expect(result.away.camp.map((member) => [member.actor, member.state])).toEqual([
      ["user:owner", "active"],
      ["hob:aldric", "active"],
      ["hob:rook", "left"],
    ]);
    expect(result.away.chat.map((member) => member.state)).toEqual(["active", "active"]);
    expect(result.back).toEqual(["AgentUpserted", "ThreadMemberChanged"]);
    expect(result.camp.map((member) => member.state)).toEqual(["active", "active", "active"]);
  });

  // covers ADR 039 (Members)
  it("[TC-PE-1453-05] moves the reader's own marker with the thread's when they read it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(hob(ALDRIC));
        yield* repo.upsertThread(thread(CHAT, "chat"));
        const reply = new Message({
          id: MessageId.make("reply"),
          threadId: CHAT,
          role: "assistant",
          actor: null,
          content: "Done.",
          status: "complete",
          error: null,
          configVersion: 1 as Message["configVersion"],
          createdAt: NOW,
        });
        const saved = yield* repo.upsertMessage(reply);
        yield* repo.markThreadRead(CHAT, reply.id, saved.value.revision);
        const all = yield* Effect.flatMap(ThreadMemberRepository, (repository) => repository.list(CHAT));
        return { seen: saved.value.revision, reads: all.map((member) => member.readRevision) };
      }),
    );
    expect(result.reads).toEqual([result.seen, null]);
  });

  // covers ADR 039 (Members)
  it("[TC-PE-1453-06] refuses a member role or state outside the domain's, on insert and on update", async () => {
    // A new state or role needs a migration of its own.
    expect(MEMBER_STATES).toEqual(MemberState.literals);
    expect(MEMBER_ROLES).toEqual(["owner", "member"]);
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(hob(ALDRIC));
        yield* repo.upsertThread(thread(CAMP, "camp"));
        const row = {
          threadId: CAMP,
          actorKind: "user",
          actorId: "leo",
          joinedAt: NOW,
          addedByKind: "user",
          addedById: "owner",
          revision: 1,
        };
        const state = yield* Effect.exit(
          sql`INSERT INTO thread_members ${sql.insert({ ...row, role: "member", state: "invited" })}`,
        );
        const role = yield* Effect.exit(
          sql`INSERT INTO thread_members ${sql.insert({ ...row, role: "host", state: "active" })}`,
        );
        const updated = yield* Effect.exit(sql`UPDATE thread_members SET state = 'invited'`);
        const roleUpdated = yield* Effect.exit(sql`UPDATE thread_members SET role = 'host'`);
        return { state, role, updated, roleUpdated, members: yield* members(CAMP) };
      }),
    );
    for (const exit of [result.state, result.role, result.updated, result.roleUpdated]) {
      expect(Exit.isFailure(exit)).toBe(true);
    }
    expect(result.members.map((member) => member.state)).toEqual(["active", "active"]);
  });
});
