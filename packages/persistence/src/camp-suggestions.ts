import { CampSuggestionRepository, type DriftRaise } from "@hobbots/agents";
import {
  CampSuggestion,
  type CampSuggestionId,
  type CampSuggestionRefused,
  type JournaledEvent,
  planKeep,
  type ThreadId,
} from "@hobbots/domain";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  type CampSuggestionRow,
  raiseSuggestion,
  settleSuggestion,
  suggestionFromRow,
} from "./camp-suggestion-rows.ts";
import { EventJournal, makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

// Camp suggestions' store (ADR 037, migration 0103): Keep in chat, the chat's open suggestions, and
// the camp drift projector's cursor and the suggestions it raises. The threshold rule raises its own
// in the journal's transaction (`raiseCampSuggestions`).

const PROJECTOR = "camp-drift";

export const CampSuggestionRepositoryLive = Layer.effect(
  CampSuggestionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;
    const change = makeJournaledChange(sql);

    const listOpen = (threadId: ThreadId) =>
      sql<CampSuggestionRow>`SELECT * FROM camp_suggestions WHERE thread_id = ${threadId} AND state = 'open'
        ORDER BY raised_at, id`.pipe(Effect.map((rows) => rows.map(suggestionFromRow)));

    const keep = (threadId: ThreadId, suggestionId: CampSuggestionId, at: string) =>
      change<CampSuggestion, CampSuggestionRefused>((first) =>
        Effect.gen(function* () {
          const [row] = yield* sql<CampSuggestionRow>`SELECT * FROM camp_suggestions
            WHERE id = ${suggestionId} AND thread_id = ${threadId}`;
          const planned = planKeep(suggestionId, row === undefined ? null : suggestionFromRow(row), at);
          if (!("kept" in planned)) return yield* Effect.fail(planned);
          if (!planned.changed) return { value: planned.kept, events: [] };
          const kept = new CampSuggestion({ ...planned.kept, revision: first });
          yield* settleSuggestion(sql, kept);
          const event: JournaledEvent = { _tag: "CampSuggestionKept", threadId, suggestion: kept };
          return { value: kept, events: [event] };
        }),
      );

    const driftCursor = sql<{ readonly sequence: unknown }>`SELECT sequence FROM projector_cursors
      WHERE name = ${PROJECTOR}`.pipe(Effect.map(([row]) => Number(row?.sequence ?? 0)));

    const recordDrift = (sequence: number, raises: ReadonlyArray<DriftRaise>) =>
      change<void, never>((first) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          const events: Array<JournaledEvent> = [];
          for (const raise of raises) {
            const suggestion = yield* raiseSuggestion(sql, raise.chapterId, raise.reasons, first + events.length, at);
            if (suggestion !== null) events.push({ _tag: "CampSuggested", threadId: suggestion.threadId, suggestion });
          }
          // Only forward: a round that read an older page never moves the cursor back.
          yield* sql`UPDATE projector_cursors SET sequence = ${sequence}
            WHERE name = ${PROJECTOR} AND sequence < ${sequence}`;
          return { value: undefined, events };
        }),
      ).pipe(Effect.map((committed) => committed.entries));

    return CampSuggestionRepository.of({
      listOpen: (threadId) => sqlOrDie(listOpen(threadId)),
      keep,
      driftCursor: sqlOrDie(driftCursor),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      recordDrift,
    });
  }),
);
