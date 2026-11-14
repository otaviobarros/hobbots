import { HobbotsRepository, ThreadMemberRepository } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  type Actor,
  Agent,
  AgentId,
  DeviceId,
  hobActor,
  Message,
  MessageId,
  MessageTransitions,
  OWNER_ACTOR,
  Thread,
  ThreadId,
  UserId,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, ThreadMemberRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1455 (ADR 039, Who answers; Users as actors): a message's @mentions are parsed once, when
// it is stored with its final text, and kept in order; the mentions of each person they have not
// read are counted for them alone. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-13T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const ROOK = AgentId.make("rook");
const CAMP = ThreadId.make("camp");
const BRUNA: Actor = { kind: "user", id: "bruna" };

type Services = HobbotsRepository | ThreadMemberRepository | EventJournal | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive, EventJournal.layer).pipe(
        Layer.provideMerge(TestDatabase),
      ),
    ),
    Effect.runPromise,
  );

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
    createdAt: NOW,
  });

/** A request from Bruna's phone: the session the hub's device middleware provides. */
const brunaSession = UserSession.of({
  deviceId: DeviceId.make("phone"),
  name: "Phone",
  kind: "browser",
  userId: UserId.make("bruna"),
  actor: BRUNA,
  whileApproved: (write) => write,
});

let next = 0;
const message = (fields: Partial<Message> & Pick<Message, "role" | "content">) =>
  new Message({
    id: MessageId.make(`m${++next}`),
    threadId: CAMP,
    actor: fields.role === "assistant" ? null : OWNER_ACTOR,
    status: "complete",
    error: null,
    configVersion: fields.role === "assistant" ? 1 : null,
    createdAt: NOW,
    revision: 0,
    ...fields,
  });

/** Aldric and Rook, Bruna as a person of the hub, and a camp of Aldric's with Bruna in it. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* repo.insertAgent(hob(ALDRIC, "Aldric"));
  yield* repo.insertAgent(hob(ROOK, "Rook"));
  yield* sql`INSERT INTO users ${sql.insert({ id: "bruna", name: "Bruna", initials: "B", color: "moss", state: "active" })}`;
  yield* repo.makeCamp(
    new Thread({ id: CAMP, agentId: ALDRIC, title: "Camp", kind: "camp", createdAt: NOW, updatedAt: NOW }),
  );
  yield* Effect.flatMap(ThreadMemberRepository, (members) => members.add(CAMP, BRUNA, OWNER_ACTOR));
});

const unread = (actor: Actor) => Effect.flatMap(ThreadMemberRepository, (members) => members.unreadMentions(actor));

describe("message mentions", () => {
  // covers ADR 039 (Who answers)
  it("[TC-PE-1455-01] stores a message's mentions in order, hobs and people, and reads and journals them", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        const sent = yield* repo.upsertMessage(
          message({ role: "user", content: "@rook and @Bruna, then `@Aldric` in code and @Aldric. @Rook again" }),
        );
        const plain = yield* repo.upsertMessage(message({ role: "user", content: "Nobody here, ana@aldric.dev" }));
        const [stored] = (yield* repo.listMessages(CAMP)).filter((each) => each.id === sent.value.id);
        const entries = yield* journal.readAfter(0);
        const upserted = entries.flatMap((entry) =>
          entry.payload._tag === "MessageUpserted" && entry.payload.message.id === sent.value.id
            ? [entry.payload.message.mentions]
            : [],
        );
        return { saved: sent.value.mentions, stored: stored?.mentions, upserted, plain: plain.value.mentions };
      }),
    );
    const expected = [hobActor(ROOK), BRUNA, hobActor(ALDRIC)];
    expect(result.saved).toEqual(expected);
    expect(result.stored).toEqual(expected);
    expect(result.upserted).toEqual([expected]);
    expect(result.plain).toEqual([]);
  });

  // covers ADR 039 (Who answers)
  it("[TC-PE-1455-02] parses a reply once it ends, never while it streams, and keeps what it parsed", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        const streaming = yield* repo.upsertMessage(
          message({ role: "assistant", content: "Asking @Rook", status: "streaming" }),
        );
        const ended = yield* repo.upsertMessage(
          new Message({ ...streaming.value, content: "Asking @Rook and @Bruna", status: "complete" }),
        );
        // Renaming Rook later changes nothing a stored message mentions.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agents SET name = 'Quill' WHERE id = ${ROOK}`;
        const again = yield* repo.upsertMessage(new Message({ ...ended.value, quiet: false }));
        return { streaming: streaming.value.mentions, ended: ended.value.mentions, again: again.value.mentions };
      }),
    );
    expect(result.streaming).toEqual([]);
    expect(result.ended).toEqual([hobActor(ROOK), BRUNA]);
    expect(result.again).toEqual([hobActor(ROOK), BRUNA]);
  });

  // covers ADR 039 (Who answers)
  it("[TC-PE-1455-04] keeps a continued reply's mentions while it streams and adds only those of its new text", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        const streaming = yield* repo.upsertMessage(message({ role: "assistant", content: "", status: "streaming" }));
        // The text streamed so far is saved before the reply ends, with the same words it ends with.
        yield* repo.checkpointMessage(new Message({ ...streaming.value, content: "Asking @Rook" }));
        const cut = yield* repo.upsertMessage(
          new Message({ ...streaming.value, content: "Asking @Rook", status: "interrupted", error: "lost" }),
        );
        // Rook is renamed and Aldric takes its old name: what the kept text mentions was decided already.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agents SET name = 'Quill' WHERE id = ${ROOK}`;
        yield* sql`UPDATE agents SET name = 'Rook' WHERE id = ${ALDRIC}`;
        const resumed = MessageTransitions.resume(cut.value);
        if (!(resumed instanceof Message)) return yield* Effect.die(resumed);
        const continued = yield* repo.upsertMessage(resumed);
        const ended = yield* repo.upsertMessage(
          new Message({ ...continued.value, content: "Asking @Rook, then @Bruna", status: "complete" }),
        );
        return { cut: cut.value.mentions, continued: continued.value.mentions, ended: ended.value.mentions };
      }),
    );
    expect(result.cut).toEqual([hobActor(ROOK)]);
    expect(result.continued).toEqual([hobActor(ROOK)]);
    expect(result.ended).toEqual([hobActor(ROOK), BRUNA]);
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1455-03] counts each person's unread mentions for them alone, and clears them as they read", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        yield* repo.upsertMessage(message({ role: "user", content: "@Bruna can you look?" }));
        // The owner's own mention of themself and a note to self count for no one.
        yield* repo.upsertMessage(message({ role: "user", content: "@Owner remember this" }));
        yield* repo.upsertMessage(message({ role: "note", content: "@Bruna later" }));
        const last = yield* repo.upsertMessage(message({ role: "assistant", content: "@Bruna and @Owner, done" }));
        const before = { bruna: yield* unread(BRUNA), owner: yield* unread(OWNER_ACTOR) };
        yield* repo
          .markThreadRead(CAMP, last.value.id, last.value.revision)
          .pipe(Effect.provideService(UserSession, brunaSession));
        const after = { bruna: yield* unread(BRUNA), owner: yield* unread(OWNER_ACTOR) };
        return { before, after };
      }),
    );
    expect(result.before).toEqual({
      bruna: [{ threadId: CAMP, count: 2 }],
      owner: [{ threadId: CAMP, count: 1 }],
    });
    expect(result.after).toEqual({ bruna: [], owner: [{ threadId: CAMP, count: 1 }] });
  });
});
