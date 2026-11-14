import { ChapterBreakRepository } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal } from "./journal.ts";
import { moveProjectorCursor, projectorCursor } from "./projector-cursors.ts";
import { sqlOrDie } from "./sql-errors.ts";

// The chapter break projector's cursor (ADR 039, #1557, migration 20261114193617). The chapters it
// starts are written by the chapter commands, each in its own transaction, keyed by the message it
// starts at, so a page read again after a restart starts none twice.

const PROJECTOR = "chapter-breaks";

export const ChapterBreakRepositoryLive = Layer.effect(
  ChapterBreakRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;
    return ChapterBreakRepository.of({
      cursor: sqlOrDie(projectorCursor(sql, PROJECTOR)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      moveCursor: (sequence) => sqlOrDie(moveProjectorCursor(sql, PROJECTOR, sequence).pipe(Effect.asVoid)),
    });
  }),
);
