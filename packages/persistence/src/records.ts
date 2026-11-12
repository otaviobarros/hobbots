import { createHash } from "node:crypto";
import { type CrossOutRequest, type DecisionRequest, RecordRepository, type ReviewRequest } from "@hobbots/agents";
import { ThreadNotFound } from "@hobbots/api";
import {
  Artifact,
  ArtifactReviewRefused,
  ChapterId,
  Decision,
  type DecisionId,
  type DecisionPlan,
  DecisionRefused,
  DecisionStates,
  type JournaledEvent,
  planCrossOut,
  planDecision,
  planPullRequestEnded,
  planReview,
  type RegisteredArtifactId,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type Statement } from "effect/sql";
import { type ArtifactRow, artifactFromRow, artifactsFromRows, saveReview, storedVersions } from "./artifact-rows.ts";
import { makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

// Decisions (ADR 037, migration 0101). The rules are the pure `planDecision` and `planCrossOut` in
// @hobbots/domain; this runs them on the decisions as stored, in the transaction that writes their
// result and journals its events, after taking the journal's head, so an archive cannot land between
// the check of the thread and the write. The artifacts registry is written by the journal itself
// (`registerArtifacts`); this reads it and settles each artifact's review (#1422), whose change the
// journal folds into the summaries of the Quests whose Tasks made it.

/** A row of `decisions`, as the SQL client reads it. */
interface DecisionRow {
  readonly id: string;
  readonly threadId: string;
  readonly chapterId: string;
  readonly sourceMessageId: string | null;
  readonly text: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly state: string;
  readonly supersededBy: string | null;
  readonly recordedAt: string;
  readonly supersededAt: string | null;
  readonly requestInput: string;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(Decision);

/** A stored decision; a row that does not decode is a defect, since the hub wrote it. */
const decisionFromRow = (row: DecisionRow) =>
  decode({
    id: row.id,
    threadId: row.threadId,
    chapterId: row.chapterId,
    sourceMessageId: row.sourceMessageId,
    text: row.text,
    actor: { kind: row.actorKind, id: row.actorId },
    state: row.state,
    supersededBy: row.supersededBy,
    recordedAt: row.recordedAt,
    supersededAt: row.supersededAt,
    // PostgreSQL reads BIGINT as a bigint; every revision fits a number.
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

/** The SHA-256 of a request's key or input, so neither's text is kept. */
const digestOf = (purpose: string, value: string) =>
  createHash("sha256").update(`hobbots-decision-${purpose}\0${value}`).digest("hex");

/** A decision at the revision of the event that journals it. */
const at = (decision: Decision, revision: number) => new Decision({ ...decision, revision });

export const RecordRepositoryLive = Layer.effect(
  RecordRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);

    /** Whether the thread is open, failing when it is not there. */
    const threadOpen = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const [thread] = yield* sql<{ readonly state: string }>`SELECT state FROM threads WHERE id = ${threadId}`;
        if (thread === undefined) return yield* new ThreadNotFound({ threadId });
        return thread.state === "open";
      });

    const findIn = (threadId: ThreadId, decisionId: DecisionId) =>
      Effect.gen(function* () {
        const [row] = yield* sql<DecisionRow>`SELECT * FROM decisions
          WHERE id = ${decisionId} AND thread_id = ${threadId}`;
        return row === undefined ? null : yield* decisionFromRow(row);
      });

    /** The chapter a decision joins: its reply's, or the thread's live chapter. */
    const chapterOf = (request: DecisionRequest) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly chapterId: string | null }>`SELECT COALESCE(
            (SELECT m.chapter_id FROM messages m WHERE m.id = ${request.sourceMessageId} AND m.thread_id = ${request.threadId}),
            (SELECT c.id FROM chapters c WHERE c.thread_id = ${request.threadId} AND c.state = 'live')
          ) AS chapter_id`;
        return row?.chapterId == null ? null : ChapterId.make(row.chapterId);
      });

    /** What a retried request recorded: the same decision, and the one it crossed out; nothing is journaled. */
    const recordedBefore = (row: DecisionRow, input: string) =>
      Effect.gen(function* () {
        if (row.requestInput !== input) {
          return yield* new DecisionRefused({
            reason: "key-reused",
            message: "You already used this key for another decision. Choose a new key for a new decision.",
          });
        }
        const recorded = yield* decisionFromRow(row);
        const [replaced] = yield* sql<DecisionRow>`SELECT * FROM decisions WHERE superseded_by = ${recorded.id}`;
        const superseded = replaced === undefined ? null : yield* decisionFromRow(replaced);
        return { value: { recorded, superseded }, events: [] as ReadonlyArray<JournaledEvent> };
      });

    const recordDecision = (request: DecisionRequest) =>
      change<DecisionPlan, DecisionRefused | ThreadNotFound>((first) =>
        Effect.gen(function* () {
          const open = yield* threadOpen(request.threadId);
          // A key is the thread's own: the same key in another thread is another request.
          const key = digestOf("key", `${request.threadId}\0${request.key}`);
          const input = digestOf("input", request.input);
          const [earlier] = yield* sql<DecisionRow>`SELECT * FROM decisions WHERE request_key = ${key}`;
          if (earlier !== undefined) return yield* recordedBefore(earlier, input);
          const chapterId = yield* chapterOf(request);
          if (chapterId === null) return yield* new ThreadNotFound({ threadId: request.threadId });
          const plan = planDecision({
            id: request.id,
            threadId: request.threadId,
            chapterId,
            sourceMessageId: request.sourceMessageId,
            text: request.text,
            actor: request.actor,
            at: request.at,
            threadOpen: open,
            ...(request.replaces === null ? {} : { replaces: yield* findIn(request.threadId, request.replaces) }),
          });
          if (plan instanceof DecisionRefused) return yield* plan;
          const recorded = at(plan.recorded, first);
          const superseded = plan.superseded === null ? null : at(plan.superseded, first + 1);
          yield* sql`INSERT INTO decisions ${sql.insert({
            id: recorded.id,
            thread_id: recorded.threadId,
            chapter_id: recorded.chapterId,
            source_message_id: recorded.sourceMessageId,
            text: recorded.text,
            actor_kind: recorded.actor.kind,
            actor_id: recorded.actor.id,
            state: recorded.state,
            superseded_by: recorded.supersededBy,
            recorded_at: recorded.recordedAt,
            superseded_at: recorded.supersededAt,
            request_key: key,
            request_input: input,
            recorded_sequence: recorded.revision,
            revision: recorded.revision,
          })}`;
          if (superseded !== null) yield* saveSuperseded(superseded);
          const events: Array<JournaledEvent> = [{ _tag: "DecisionRecorded", decision: recorded }];
          if (superseded !== null) events.push({ _tag: "DecisionSuperseded", decision: superseded });
          return { value: { recorded, superseded }, events };
        }),
      );

    const saveSuperseded = (decision: Decision) =>
      sql`UPDATE decisions SET state = ${decision.state}, superseded_by = ${decision.supersededBy},
        superseded_at = ${decision.supersededAt}, revision = ${decision.revision} WHERE id = ${decision.id}`;

    const crossOutDecision = (request: CrossOutRequest) =>
      change<Decision, DecisionRefused | ThreadNotFound>((first) =>
        Effect.gen(function* () {
          const open = yield* threadOpen(request.threadId);
          const found = yield* findIn(request.threadId, request.decisionId);
          // Crossed out already, by a cross-out or a replacement: crossing it out again changes nothing.
          if (found !== null && !DecisionStates.isActive(found)) {
            return { value: found, events: [] as ReadonlyArray<JournaledEvent> };
          }
          const crossed = planCrossOut(found, request.at, open);
          if (crossed instanceof DecisionRefused) return yield* crossed;
          const decision = at(crossed, first);
          yield* saveSuperseded(decision);
          return { value: decision, events: [{ _tag: "DecisionSuperseded" as const, decision }] };
        }),
      );

    const findArtifact = (where: Statement.Fragment) =>
      Effect.gen(function* () {
        const [row] = yield* sql<ArtifactRow>`SELECT * FROM artifacts WHERE ${where}`;
        return row === undefined ? null : yield* artifactFromRow(row);
      });

    /** The artifact at the revision of its `ArtifactReviewSettled`, written and journaled. */
    const settle = (artifact: Artifact, first: number) =>
      Effect.gen(function* () {
        const settled = new Artifact({ ...artifact, revision: first });
        yield* saveReview(sql, settled);
        return { value: settled, events: [{ _tag: "ArtifactReviewSettled" as const, artifact: settled }] };
      });

    const reviewArtifact = (request: ReviewRequest) =>
      change<Artifact, ArtifactReviewRefused | ThreadNotFound>((first) =>
        Effect.gen(function* () {
          yield* threadOpen(request.threadId);
          const artifact = yield* findArtifact(sql`id = ${request.artifactId} AND thread_id = ${request.threadId}`);
          const plan = planReview({ id: request.artifactId, artifact, ...request });
          if (plan instanceof ArtifactReviewRefused) return yield* plan;
          if (!plan.changed) return { value: plan.artifact, events: [] as ReadonlyArray<JournaledEvent> };
          return yield* settle(plan.artifact, first);
        }),
      );

    const endPullRequest = (artifactId: RegisteredArtifactId, at: string) =>
      change<Artifact | null, never>((first) =>
        Effect.gen(function* () {
          const artifact = yield* findArtifact(sql`id = ${artifactId}`);
          const ended = artifact === null ? null : planPullRequestEnded(artifact, at);
          if (ended === null) return { value: null, events: [] as ReadonlyArray<JournaledEvent> };
          return yield* settle(ended, first);
        }),
      );

    return RecordRepository.of({
      recordDecision,
      crossOutDecision,
      reviewArtifact,
      endPullRequest,
      waitingPullRequests: sqlOrDie(
        Effect.flatMap(
          sql<ArtifactRow>`SELECT * FROM artifacts WHERE kind = 'pr' AND review = 'waiting'
            ORDER BY updated_at, id`,
          artifactsFromRows,
        ),
      ),
      listDecisions: (threadId) =>
        sqlOrDie(
          Effect.flatMap(
            sql<DecisionRow>`SELECT * FROM decisions WHERE thread_id = ${threadId}
              ORDER BY recorded_sequence DESC`,
            (rows) => Effect.forEach(rows, decisionFromRow),
          ),
        ),
      artifactVersions: (threadId, artifactId) =>
        sqlOrDie(
          Effect.gen(function* () {
            const artifact = yield* findArtifact(sql`id = ${artifactId} AND thread_id = ${threadId}`);
            if (artifact === null) return Option.none();
            return Option.some({ artifact, versions: yield* storedVersions(sql, artifact) });
          }),
        ),
      listArtifacts: (threadId) =>
        sqlOrDie(
          Effect.flatMap(
            sql<ArtifactRow>`SELECT * FROM artifacts WHERE thread_id = ${threadId}
              ORDER BY updated_at DESC, revision DESC`,
            artifactsFromRows,
          ),
        ),
    });
  }),
);
