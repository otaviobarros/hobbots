import { CatchUpRepository, PinRepository } from "@hobbots/agents";
import { MessageNotFound } from "@hobbots/api";
import { type JournaledEvent, MessageId, MessagePin, ThreadId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient, type Statement } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { readQuestSummaries } from "./quest-summary-rows.ts";
import { sqlOrDie } from "./sql-errors.ts";

// Pins (ADR 037, migration 0106) and what catch-up reads besides the transcript and the records: the
// read marker and the Quests followed in the thread.

interface PinRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly pinnedAt: string;
  readonly revision: unknown;
}

const pinFromRow = (row: PinRow) =>
  new MessagePin({
    messageId: MessageId.make(row.messageId),
    threadId: ThreadId.make(row.threadId),
    pinnedAt: row.pinnedAt,
    revision: Number(row.revision),
  });

export const PinRepositoryLive = Layer.effect(
  PinRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);

    // A pin's thread is its message's, wherever the message is now.
    const pinsWhere = (where: Statement.Fragment) =>
      sql<PinRow>`SELECT p.message_id, m.thread_id, p.pinned_at, p.revision
        FROM message_pins p JOIN messages m ON m.id = p.message_id WHERE ${where}
        ORDER BY p.revision DESC`.pipe(Effect.map((rows) => rows.map(pinFromRow)));

    const setPinned = (threadId: ThreadId, messageId: MessageId, pinned: boolean, at: string) =>
      change<MessagePin | null, MessageNotFound>((first) =>
        Effect.gen(function* () {
          const [message] = yield* sql`SELECT 1 FROM messages WHERE id = ${messageId} AND thread_id = ${threadId}`;
          if (message === undefined) return yield* Effect.fail(new MessageNotFound({ threadId, messageId }));
          const [held] = yield* pinsWhere(sql`p.message_id = ${messageId}`);
          if (pinned) {
            if (held !== undefined) return { value: held, events: [] };
            const pin = new MessagePin({ messageId, threadId, pinnedAt: at, revision: first });
            yield* sql`INSERT INTO message_pins ${sql.insert({ message_id: messageId, pinned_at: at, revision: first })}`;
            const event: JournaledEvent = { _tag: "MessagePinned", pin };
            return { value: pin, events: [event] };
          }
          if (held === undefined) return { value: null, events: [] };
          yield* sql`DELETE FROM message_pins WHERE message_id = ${messageId}`;
          const event: JournaledEvent = { _tag: "MessageUnpinned", threadId, messageId };
          return { value: null, events: [event] };
        }),
      );

    return PinRepository.of({
      setPinned,
      listPins: (threadId) => sqlOrDie(pinsWhere(sql`m.thread_id = ${threadId}`)),
    });
  }),
);

export const CatchUpRepositoryLive = Layer.effect(
  CatchUpRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const marker = (threadId: ThreadId) =>
      sql<{ readonly readRevision: unknown }>`SELECT read_revision FROM threads WHERE id = ${threadId}`.pipe(
        Effect.map(([row]) => (row?.readRevision == null ? null : Number(row.readRevision))),
      );

    const quests = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const summaries = yield* readQuestSummaries(sql, threadId);
        if (summaries.length === 0) return [];
        const goals = yield* sql<{ readonly id: string; readonly goal: string }>`SELECT id, goal FROM quests
          WHERE ${sql.in(
            "id",
            summaries.map((summary) => summary.questId),
          )}`;
        const goalOf = new Map(goals.map((row) => [row.id, row.goal]));
        return summaries.map((summary) => ({ summary, goal: goalOf.get(summary.questId) ?? "" }));
      });

    return CatchUpRepository.of({
      marker: (threadId) => sqlOrDie(marker(threadId)),
      quests: (threadId) => sqlOrDie(quests(threadId)),
    });
  }),
);
