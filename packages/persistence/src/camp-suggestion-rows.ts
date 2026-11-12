import {
  CampSuggestion,
  CampSuggestionId,
  type CampSuggestionReason,
  CampSuggestions,
  ChapterId,
  campSuggestionReasons,
  isInProgress,
  type JournaledEvent,
  planCampSuggestion,
  ThreadLifecycle,
} from "@hobbots/domain";
import { Array as Arr, DateTime, Effect, Schema } from "effect";
import type { SqlClient, SqlError, Statement } from "effect/sql";
import { chapterRows } from "./chapters.ts";

// Camp suggestions (ADR 037, migration 0103). The rule that raises one is the pure
// `planCampSuggestion` in @hobbots/domain, run here in the transaction whose events grew a chat's
// chapter, as backpack items are (STD-ARCH-016). Suggestions that no longer apply expire in the
// transaction that merged their chapter away or closed their chat.

/** A row of `camp_suggestions`, as the SQL client reads it. */
export interface CampSuggestionRow {
  readonly id: string;
  readonly threadId: string;
  readonly chapterId: string;
  readonly reasons: string;
  readonly state: string;
  readonly raisedAt: string;
  readonly settledAt: string | null;
  readonly campId: string | null;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownSync(CampSuggestion);

/** A stored suggestion; a row that does not decode is a defect, since the hub wrote it. */
export const suggestionFromRow = (row: CampSuggestionRow) =>
  decode({
    id: row.id,
    threadId: row.threadId,
    chapterId: row.chapterId,
    reasons: JSON.parse(row.reasons),
    state: row.state,
    raisedAt: row.raisedAt,
    settledAt: row.settledAt,
    campId: row.campId,
    // PostgreSQL reads BIGINT as a bigint; every revision fits a number.
    revision: Number(row.revision),
  });

const suggestionColumns = (suggestion: CampSuggestion) => ({
  id: suggestion.id,
  thread_id: suggestion.threadId,
  chapter_id: suggestion.chapterId,
  reasons: JSON.stringify(suggestion.reasons),
  state: suggestion.state,
  raised_at: suggestion.raisedAt,
  settled_at: suggestion.settledAt,
  camp_id: suggestion.campId,
  revision: suggestion.revision,
});

/** Writes a suggestion's new state, as a transition left it. */
export const settleSuggestion = (sql: SqlClient.SqlClient, suggestion: CampSuggestion) =>
  sql`UPDATE camp_suggestions SET state = ${suggestion.state}, settled_at = ${suggestion.settledAt},
    camp_id = ${suggestion.campId}, revision = ${suggestion.revision} WHERE id = ${suggestion.id}`;

/** The chapter's suggestion, in any state, or null. */
export const suggestionOfChapter = (sql: SqlClient.SqlClient, chapterId: ChapterId) =>
  sql<CampSuggestionRow>`SELECT * FROM camp_suggestions WHERE chapter_id = ${chapterId}`.pipe(
    Effect.map(([row]) => (row === undefined ? null : suggestionFromRow(row))),
  );

/** What a chapter holds, as the suggestion rule counts it: every record, and its messages past the queue. */
const countsOf = (sql: SqlClient.SqlClient, chapterId: ChapterId) =>
  sql<{
    readonly decisions: unknown;
    readonly artifacts: unknown;
    readonly quests: unknown;
    readonly messages: unknown;
  }>`SELECT
      (SELECT COUNT(*) FROM decisions WHERE chapter_id = ${chapterId}) AS decisions,
      (SELECT COUNT(*) FROM artifacts WHERE chapter_id = ${chapterId}) AS artifacts,
      (SELECT COUNT(*) FROM quests q JOIN tasks t ON t.id = q.task_id
        WHERE t.chapter_id = ${chapterId} AND t.parent_id IS NULL) AS quests,
      (SELECT COUNT(*) FROM messages WHERE chapter_id = ${chapterId} AND status <> 'queued') AS messages`.pipe(
    Effect.map(([row]) => ({
      decisions: Number(row?.decisions ?? 0),
      artifacts: Number(row?.artifacts ?? 0),
      quests: Number(row?.quests ?? 0),
      messages: Number(row?.messages ?? 0),
    })),
  );

/**
 * Raises the chapter's suggestion at `revision`, with `reasons` or, when null, the thresholds it
 * reaches now, unless the rule raises none; the suggestion raised, or null.
 */
export const raiseSuggestion = (
  sql: SqlClient.SqlClient,
  chapterId: ChapterId,
  reasons: ReadonlyArray<CampSuggestionReason> | null,
  revision: number,
  at: string,
) =>
  Effect.gen(function* () {
    const [chapter] = chapterRows(yield* sql`SELECT * FROM chapters WHERE id = ${chapterId}`);
    if (chapter === undefined) return null;
    const [thread] = yield* sql<{ readonly openChat: unknown }>`SELECT
        (CASE WHEN kind = 'chat' AND state = 'open' THEN 1 ELSE 0 END) AS open_chat
      FROM threads WHERE id = ${chapter.threadId}`;
    const openChat = Number(thread?.openChat ?? 0) === 1;
    const suggested = openChat && (yield* suggestionOfChapter(sql, chapterId)) !== null;
    // Counted only when the chapter could take a suggestion, so a busy chapter costs one read.
    const counted =
      openChat && !suggested && reasons === null ? campSuggestionReasons(yield* countsOf(sql, chapterId)) : [];
    const raised = planCampSuggestion({
      thread: { id: chapter.threadId, openChat },
      chapter,
      suggested,
      reasons: reasons ?? counted,
      id: CampSuggestionId.make(crypto.randomUUID()),
      at,
    });
    if (raised === null) return null;
    const suggestion = new CampSuggestion({ ...raised, revision });
    yield* sql`INSERT INTO camp_suggestions ${sql.insert(suggestionColumns(suggestion))}`;
    return suggestion;
  });

/** The chapter a settled message, a decision, an artifact or a quest's start grew, if any. */
const grownChapter = (sql: SqlClient.SqlClient, event: JournaledEvent) =>
  Effect.gen(function* () {
    switch (event._tag) {
      case "DecisionRecorded":
        return event.decision.chapterId;
      case "ArtifactRegistered":
        return event.artifact.chapterId;
      case "MessageUpserted": {
        const { status } = event.message;
        return status === "queued" || isInProgress(status) ? null : event.message.chapterId;
      }
      case "TaskCreated":
      case "QuestStarted": {
        const taskId = event._tag === "TaskCreated" ? event.task.id : event.quest.taskId;
        const [row] = yield* sql<{ readonly chapterId: string | null }>`SELECT r.chapter_id FROM tasks t
          JOIN tasks r ON r.id = t.root_id WHERE t.id = ${taskId}`;
        return row?.chapterId == null ? null : ChapterId.make(row.chapterId);
      }
      default:
        return null;
    }
  });

/**
 * Raises the suggestions a change's events call for (ADR 037), at journal sequences from `first` on,
 * and returns their `CampSuggested` events: one for each chat chapter the events grew past a
 * threshold, at most once per chapter. Only for use within `sql.withTransaction`, after the change wrote.
 */
export const raiseCampSuggestions = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const grown = Arr.dedupe(
      (yield* Effect.forEach(events, (event) => grownChapter(sql, event))).filter(
        (chapterId): chapterId is ChapterId => chapterId !== null,
      ),
    );
    if (grown.length === 0) return [];
    const at = DateTime.formatIso(yield* DateTime.now);
    const raised: Array<JournaledEvent> = [];
    for (const chapterId of grown) {
      const suggestion = yield* raiseSuggestion(sql, chapterId, null, first + raised.length, at);
      if (suggestion !== null) raised.push({ _tag: "CampSuggested", threadId: suggestion.threadId, suggestion });
    }
    return raised;
  });

/** The open suggestions a change's events end: a merged-away chapter's, and every one of a chat that closed. */
const endedSuggestions = (sql: SqlClient.SqlClient, event: JournaledEvent) => {
  const open = (where: Statement.Fragment) =>
    sql<CampSuggestionRow>`SELECT * FROM camp_suggestions WHERE state = 'open' AND ${where} ORDER BY raised_at, id`.pipe(
      Effect.map((rows) => rows.map(suggestionFromRow)),
    );
  switch (event._tag) {
    case "ChapterMerged":
      return open(sql`chapter_id = ${event.absorbed}`);
    case "ThreadUpserted":
      return ThreadLifecycle.isOpen(event.thread) ? Effect.succeed([]) : open(sql`thread_id = ${event.thread.id}`);
    case "ChatStartedFresh":
      return open(sql`thread_id = ${event.superseded.id}`);
    default:
      return Effect.succeed([]);
  }
};

/**
 * Expires the open suggestions a change's events end, at journal sequences from `first` on, and
 * returns their `CampSuggestionExpired` events. Only for use within `sql.withTransaction`.
 */
export const expireCampSuggestions = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const ended = Arr.dedupeWith(
      (yield* Effect.forEach(events, (event) => endedSuggestions(sql, event))).flat(),
      (a, b) => a.id === b.id,
    );
    if (ended.length === 0) return [];
    const at = DateTime.formatIso(yield* DateTime.now);
    const expired: Array<JournaledEvent> = [];
    for (const suggestion of ended) {
      const next = CampSuggestions.transition(suggestion, { _tag: "Expire", at });
      if (!(next instanceof CampSuggestion)) continue;
      const written = new CampSuggestion({ ...next, revision: first + expired.length });
      yield* settleSuggestion(sql, written);
      expired.push({ _tag: "CampSuggestionExpired", threadId: written.threadId, suggestion: written });
    }
    return expired;
  });
