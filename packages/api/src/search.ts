import { AskAnswer, FIND_QUERY_MAX, FindKind, FindResult, SearchHit, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/** A search or a question, at most `FIND_QUERY_MAX` characters. */
const Query = Schema.String.check(Schema.isMaxLength(FIND_QUERY_MAX));

/** What Ask asks: a question, in one chat or camp (`in`) or everywhere. */
export const AskPayload = Schema.Struct({ question: Query, in: Schema.NullOr(ThreadId) });

export class SearchGroup extends HttpApiGroup.make("search")
  .add(
    // Threads whose title or finished messages contain every word of `q`; retired hobs and private
    // camps are left out. Archived threads are found too; their `thread.archivedAt` marks them.
    HttpApiEndpoint.get("search", "/search", {
      query: { q: Query },
      success: Schema.Array(SearchHit),
    }),
  )
  .add(
    // Decisions, artifacts, chapters and messages with every word of `q`, newest first (ADR 037):
    // in the chat or camp `in`, or everywhere but private camps. `kind` narrows them to one; all by default.
    HttpApiEndpoint.get("find", "/find", {
      query: { q: Query, in: Schema.optionalKey(ThreadId), kind: Schema.optionalKey(FindKind) },
      success: FindResult,
    }),
  )
  .add(
    // The records that match the question, and the hub's brain's answer from them, citing each one
    // it rests on; under No AI, the matches alone. It changes nothing.
    HttpApiEndpoint.post("ask", "/find/ask", { payload: AskPayload, success: AskAnswer }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
