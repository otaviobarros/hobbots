import { ChapterSummaryLog, type ChapterSummaryWrite } from "@hobbots/agents";
import { Chapter, ChapterStateMachine, IllegalChapterTransition, type JournaledEvent } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { chapterRows } from "./chapters.ts";
import { EventJournal, makeJournaledChange } from "./journal.ts";
import { moveProjectorCursor, projectorCursor } from "./projector-cursors.ts";
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

    // The chapter as it stands, summarized, or null when it no longer takes one. A summary made from
    // an older revision is obsolete: a split or merge changed the chapter's messages while the brain
    // wrote it, and the journal entry of that change brings the chapter back to the projector.
    const summarized = (write: ChapterSummaryWrite, revision: number) =>
      Effect.gen(function* () {
        const [chapter] = chapterRows(yield* sql`SELECT * FROM chapters WHERE id = ${write.chapterId}`);
        if (chapter === undefined || chapter.revision !== write.revision) return null;
        const next = ChapterStateMachine.transition(chapter, { _tag: "Summarize", summary: write.summary });
        if (next instanceof IllegalChapterTransition) return null;
        const written = yield* sql`UPDATE chapters SET summary = ${next.summary}, revision = ${revision}
          WHERE id = ${chapter.id} AND summary IS NULL AND revision = ${write.revision} RETURNING id`;
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
          yield* moveProjectorCursor(sql, PROJECTOR, sequence);
          return { value: undefined, events };
        }),
      ).pipe(Effect.map((committed) => committed.entries));

    return ChapterSummaryLog.of({
      cursor: sqlOrDie(projectorCursor(sql, PROJECTOR)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      record,
    });
  }),
);
