import { ChapterRepository, type SplitInput } from "@hobbots/agents";
import {
  type Channel,
  type ChannelId,
  Chapter,
  ChapterId,
  type ChapterNotFound,
  type ChapterPlan,
  ChapterRefused,
  ChapterStates,
  firstChapter,
  type IllegalChapterTransition,
  type JournaledEvent,
  planMerge,
  planSplit,
  planStart,
  type SplitPoint,
} from "@hobbots/domain";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient, type SqlError, type Statement } from "effect/sql";
import { reconcileSplit } from "./camp-suggestion-rows.ts";
import { keepReadersRead } from "./channel-member-rows.ts";
import { chapterRows, messagesRevisionOf } from "./chapter-rows.ts";
import { makeJournaledChange } from "./journal.ts";

// A channel's chapters (ADR 037, migration 0099). The rules of each command are the pure planners
// in @hobbots/domain; this runs them on the chapters as stored, inside the transaction that writes
// their result and journals its event, so a crash leaves all of a change or none of it.

/** The columns a chapter is stored in. */
export const chapterColumns = (chapter: Chapter) => ({
  id: chapter.id,
  channel_id: chapter.channelId,
  number: chapter.number,
  title: chapter.title,
  summary: chapter.summary,
  state: chapter.state,
  started_at: chapter.startedAt,
  ended_at: chapter.endedAt,
  moved_to: chapter.movedTo,
  revision: chapter.revision,
});

/**
 * Starts the first chapter of `channel` at `revision`, the sequence of the `ChapterStarted` that
 * journals it, unless the channel has chapters already; the chapter started, or null. Every channel
 * stored has a live chapter for its messages to join (ADR 037).
 */
export const startFirstChapterIn = (sql: SqlClient.SqlClient) => (channel: Channel, revision: number) =>
  Effect.gen(function* () {
    const chaptered = yield* sql`SELECT 1 FROM chapters WHERE channel_id = ${channel.id} LIMIT 1`;
    if (chaptered.length > 0) return null;
    const started = new Chapter({
      ...firstChapter(ChapterId.make(crypto.randomUUID()), channel.id, channel.createdAt),
      revision,
    });
    yield* sql`INSERT INTO chapters ${sql.insert(chapterColumns(started))}`;
    return started;
  });

/**
 * Writes the chapters a plan changed, in its order: a chapter that stops being live comes before
 * the one that becomes live, which the one-live index needs.
 */
export const writeChapters = (sql: SqlClient.SqlClient, plan: ChapterPlan) =>
  Effect.forEach(
    plan.changed,
    (chapter) =>
      sql`INSERT INTO chapters ${sql.insert(chapterColumns(chapter))} ON CONFLICT (id) DO UPDATE SET
        channel_id = excluded.channel_id,
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

    const listChapters = (channelId: ChannelId) =>
      sql`SELECT * FROM chapters WHERE channel_id = ${channelId} ORDER BY number`.pipe(Effect.map(chapterRows));

    // A command whose chapter already exists, or was merged away, ran before: it changes nothing.
    const ranBefore = (id: ChapterId) =>
      Effect.gen(function* () {
        const known = yield* sql`SELECT id FROM chapters WHERE id = ${id}
          UNION ALL SELECT id FROM merged_chapters WHERE id = ${id}`;
        return known.length > 0;
      });
    const unchanged = (channelId: ChannelId) =>
      listChapters(channelId).pipe(
        Effect.map(
          (chapters): Written => ({
            value: { chapters, changed: [] },
            events: [],
          }),
        ),
      );

    const writeChanged = (plan: ChapterPlan) => writeChapters(sql, plan);

    // Moves messages to another chapter at `revision`, the sequence of the event that moves them, so a
    // client holding an earlier version of one takes this one. A channel you had read stays read.
    const moveMessages = (channelId: ChannelId, revision: number, to: ChapterId, which: Statement.Fragment) =>
      Effect.gen(function* () {
        yield* keepReadersRead(sql, [channelId], revision);
        yield* sql`UPDATE messages SET chapter_id = ${to}, revision = ${revision} WHERE ${which}`;
      });

    // Decisions and artifacts go where their chapter's messages went (STD-ARCH-019), at the
    // revision of the event that moved them: on a merge every one of the absorbed chapter's, on a
    // split each one whose reply moved. So do the top Tasks started in it: on a split, the ones
    // started from the message it cuts at on (`since`).
    const moveRecords = (revision: number, to: ChapterId, from: ChapterId, since: string | null) =>
      Effect.gen(function* () {
        const merge = since === null;
        const moved = sql`SELECT m.id FROM messages m WHERE m.chapter_id = ${to}`;
        yield* sql`UPDATE decisions SET chapter_id = ${to}, revision = ${revision}
          WHERE chapter_id = ${from} AND ${merge ? sql`1 = 1` : sql`source_message_id IN (${moved})`}`;
        yield* sql`UPDATE artifacts SET chapter_id = ${to}, revision = ${revision}
          WHERE chapter_id = ${from} AND ${merge ? sql`1 = 1` : sql`origin_kind = 'message' AND origin_id IN (${moved})`}`;
        yield* sql`UPDATE tasks SET chapter_id = ${to}
          WHERE chapter_id = ${from} AND ${merge ? sql`1 = 1` : sql`created_at >= ${since}`}`;
      });

    // A change of chapter boundaries leaves nothing behind that was worked out from the old ones: the
    // briefing checkpoint summed up messages that may now be in another chapter (STD-ARCH-018), and
    // `dropped` chapters' sessions, which must not be resumed when one of them is live again.
    const forgetBoundaries = (channelId: ChannelId, dropped: ReadonlyArray<ChapterId>) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM channel_checkpoints WHERE channel_id = ${channelId}`;
        if (dropped.length === 0) return;
        const [row] = yield* sql<{ readonly sessions: unknown }>`SELECT sessions FROM channels WHERE id = ${channelId}`;
        const sessions: ReadonlyArray<{ readonly chapterId?: unknown }> = JSON.parse(String(row?.sessions ?? "[]"));
        const kept = sessions.filter((session) => !dropped.includes(session.chapterId as ChapterId));
        if (kept.length === sessions.length) return;
        yield* sql`UPDATE channels SET sessions = ${JSON.stringify(kept)} WHERE id = ${channelId}`;
      });

    // Runs a planned command, or fails with its refusal, which rolls the transaction back.
    const planOrFail = <E extends Refusal>(
      planned: ChapterPlan | E,
      revision: number,
    ): Effect.Effect<ChapterPlan, E> =>
      isPlan(planned) ? Effect.succeed(atRevision(planned, revision)) : Effect.fail(planned);

    const changedOne = (plan: ChapterPlan, id: ChapterId) =>
      plan.changed.find((chapter) => chapter.id === id) as Chapter;

    // A command that makes chapter `id`, its idempotency key, from the channel's chapters as stored.
    const making = (
      channelId: ChannelId,
      id: ChapterId,
      body: (
        first: number,
        chapters: ReadonlyArray<Chapter>,
      ) => Effect.Effect<Written, ChapterRefused | IllegalChapterTransition | SqlError.SqlError>,
    ) =>
      journaledChange<ChapterPlan, ChapterRefused | IllegalChapterTransition>((first) =>
        Effect.gen(function* () {
          if (yield* ranBefore(id)) return yield* unchanged(channelId);
          return yield* body(first, yield* listChapters(channelId));
        }),
      );

    const startChapter = (channelId: ChannelId, input: { id: ChapterId; title: string; at: string }) =>
      making(channelId, input.id, (first, chapters) =>
        Effect.gen(function* () {
          const live = chapters.find(ChapterStates.isLive);
          const held =
            live === undefined ? [] : yield* sql`SELECT 1 FROM messages WHERE chapter_id = ${live.id} LIMIT 1`;
          const plan = yield* planOrFail(
            planStart(channelId, chapters, { ...input, liveHasMessages: held.length > 0 }),
            first,
          );
          yield* writeChanged(plan);
          yield* forgetBoundaries(channelId, []);
          const chapter = changedOne(plan, input.id);
          const ended = plan.changed.find((c) => c.id !== input.id) ?? null;
          const event: JournaledEvent = { _tag: "ChapterStarted", channelId, chapter, ended };
          return { value: plan, events: [event] };
        }),
      );

    const splitChapter = (channelId: ChannelId, input: SplitInput) =>
      making(channelId, input.id, (first, chapters) =>
        Effect.gen(function* () {
          const [at] = yield* sql<{
            readonly chapterId: string;
            readonly createdAt: string;
            readonly seq: unknown;
            readonly first: unknown;
          }>`SELECT m.chapter_id, m.created_at, m.seq,
              (CASE WHEN EXISTS (SELECT 1 FROM messages e WHERE e.chapter_id = m.chapter_id AND e.seq < m.seq)
                THEN 0 ELSE 1 END) AS first
            FROM messages m WHERE m.id = ${input.messageId} AND m.channel_id = ${channelId}`;
          const point: SplitPoint | null =
            at === undefined
              ? null
              : {
                  messageId: input.messageId,
                  chapterId: ChapterId.make(at.chapterId),
                  createdAt: at.createdAt,
                  first: Number(at.first) === 1,
                };
          // A split the hub judged lands only on the chapter it judged, as it read it (#1557).
          const cut = chapters.find((chapter) => chapter.id === point?.chapterId);
          const { judged } = input;
          const messagesMoved =
            judged?.messagesRevision !== undefined &&
            (yield* messagesRevisionOf(sql, judged.chapterId)) !== judged.messagesRevision;
          if (
            judged !== undefined &&
            (cut?.id !== judged.chapterId || cut.revision !== judged.revision || messagesMoved)
          ) {
            return yield* Effect.fail(new ChapterRefused({ channelId, reason: "chapter-changed" }));
          }
          const plan = yield* planOrFail(planSplit(channelId, chapters, point, input), first);
          yield* writeChanged(plan);
          const from = point?.chapterId as ChapterId;
          yield* moveMessages(channelId, first, input.id, sql`chapter_id = ${from} AND seq >= ${Number(at?.seq)}`);
          yield* moveRecords(first, input.id, from, point?.createdAt ?? null);
          yield* forgetBoundaries(channelId, []);
          const event: JournaledEvent = {
            _tag: "ChapterSplit",
            channelId,
            from,
            chapter: input.id,
            messageId: input.messageId,
            chapters: plan.chapters,
          };
          // The cut chapter's pending camp suggestion is withdrawn when the split was made for it or
          // its thresholds went with the part, which is suggested on its own counts, here (#1557).
          const settled = yield* reconcileSplit(sql, from, input.id, first + 1, input.withdraw);
          return { value: plan, events: [event, ...settled] };
        }),
      );

    const mergeChapters = (channelId: ChannelId, chapterId: ChapterId) =>
      journaledChange<ChapterPlan, ChapterRefused | ChapterNotFound | IllegalChapterTransition>((first) =>
        Effect.gen(function* () {
          const merged =
            yield* sql`SELECT 1 FROM merged_chapters WHERE id = ${chapterId} AND channel_id = ${channelId}`;
          if (merged.length > 0) return yield* unchanged(channelId);
          const chapters = yield* listChapters(channelId);
          const plan = yield* planOrFail(planMerge(channelId, chapters, chapterId), first);
          const into = chapters[chapters.findIndex((chapter) => chapter.id === chapterId) - 1] as Chapter;
          // The messages and records move before their chapter goes, and it goes before the one it merged into
          // may become live.
          yield* moveMessages(channelId, first, into.id, sql`chapter_id = ${chapterId}`);
          yield* moveRecords(first, into.id, chapterId, null);
          yield* sql`DELETE FROM chapters WHERE id = ${chapterId}`;
          yield* sql`INSERT INTO merged_chapters ${sql.insert({
            id: chapterId,
            channel_id: channelId,
            into_id: into.id,
            merged_at: DateTime.formatIso(yield* DateTime.now),
          })}`;
          yield* writeChanged(plan);
          yield* forgetBoundaries(channelId, [into.id, chapterId]);
          const event: JournaledEvent = {
            _tag: "ChapterMerged",
            channelId,
            into: into.id,
            absorbed: chapterId,
            chapters: plan.chapters,
          };
          return { value: plan, events: [event] };
        }),
      );

    return ChapterRepository.of({
      listChapters: (channelId) => listChapters(channelId).pipe(Effect.orDie),
      startChapter,
      splitChapter,
      mergeChapters,
    });
  }),
);
