import { HobbotsRepository, type SentTo, ThreadMemberRepository } from "@hobbots/agents";
import type { ThreadArchived } from "@hobbots/api";
import {
  type Actor,
  Agent,
  AgentId,
  type AgentStatus,
  hobActor,
  type MemberRefused,
  Message,
  MessageId,
  type MessageStatus,
  mainLine,
  OWNER_ACTOR,
  type ReplyUsage,
  Thread,
  ThreadId,
  type ThreadMember,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, ThreadMemberRepositoryLive, UsageLedger } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1467 (ADR 039, Members): a camp is made with the hobs you pick, and hobs are added and taken
// out through the member events. Taking a hob out drops the answers it still owed there in the same
// transaction. The members sheet reads each hob's turns and tokens in the camp from the replies'
// own usage. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-14T10:00:00.000Z";
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const ROOK = AgentId.make("rook");
const CAMP = ThreadId.make("camp");
const CHAT = ThreadId.make("chat");
const BRUNA: Actor = { kind: "user", id: "bruna" };

type Services = HobbotsRepository | ThreadMemberRepository | EventJournal | UsageLedger | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive, EventJournal.layer, UsageLedger.layer).pipe(
        Layer.provideMerge(TestDatabase),
      ),
    ),
    Effect.runPromise,
  );

const hob = (id: AgentId, status: AgentStatus = "active") =>
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
    status,
    retiredAt: status === "retired" ? NOW : null,
    createdAt: NOW,
  });

const camp = (id: ThreadId = CAMP, kind: Thread["kind"] = "camp") =>
  new Thread({ id, agentId: QUILL, title: id, kind, createdAt: NOW, updatedAt: NOW });

const said = (id: string, status: MessageStatus, actor: Actor = OWNER_ACTOR) =>
  new Message({
    id: MessageId.make(id),
    threadId: CAMP,
    actor,
    role: "user",
    content: id,
    status,
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

const mentioning = (hobs: ReadonlyArray<AgentId>): SentTo => ({ mentions: hobs.map(hobActor), repliesTo: null });

const shown = (member: ThreadMember) => `${member.actor.kind}:${member.actor.id}:${member.state}`;
const members = (threadId: ThreadId) =>
  Effect.flatMap(ThreadMemberRepository, (repository) => repository.list(threadId)).pipe(
    Effect.map((rows) => rows.map(shown)),
  );
const types = (entries: ReadonlyArray<{ readonly type: string }>) => entries.map((entry) => entry.type);
const owed = Effect.flatMap(HobbotsRepository, (repo) => repo.openTurnRequests(mainLine(CAMP))).pipe(
  Effect.map((requests) => requests.map((request) => `${request.hobId}:${request.messageId}:${request.state}`)),
);

/** Quill's camp, made with Pip and Rook. */
const campOfThree = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const id of [QUILL, PIP, ROOK]) yield* repo.insertAgent(hob(id));
  return yield* repo.makeCamp(camp(), [PIP, ROOK]);
});

// The trick from Make a camp's tests: a row planted at the journal's next sequence makes the
// change's own append fail, so the whole transaction rolls back.
const plantJournalRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const journal = yield* EventJournal;
  const next = (yield* journal.head).sequence + 1;
  yield* sql`INSERT INTO event_journal ${sql.insert({
    sequence: next,
    id: "planted",
    type: "ThreadUpserted",
    schema_version: 4,
    occurred_at: NOW,
    payload: "{}",
  })}`;
  return sql`DELETE FROM event_journal WHERE id = 'planted'`;
});

/** Why a member change was refused: its reason, or the error's tag when it is not a membership refusal. */
const refusal = (error: MemberRefused | ThreadArchived) => (error._tag === "MemberRefused" ? error.reason : error._tag);

describe("a camp's hobs", () => {
  // covers ADR 039 (Members)
  it("makes a camp with the hobs picked, each journaled after its first two, the lead once, refuses a hob that takes no new work and its key asked again with other hobs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        for (const id of [QUILL, PIP]) yield* repo.insertAgent(hob(id));
        yield* repo.insertAgent(hob(ROOK, "retired"));
        // A hob that no longer takes new work as the camp is written makes no camp at all.
        const refused = yield* repo.makeCamp(camp(), [PIP, ROOK]).pipe(Effect.flip);
        const none = yield* repo.findThread(CAMP);
        const made = yield* repo.makeCamp(camp(), [PIP, QUILL, PIP]);
        // The same camp asked again, its hobs in another order, changes nothing; with other hobs, its key is reused.
        const again = yield* repo.makeCamp(camp(), [QUILL, PIP]);
        const otherHobs = yield* repo.makeCamp(camp(), [ROOK]).pipe(Effect.flip);
        return {
          refused: refused._tag === "HobUnavailable" ? `${refused.agentId}:${refused.status}` : refused._tag,
          none: Option.isNone(none),
          made: types(made.entries),
          again: types(again.entries),
          otherHobs: otherHobs._tag,
          members: yield* members(CAMP),
        };
      }),
    );
    expect(result.refused).toBe("rook:retired");
    expect(result.none).toBe(true);
    expect(result.made).toEqual([
      "CampMade",
      "ChapterStarted",
      "ThreadMemberAdded",
      "ThreadMemberAdded",
      "ThreadMemberAdded",
    ]);
    expect(result.again).toEqual([]);
    expect(result.otherHobs).toBe("ThreadKeyReused");
    expect(result.members).toEqual(["user:owner:active", "hob:pip:active", "hob:quill:active"]);
  });

  // covers ADR 039 (Members, One hob speaks at a time)
  it("takes a hob out and drops the answers it still owed there, leaving the others' and dequeuing a message nobody owes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* campOfThree;
        // Marina asked Pip and Rook; then a queued message only Pip owes.
        yield* repo.sendMessage(said("m-1", "complete"), mentioning([PIP, ROOK]));
        yield* repo.sendMessage(said("m-2", "queued"), mentioning([PIP]));
        const before = yield* owed;
        const removed = yield* repo.removeMember(CAMP, hobActor(PIP), OWNER_ACTOR);
        const dequeued = Option.getOrThrow(yield* repo.findMessage(MessageId.make("m-2")));
        const again = yield* repo.removeMember(CAMP, hobActor(PIP), OWNER_ACTOR);
        return {
          before,
          after: yield* owed,
          events: types(removed.entries),
          dropped: removed.value.dropped.map((request) => `${request.hobId}:${request.state}`),
          droppedBy: removed.value.dropped.map((request) => request.droppedBy),
          member: shown(removed.value.member),
          dequeued: dequeued.status,
          again: types(again.entries),
          members: yield* members(CAMP),
        };
      }),
    );
    expect(result.before).toEqual(["pip:m-1:waiting", "rook:m-1:waiting", "pip:m-2:waiting"]);
    expect(result.after).toEqual(["rook:m-1:waiting"]);
    expect(result.events).toEqual(["ThreadMemberChanged", "MessageUpserted", "MessageDequeued"]);
    expect(result.dropped).toEqual(["pip:dropped", "pip:dropped"]);
    expect(result.droppedBy).toEqual([OWNER_ACTOR, OWNER_ACTOR]);
    expect(result.member).toBe("hob:pip:removed");
    // Said, but answered by no one: it leaves the queue where it was.
    expect(result.dequeued).toBe("complete");
    expect(result.again).toEqual([]);
    expect(result.members).toEqual(["user:owner:active", "hob:pip:removed", "hob:quill:active", "hob:rook:active"]);
  });

  // covers ADR 039 (Members)
  it("drops a removed hob's requests in the same transaction: a failed write leaves both as they were", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* campOfThree;
        yield* repo.sendMessage(said("m-1", "complete"), mentioning([PIP]));
        const unplant = yield* plantJournalRow;
        const failed = yield* Effect.exit(repo.removeMember(CAMP, hobActor(PIP), OWNER_ACTOR));
        yield* unplant;
        return { failed: Exit.isFailure(failed), owed: yield* owed, members: yield* members(CAMP) };
      }),
    );
    expect(result.failed).toBe(true);
    expect(result.owed).toEqual(["pip:m-1:waiting"]);
    expect(result.members).toContain("hob:pip:active");
  });

  // covers ADR 039 (Members)
  it("refuses to take out a direct message's two, a camp's owner and lead, or someone not in it, or any change once the camp is archived, and brings a removed hob back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const repository = yield* ThreadMemberRepository;
        yield* campOfThree;
        yield* repo.upsertThread(camp(CHAT, "chat"));
        const reason = (threadId: ThreadId, actor: Actor) =>
          Effect.flip(repo.removeMember(threadId, actor, OWNER_ACTOR)).pipe(Effect.map(refusal));
        const refusals = [
          yield* reason(CHAT, hobActor(QUILL)),
          yield* reason(CAMP, OWNER_ACTOR),
          yield* reason(CAMP, hobActor(QUILL)),
          yield* reason(CAMP, BRUNA),
        ];
        // Pip leads a Quest still open here, whose results come back to the camp: Pip stays.
        const sql = yield* SqlClient.SqlClient;
        const quest = { id: "task-pip", owner_id: PIP, root_id: "task-pip", thread_id: CAMP, brief: "Plan" };
        const at = { created_at: "2026-11-14T09:00:00.000Z", updated_at: "2026-11-14T09:00:00.000Z" };
        yield* sql`INSERT INTO tasks ${sql.insert({ ...quest, state: "active", ...at })}`;
        const leading = yield* reason(CAMP, hobActor(PIP));
        yield* sql`UPDATE tasks SET state = 'completed' WHERE id = 'task-pip'`;
        // One who is not in the camp, as the change is written, changes no one in it.
        const outsider = [
          refusal(yield* Effect.flip(repo.removeMember(CAMP, hobActor(PIP), BRUNA))),
          refusal(yield* Effect.flip(repository.add(CAMP, hobActor(PIP), BRUNA, true))),
        ];
        yield* repo.removeMember(CAMP, hobActor(ROOK), OWNER_ACTOR);
        const back = yield* repository.add(CAMP, hobActor(ROOK), OWNER_ACTOR);
        const bruna = yield* repository.add(CAMP, BRUNA, OWNER_ACTOR);
        const before = yield* members(CAMP);
        // A camp archived after the change was asked, before it is written, changes no one.
        yield* sql`UPDATE threads SET archived_at = '2026-11-14T10:00:00.000Z' WHERE id = ${CAMP}`;
        const archived = [
          refusal(yield* Effect.flip(repo.removeMember(CAMP, hobActor(ROOK), OWNER_ACTOR))),
          refusal(yield* Effect.flip(repository.add(CAMP, hobActor(PIP), OWNER_ACTOR, true))),
        ];
        return {
          refusals,
          outsider,
          archived,
          leading,
          back: types(back.entries),
          bruna: shown(bruna.value),
          members: before,
          after: yield* members(CAMP),
        };
      }),
    );
    expect(result.refusals).toEqual(["direct-message", "owner", "lead", "not-member"]);
    expect(result.outsider).toEqual(["not-member", "not-member"]);
    expect(result.archived).toEqual(["ThreadArchived", "ThreadArchived"]);
    expect(result.after).toEqual(result.members);
    expect(result.leading).toBe("leads-quest");
    expect(result.back).toEqual(["ThreadMemberChanged"]);
    expect(result.bruna).toBe("user:bruna:active");
    expect(result.members).toEqual([
      "user:owner:active",
      "hob:pip:active",
      "hob:quill:active",
      "hob:rook:active",
      "user:bruna:active",
    ]);
  });

  // covers ADR 039 (Cards every thread shares: Status and cost)
  it("counts each hob's own settled replies, passed turns and tokens in the camp for the period, and when it last answered there", async () => {
    const usage = (input: number, output: number): ReplyUsage => ({
      timeToRequestMs: 5,
      timeToFirstStreamMs: 15,
      timeToFirstTokenMs: 20,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const reply = (id: string, hobId: AgentId, createdAt: string, used: ReplyUsage | null, status: MessageStatus) =>
      new Message({
        id: MessageId.make(id),
        threadId: CAMP,
        actor: hobActor(hobId),
        role: "assistant",
        content: "…",
        status,
        error: null,
        configVersion: 1,
        runtime: "claude-code",
        model: "sonnet",
        usage: used,
        createdAt,
      });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const ledger = yield* UsageLedger;
        yield* campOfThree;
        for (const message of [
          reply("r-1", QUILL, "2026-11-13T18:00:00.000Z", usage(1, 1), "complete"),
          reply("r-2", QUILL, "2026-11-14T09:00:00.000Z", usage(100, 200), "complete"),
          reply("r-3", PIP, "2026-11-14T09:10:00.000Z", usage(10, 20), "complete"),
          reply("r-4", PIP, "2026-11-14T09:20:00.000Z", null, "failed"),
          reply("r-5", PIP, "2026-11-14T09:30:00.000Z", null, "streaming"),
        ]) {
          yield* repo.upsertMessage(message);
        }
        // A turn Quill passed left no reply, but what it used counts; it answered nothing, so it sets no time.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO passed_turns ${sql.insert({
          reply_id: "r-6",
          thread_id: CAMP,
          agent_id: QUILL,
          created_at: "2026-11-14T10:00:00.000Z",
          input_tokens: 4,
          output_tokens: 6,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        })}`;
        return yield* ledger.threadUsage(CAMP, "2026-11-14T00:00:00.000Z", "2026-11-14T12:00:00.000Z");
      }),
    );
    expect(result).toEqual([
      { hobId: PIP, turns: 2, tokens: 30, unreported: 1, lastAnsweredAt: "2026-11-14T09:20:00.000Z" },
      { hobId: QUILL, turns: 2, tokens: 310, unreported: 0, lastAnsweredAt: "2026-11-14T09:00:00.000Z" },
    ]);
  });
});
