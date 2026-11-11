import { ChapterRepository } from "@hobbots/agents";
import {
  Chapter,
  ChapterId,
  type ChapterNotFound,
  type ChapterPlan,
  type ChapterRefused,
  ChapterStates,
  type IllegalChapterTransition,
  type JournaledEvent,
  type MessageId,
  planMerge,
  planSplit,
  planStart,
  type SplitPoint,
  type ThreadId,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";

// A thread's chapters (ADR 037, migration 0097). The rules of each command are the pure planners
// in @hobbots/domain; this runs them on the chapters as stored, inside the transaction that writes
// their result and journals its event, so a crash leaves all of a change or none of it.

/** The columns a chapter is stored in. */
export const chapterColumns = (chapter: Chapter) => ({
  id: chapter.id,
  thread_id: chapter.threadId,
  number: chapter.number,
  title: chapter.title,
  summary: chapter.summary,
  state: chapter.state,
  started_at: chapter.startedAt,
  ended_at: chapter.endedAt,
  moved_to: chapter.movedTo,
  revision: chapter.revision,
});

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every number and revision fits a number.
const decodeChapters = Schema.decodeUnknownSync(Schema.Array(Chapter));
const chapterRows = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  decodeChapters(rows.map((row) => ({ ...row, number: Number(row.number), revision: Number(row.revision) })));

/** What a command writes: its plan, and the events that journal it. */
type Written = { readonly value: ChapterPlan; readonly events: ReadonlyArray<JournaledEvent> };

type Refusal = ChapterRefused | ChapterNotFound | IllegalChapterTransition;

const isPlan = <E extends Refusal>(planned: ChapterPlan | E): planned is ChapterPlan => "changed" in planned;

/** The plan with every chapter it changed at `revision`, the sequence of the event that journals it. */
const atRevision = (plan: ChapterPlan, revision: number): ChapterPlan => {
  const changed = new Set(plan.changed.map((chapter) => chapter.id));
  const stamped = plan.chapters.map((chapter) =>
    changed.has(chapter.id) ? new Chapter({ ...chapter, revision }) : chapter,
  );
  return { chapters: stamped, changed: stamped.filter((chapter) => changed.has(chapter.id)) };
};

export const ChapterRepositoryLive = Layer.effect(
  ChapterRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaledChange = makeJournaledChange(sql);

    const listChapters = (threadId: ThreadId) =>
      sql`SELECT * FROM chapters WHERE thread_id = ${threadId} ORDER BY number`.pipe(Effect.map(chapterRows));

    // A command whose chapter already exists, or was merged away, ran before: it changes nothing.
    const ranBefore = (id: ChapterId) =>
      Effect.gen(function* () {
        const known = yield* sql`SELECT id FROM chapters WHERE id = ${id}
          UNION ALL SELECT id FROM merged_chapters WHERE id = ${id}`;
        return known.length > 0;
      });
    const unchanged = (threadId: ThreadId) =>
      listChapters(threadId).pipe(
        Effect.map(
          (chapters): Written => ({
            value: { chapters, changed: [] },
            events: [],
          }),
        ),
      );

    // Writes the chapters a plan changed, in its order: a chapter that stops being live comes before
    // the one that becomes live, which the one-live index needs.
    const writeChanged = (plan: ChapterPlan) =>
      Effect.forEach(
        plan.changed,
        (chapter) =>
          sql`INSERT INTO chapters ${sql.insert(chapterColumns(chapter))} ON CONFLICT (id) DO UPDATE SET
            number = excluded.number,
            title = excluded.title,
            summary = excluded.summary,
            state = excluded.state,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            moved_to = excluded.moved_to,
            revision = excluded.revision`,
        { discard: true },
      );

    // Runs a planned command, or fails with its refusal, which rolls the transaction back.
    const planOrFail = <E extends Refusal>(
      planned: ChapterPlan | E,
      revision: number,
    ): Effect.Effect<ChapterPlan, E> =>
      isPlan(planned) ? Effect.succeed(atRevision(planned, revision)) : Effect.fail(planned);

    const changedOne = (plan: ChapterPlan, id: ChapterId) =>
      plan.changed.find((chapter) => chapter.id === id) as Chapter;

    // A command that makes chapter `id`, its idempotency key, from the thread's chapters as stored.
    const making = (
      threadId: ThreadId,
      id: ChapterId,
      body: (
        first: number,
        chapters: ReadonlyArray<Chapter>,
      ) => Effect.Effect<Written, ChapterRefused | IllegalChapterTransition | SqlError.SqlError>,
    ) =>
      journaledChange<ChapterPlan, ChapterRefused | IllegalChapterTransition>((first) =>
        Effect.gen(function* () {
          if (yield* ranBefore(id)) return yield* unchanged(threadId);
          return yield* body(first, yield* listChapters(threadId));
        }),
      );

    const startChapter = (threadId: ThreadId, input: { id: ChapterId; title: string; at: string }) =>
      making(threadId, input.id, (first, chapters) =>
        Effect.gen(function* () {
          const live = chapters.find(ChapterStates.isLive);
          const held =
            live === undefined ? [] : yield* sql`SELECT 1 FROM messages WHERE chapter_id = ${live.id} LIMIT 1`;
          const plan = yield* planOrFail(
            planStart(threadId, chapters, { ...input, liveHasMessages: held.length > 0 }),
            first,
          );
          yield* writeChanged(plan);
          const chapter = changedOne(plan, input.id);
          const ended = plan.changed.find((c) => c.id !== input.id) ?? null;
          const event: JournaledEvent = { _tag: "ChapterStarted", threadId, chapter, ended };
          return { value: plan, events: [event] };
        }),
      );

    const splitChapter = (threadId: ThreadId, input: { id: ChapterId; messageId: MessageId; title: string }) =>
      making(threadId, input.id, (first, chapters) =>
        Effect.gen(function* () {
          const [at] = yield* sql<{
            readonly chapterId: string;
            readonly createdAt: string;
            readonly seq: unknown;
            readonly first: unknown;
          }>`SELECT m.chapter_id, m.created_at, m.seq,
              (CASE WHEN EXISTS (SELECT 1 FROM messages e WHERE e.chapter_id = m.chapter_id AND e.seq < m.seq)
                THEN 0 ELSE 1 END) AS first
            FROM messages m WHERE m.id = ${input.messageId} AND m.thread_id = ${threadId}`;
          const point: SplitPoint | null =
            at === undefined
              ? null
              : {
                  messageId: input.messageId,
                  chapterId: ChapterId.make(at.chapterId),
                  createdAt: at.createdAt,
                  first: Number(at.first) === 1,
                };
          const plan = yield* planOrFail(planSplit(threadId, chapters, point, input), first);
          yield* writeChanged(plan);
          const from = point?.chapterId as ChapterId;
          yield* sql`UPDATE messages SET chapter_id = ${input.id}
            WHERE chapter_id = ${from} AND seq >= ${Number(at?.seq)}`;
          const event: JournaledEvent = {
            _tag: "ChapterSplit",
            threadId,
            from,
            chapter: input.id,
            messageId: input.messageId,
            chapters: plan.chapters,
          };
          return { value: plan, events: [event] };
        }),
      );

    const mergeChapters = (threadId: ThreadId, chapterId: ChapterId) =>
      journaledChange<ChapterPlan, ChapterRefused | ChapterNotFound | IllegalChapterTransition>((first) =>
        Effect.gen(function* () {
          const merged = yield* sql`SELECT 1 FROM merged_chapters WHERE id = ${chapterId} AND thread_id = ${threadId}`;
          if (merged.length > 0) return yield* unchanged(threadId);
          const chapters = yield* listChapters(threadId);
          const plan = yield* planOrFail(planMerge(threadId, chapters, chapterId), first);
          const into = chapters[chapters.findIndex((chapter) => chapter.id === chapterId) - 1] as Chapter;
          // The messages move before their chapter goes, and it goes before the one it merged into
          // may become live.
          yield* sql`UPDATE messages SET chapter_id = ${into.id} WHERE chapter_id = ${chapterId}`;
          yield* sql`DELETE FROM chapters WHERE id = ${chapterId}`;
          yield* sql`INSERT INTO merged_chapters ${sql.insert({
            id: chapterId,
            thread_id: threadId,
            into_id: into.id,
            merged_at: DateTime.formatIso(yield* DateTime.now),
          })}`;
          yield* writeChanged(plan);
          const event: JournaledEvent = {
            _tag: "ChapterMerged",
            threadId,
            into: into.id,
            absorbed: chapterId,
            chapters: plan.chapters,
          };
          return { value: plan, events: [event] };
        }),
      );

    return ChapterRepository.of({
      listChapters: (threadId) => listChapters(threadId).pipe(Effect.orDie),
      startChapter,
      splitChapter,
      mergeChapters,
    });
  }),
);
