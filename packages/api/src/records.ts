import {
  Artifact,
  ArtifactReviewOutcome,
  ArtifactReviewRefusal,
  Brief,
  DECISION_TEXT_MAX,
  Decision,
  DecisionId,
  DecisionRefusal,
  RegisteredArtifactId,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/** A decision you record in a chat or camp (ADR 037); `key` makes the same request record it once. */
export const RecordDecisionPayload = Schema.Struct({
  key: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(DECISION_TEXT_MAX * 2)),
  /** The decision it changes, which is crossed out, or null. */
  replaces: Schema.NullOr(DecisionId),
});
export type RecordDecisionPayload = typeof RecordDecisionPayload.Type;

/** What recording a decision wrote: the decision, and the one it crossed out. */
export const RecordedDecision = Schema.Struct({ recorded: Decision, superseded: Schema.NullOr(Decision) });
export type RecordedDecision = typeof RecordedDecision.Type;

/** A decision that was not recorded or crossed out, with why; nothing changed. */
export class DecisionChangeRefused extends Schema.TaggedError<DecisionChangeRefused>()(
  "DecisionChangeRefused",
  { threadId: ThreadId, reason: DecisionRefusal, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Your review of an artifact: you looked at it, or you chose not to. */
export const ReviewArtifactPayload = Schema.Struct({ outcome: ArtifactReviewOutcome });
export type ReviewArtifactPayload = typeof ReviewArtifactPayload.Type;

/**
 * A review that changed nothing: the artifact is not in the chat or camp (`not-found`), or was
 * settled the other way, by you or by GitHub ending its pull request (`settled`).
 */
export class ArtifactReviewChangeRefused extends Schema.TaggedError<ArtifactReviewChangeRefused>()(
  "ArtifactReviewChangeRefused",
  { threadId: ThreadId, artifactId: RegisteredArtifactId, reason: ArtifactReviewRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * A chat's or camp's records (ADR 037): its decisions, crossed-out ones kept, its artifacts, each
 * once at its latest version, and its brief, which the hub writes. You record a decision or cross one out; a changed decision is a new one
 * that replaces it, never an edit.
 */
export class RecordsGroup extends HttpApiGroup.make("records")
  .add(
    // Newest first, crossed-out ones included.
    HttpApiEndpoint.get("decisions", "/threads/:threadId/decisions", {
      params: { threadId: ThreadId },
      success: Schema.Array(Decision),
      error: ThreadNotFound,
    }),
    HttpApiEndpoint.post("recordDecision", "/threads/:threadId/decisions", {
      params: { threadId: ThreadId },
      payload: RecordDecisionPayload,
      success: RecordedDecision,
      error: [ThreadNotFound, DecisionChangeRefused],
    }),
    // Crossing out a decision crossed out already returns it unchanged.
    HttpApiEndpoint.post("crossOutDecision", "/threads/:threadId/decisions/:decisionId/cross-out", {
      params: { threadId: ThreadId, decisionId: DecisionId },
      success: Decision,
      error: [ThreadNotFound, DecisionChangeRefused],
    }),
    // The most recently changed first.
    HttpApiEndpoint.get("artifacts", "/threads/:threadId/artifacts", {
      params: { threadId: ThreadId },
      success: Schema.Array(Artifact),
      error: ThreadNotFound,
    }),
    // Marks an artifact reviewed or dismisses it (#1422), which lowers what its Quest has ready for
    // review. The same review again returns it unchanged.
    HttpApiEndpoint.post("reviewArtifact", "/threads/:threadId/artifacts/:artifactId/review", {
      params: { threadId: ThreadId, artifactId: RegisteredArtifactId },
      payload: ReviewArtifactPayload,
      success: Artifact,
      error: [ThreadNotFound, ArtifactReviewChangeRefused],
    }),
    // Null until the brief projector first writes one, at a chapter end or a Quest step; its text
    // is empty once nothing it said holds any more.
    HttpApiEndpoint.get("brief", "/threads/:threadId/brief", {
      params: { threadId: ThreadId },
      success: Schema.NullOr(Brief),
      error: ThreadNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
