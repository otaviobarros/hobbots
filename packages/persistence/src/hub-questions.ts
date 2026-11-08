import { HubQuestionRefused, HubQuestionRepository } from "@hobbots/agents";
import { HubQuestion, type HubQuestionId } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { oldestFirst } from "./order.ts";

type Row = Record<string, unknown>;

const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const decodeQuestions = Schema.decodeUnknownEffect(Schema.Array(HubQuestion));

// The chat is two columns, both or neither; what it asks and the keys of its choices are JSON text.
// The kind is kept in its own column too, to find a kind's questions.
const fromRow = (row: Row) => ({
  id: row.id,
  key: row.subjectKey,
  chat: row.agentId === null || row.threadId === null ? null : { agentId: row.agentId, threadId: row.threadId },
  ask: JSON.parse(String(row.ask)),
  options: JSON.parse(String(row.options)),
  recommended: row.recommended,
  state: row.state,
  answer: row.answer,
  picked: row.picked,
  createdAt: row.createdAt,
  answeredAt: row.answeredAt,
  answeredByDeviceId: row.answeredByDeviceId,
  answeredVia: row.answeredVia,
  revision: int(row.revision),
});

/** The SQL store of the questions the hub itself puts to you (#976), for SQLite and PostgreSQL. */
export const HubQuestionRepositoryLive = Layer.effect(
  HubQuestionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
    const decode = (rows: ReadonlyArray<Row>) => decodeQuestions(rows.map(fromRow)).pipe(Effect.orDie);
    const select = (id: string) => sql<Row>`SELECT * FROM hub_questions WHERE id = ${id}`.pipe(Effect.flatMap(decode));

    const raise: HubQuestionRepository["Service"]["raise"] = (input) =>
      change((revision) =>
        Effect.gen(function* () {
          // The hub asks about each thing once: while a question about it is open, that one stands.
          const [open] = yield* sql<Row>`SELECT * FROM hub_questions WHERE subject_kind = ${input.ask.kind}
            AND subject_key = ${input.key} AND state = 'open' ORDER BY ${oldestFirst(sql)} LIMIT 1`.pipe(
            Effect.flatMap(decode),
          );
          if (open !== undefined) return { value: open, events: [] };
          const question = new HubQuestion({
            id: input.id,
            key: input.key,
            chat: input.chat ?? null,
            ask: input.ask,
            options: input.options ?? [],
            recommended: input.recommended ?? null,
            state: "open",
            answer: null,
            picked: null,
            createdAt: input.createdAt,
            answeredAt: null,
            answeredByDeviceId: null,
            answeredVia: null,
            revision,
          });
          yield* sql`INSERT INTO hub_questions ${sql.insert({
            id: question.id,
            subject_kind: question.ask.kind,
            subject_key: question.key,
            agent_id: question.chat?.agentId ?? null,
            thread_id: question.chat?.threadId ?? null,
            ask: JSON.stringify(question.ask),
            options: JSON.stringify(question.options),
            recommended: question.recommended,
            state: question.state,
            created_at: question.createdAt,
            revision,
          })}`;
          return { value: question, events: [{ _tag: "HubQuestionRaised", hubQuestion: question } as const] };
        }),
      );

    const answer: HubQuestionRepository["Service"]["answer"] = (id, given, at, from) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* select(id);
          if (before === undefined) return yield* new HubQuestionRefused({ reason: "missing" });
          if (before.state !== "open") return yield* new HubQuestionRefused({ reason: "closed" });
          // A choice is picked by its key, and only one the question offers (#1045).
          const picked = "picked" in given ? given.picked : null;
          if (picked !== null && !before.options.includes(picked))
            return yield* new HubQuestionRefused({ reason: "unknown-choice" });
          const question = new HubQuestion({
            ...before,
            state: "answered",
            answer: "words" in given ? given.words : null,
            picked,
            answeredAt: at,
            answeredByDeviceId: from.deviceId,
            answeredVia: from.via,
            revision,
          });
          yield* sql`UPDATE hub_questions SET state = 'answered', answer = ${question.answer},
            picked = ${question.picked}, answered_at = ${at}, answered_by_device_id = ${from.deviceId},
            answered_via = ${from.via}, revision = ${revision} WHERE id = ${id}`;
          return { value: question, events: [{ _tag: "HubQuestionAnswered", hubQuestion: question } as const] };
        }),
      );

    const withdraw: HubQuestionRepository["Service"]["withdraw"] = (id) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* select(id);
          if (before === undefined || before.state !== "open")
            return yield* new HubQuestionRefused({ reason: "closed" });
          const question = new HubQuestion({ ...before, state: "withdrawn", revision });
          yield* sql`UPDATE hub_questions SET state = 'withdrawn', revision = ${revision} WHERE id = ${id}`;
          return { value: question, events: [{ _tag: "HubQuestionWithdrawn", hubQuestion: question } as const] };
        }),
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTag("HubQuestionRefused", () => Effect.succeed(Option.none())),
      );

    return HubQuestionRepository.of({
      raise,
      answer,
      withdraw,
      find: (id: HubQuestionId) =>
        select(id).pipe(
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
          Effect.orDie,
        ),
      listOpen: sql<Row>`SELECT * FROM hub_questions WHERE state = 'open' ORDER BY ${oldestFirst(sql)}`.pipe(
        Effect.flatMap(decode),
        Effect.orDie,
      ),
      listUnapplied: (kind) =>
        sql<Row>`SELECT * FROM hub_questions WHERE subject_kind = ${kind} AND state = 'answered'
          AND applied_at IS NULL ORDER BY ${oldestFirst(sql)}`.pipe(Effect.flatMap(decode), Effect.orDie),
      markApplied: (id, at) =>
        sql`UPDATE hub_questions SET applied_at = ${at} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
