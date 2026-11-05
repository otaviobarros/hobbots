import { HubQuestionRefused, HubQuestionRepository } from "@hobbots/agents";
import { HubQuestion, type HubQuestionId, optionNamed } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { oldestFirst } from "./order.ts";

type Row = Record<string, unknown>;

const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const decodeQuestions = Schema.decodeUnknownEffect(Schema.Array(HubQuestion));

// The subject is three columns and the chat two, both columns or neither; the choices are JSON text.
const fromRow = (row: Row) => ({
  id: row.id,
  subject: { kind: row.subjectKind, key: row.subjectKey, title: row.subjectTitle },
  chat: row.agentId === null || row.threadId === null ? null : { agentId: row.agentId, threadId: row.threadId },
  text: row.text,
  options: JSON.parse(String(row.options)),
  recommended: int(row.recommended),
  state: row.state,
  answer: row.answer,
  picked: int(row.picked),
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
          const [open] = yield* sql<Row>`SELECT * FROM hub_questions WHERE subject_kind = ${input.subject.kind}
            AND subject_key = ${input.subject.key} AND state = 'open' ORDER BY ${oldestFirst(sql)} LIMIT 1`.pipe(
            Effect.flatMap(decode),
          );
          if (open !== undefined) return { value: open, events: [] };
          const question = new HubQuestion({
            id: input.id,
            subject: input.subject,
            chat: input.chat ?? null,
            text: input.text,
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
            subject_kind: question.subject.kind,
            subject_key: question.subject.key,
            subject_title: question.subject.title,
            agent_id: question.chat?.agentId ?? null,
            thread_id: question.chat?.threadId ?? null,
            text: question.text,
            options: JSON.stringify(question.options),
            recommended: question.recommended,
            state: question.state,
            created_at: question.createdAt,
            revision,
          })}`;
          return { value: question, events: [{ _tag: "HubQuestionRaised", hubQuestion: question } as const] };
        }),
      );

    const answer: HubQuestionRepository["Service"]["answer"] = (id, words, at, from) =>
      change((revision) =>
        Effect.gen(function* () {
          const [before] = yield* select(id);
          if (before === undefined) return yield* new HubQuestionRefused({ reason: "missing" });
          if (before.state !== "open") return yield* new HubQuestionRefused({ reason: "closed" });
          // An answer that names one of its choices picked that choice, in the choice's own words (#740).
          const picked = optionNamed(before.options, words);
          const question = new HubQuestion({
            ...before,
            state: "answered",
            answer: picked === null ? words : (before.options[picked]?.label ?? words),
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
