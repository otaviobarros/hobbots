import { ChapterSummaryLog, type ChapterSummaryWrite } from "@hobbots/agents";
import { Chapter, ChapterStateMachine, IllegalChapterTransition, type JournaledEvent } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { chapterRows } from "./chapters.ts";
import { EventJournal, makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

// The chapter summary projector's cursor and summaries (migration 0100, #1380). Each summary goes
// through `ChapterStateMachine`'s `Summarize`, so it is written once, only to a chapter that still
// rests with none, and journaled as `ChapterSummarized` in the transaction that moves the cursor.

const PROJECTOR = "chapter-summaries";

export const ChapterSummaryLogLive = Layer.effect(
  ChapterSummaryLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;
    const journaledChange = makeJournaledChange(sql);

    const cursor = sql<{ readonly sequence: unknown }>`SELECT sequence FROM projector_cursors
      WHERE name = ${PROJECTOR}`.pipe(Effect.map(([row]) => Number(row?.sequence ?? 0)));

    // The chapter as it stands, summarized, or null when it no longer takes one.
    const summarized = (write: ChapterSummaryWrite, revision: number) =>
      Effect.gen(function* () {
        const [chapter] = chapterRows(yield* sql`SELECT * FROM chapters WHERE id = ${write.chapterId}`);
        if (chapter === undefined) return null;
        const next = ChapterStateMachine.transition(chapter, { _tag: "Summarize", summary: write.summary });
        if (next instanceof IllegalChapterTransition) return null;
        const written = yield* sql`UPDATE chapters SET summary = ${next.summary}, revision = ${revision}
          WHERE id = ${chapter.id} AND summary IS NULL RETURNING id`;
        return written.length === 0 ? null : new Chapter({ ...next, revision });
      });

    const record = (sequence: number, summaries: ReadonlyArray<ChapterSummaryWrite>) =>
      journaledChange<void, never>((first) =>
        Effect.gen(function* () {
          const events: Array<JournaledEvent> = [];
          for (const write of summaries) {
            const chapter = yield* summarized(write, first + events.length);
            if (chapter !== null) events.push({ _tag: "ChapterSummarized", threadId: chapter.threadId, chapter });
          }
          // Only forward: a round that read an older page never moves the cursor back.
          yield* sql`UPDATE projector_cursors SET sequence = ${sequence}
            WHERE name = ${PROJECTOR} AND sequence < ${sequence}`;
          return { value: undefined, events };
        }),
      ).pipe(Effect.map((committed) => committed.entries));

    return ChapterSummaryLog.of({
      cursor: sqlOrDie(cursor),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      record,
    });
  }),
);
