import { CampSuggestionRepository, type JudgedRevisions, type SuggestionRound } from "@hobbots/agents";
import {
  CampSuggestion,
  type CampSuggestionEvent,
  type CampSuggestionId,
  type CampSuggestionRefused,
  CampSuggestions,
  type ChannelId,
  type JournaledEvent,
  planKeep,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import {
  type CampSuggestionRow,
  raiseSuggestion,
  settleSuggestion,
  suggestionById,
  suggestionFromRow,
} from "./camp-suggestion-rows.ts";
import { chapterRows, messagesRevisionOf } from "./chapter-rows.ts";
import { EventJournal, makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

// Camp suggestions' store (ADR 037, migration 0104): Keep in chat, the chat's open suggestions, and
// the camp suggestion projector's cursor and what it writes: the drift suggestions it raises, and the
// pending ones it offers or withdraws (#1557). The threshold rule raises its own, pending, in the
// journal's transaction (`raiseCampSuggestions`).

const PROJECTOR = "camp-drift";

export const CampSuggestionRepositoryLive = Layer.effect(
  CampSuggestionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;
    const change = makeJournaledChange(sql);

    const inState = (channelId: ChannelId, state: "open" | "pending") =>
      sql<CampSuggestionRow>`SELECT * FROM camp_suggestions WHERE channel_id = ${channelId} AND state = ${state}
        ORDER BY raised_at, id`.pipe(Effect.map((rows) => rows.map(suggestionFromRow)));

    const keep = (channelId: ChannelId, suggestionId: CampSuggestionId, at: string) =>
      change<CampSuggestion, CampSuggestionRefused>((first) =>
        Effect.gen(function* () {
          const [row] = yield* sql<CampSuggestionRow>`SELECT * FROM camp_suggestions
            WHERE id = ${suggestionId} AND channel_id = ${channelId}`;
          const planned = planKeep(suggestionId, row === undefined ? null : suggestionFromRow(row), at);
          if (!("kept" in planned)) return yield* Effect.fail(planned);
          if (!planned.changed) return { value: planned.kept, events: [] };
          const kept = new CampSuggestion({ ...planned.kept, revision: first });
          yield* settleSuggestion(sql, kept);
          const event: JournaledEvent = { _tag: "CampSuggestionKept", channelId, suggestion: kept };
          return { value: kept, events: [event] };
        }),
      );

    const driftCursor = sql<{ readonly sequence: unknown }>`SELECT sequence FROM projector_cursors
      WHERE name = ${PROJECTOR}`.pipe(Effect.map(([row]) => Number(row?.sequence ?? 0)));

    const recordRound = (sequence: number, round: SuggestionRound) =>
      change<void, never>((first) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          const events: Array<JournaledEvent> = [];
          // A pending suggestion settled meanwhile, as when its chapter moved, is left as it is.
          // An offer or withdrawal judged from a chapter whose boundaries or messages changed since is
          // stale, so it is left pending: the projector names it again when it reads the change.
          const settle = (
            id: CampSuggestionId,
            event: CampSuggestionEvent,
            tag: "CampSuggestionOffered" | "CampSuggestionExpired",
            judged?: JudgedRevisions,
          ) =>
            Effect.gen(function* () {
              const suggestion = yield* suggestionById(sql, id);
              if (suggestion === null) return;
              if (judged !== undefined) {
                const [chapter] = chapterRows(yield* sql`SELECT * FROM chapters WHERE id = ${suggestion.chapterId}`);
                if (chapter?.revision !== judged.chapterRevision) return;
                if ((yield* messagesRevisionOf(sql, suggestion.chapterId)) !== judged.messagesRevision) return;
              }
              const next = CampSuggestions.transition(suggestion, event);
              if (!(next instanceof CampSuggestion)) return;
              const written = new CampSuggestion({ ...next, revision: first + events.length });
              yield* settleSuggestion(sql, written);
              events.push({ _tag: tag, channelId: written.channelId, suggestion: written });
            });
          for (const withdrawal of round.withdrawn) {
            yield* settle(withdrawal.id, { _tag: "Withdraw", at }, "CampSuggestionExpired", withdrawal);
          }
          for (const offer of round.offers) {
            const event: CampSuggestionEvent = { _tag: "Offer", title: offer.title, goal: offer.goal };
            yield* settle(offer.id, event, "CampSuggestionOffered", offer);
          }
          for (const raise of round.raises) {
            const suggestion = yield* raiseSuggestion(sql, raise.chapterId, raise.reasons, first + events.length, at);
            if (suggestion !== null)
              events.push({ _tag: "CampSuggested", channelId: suggestion.channelId, suggestion });
          }
          // Only forward: a round that read an older page never moves the cursor back.
          yield* sql`UPDATE projector_cursors SET sequence = ${sequence}
            WHERE name = ${PROJECTOR} AND sequence < ${sequence}`;
          return { value: undefined, events };
        }),
      ).pipe(Effect.map((committed) => committed.entries));

    return CampSuggestionRepository.of({
      listOpen: (channelId) => sqlOrDie(inState(channelId, "open")),
      listPending: (channelId) => sqlOrDie(inState(channelId, "pending")),
      keep,
      find: (id) => sqlOrDie(suggestionById(sql, id).pipe(Effect.map(Option.fromNullishOr))),
      driftCursor: sqlOrDie(driftCursor),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      recordRound,
    });
  }),
);
