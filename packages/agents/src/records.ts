import { ThreadNotFound } from "@hobbots/api";
import {
  type Actor,
  type Artifact,
  type ArtifactReviewOutcome,
  type ArtifactReviewRefused,
  type Committed,
  type Decision,
  type DecisionId,
  DecisionId as DecisionIds,
  type DecisionPlan,
  type DecisionRefused,
  DecisionStates,
  hobActor,
  type MessageId,
  OWNER_ACTOR,
  RECORD_DECISION_DESCRIPTION,
  RECORD_DECISION_LABEL,
  RECORD_DECISION_TOOL,
  RecordDecisionInput,
  type RegisteredArtifactId,
  recordDecisionJsonSchema,
  type StoredVersion,
  stableJson,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import type { CharmTurn } from "./charms.ts";
import { announcer, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import type { HubTool, HubToolAnswer, HubTools } from "./runtime.ts";
import { PackRecordSource } from "./turn-pack.ts";

/**
 * Decisions and the artifacts registry (ADR 037, Records). Decisions are recorded by a hob's
 * `record_decision`, on every runtime that serves hub tools, or by you in the app, and crossed out,
 * never edited. Artifacts are registered by the hub itself, in the transaction that journals the
 * records it indexes; you review or dismiss each, and the GitHub Charm reviews a pull request once
 * GitHub reports it merged or closed (#1422).
 */

/** A decision to record, as the command takes it. */
export interface DecisionRequest {
  /** The new decision's id, used once its request key is new. */
  readonly id: DecisionId;
  readonly threadId: ThreadId;
  /** The reply whose turn recorded it, whose chapter it joins; null for one you recorded in the app, which joins the live chapter. */
  readonly sourceMessageId: MessageId | null;
  readonly text: string;
  readonly replaces: DecisionId | null;
  readonly actor: Actor;
  /**
   * The request's idempotency key: the same key with the same input returns the decision it
   * recorded, and with another input is refused (`key-reused`). The store keeps a digest of it and
   * of `input`, never their text.
   */
  readonly key: string;
  /** What the request asked, as the record compares a retry with it. */
  readonly input: string;
  readonly at: string;
}

/** An artifact and its versions as the registry keeps them. */
export interface StoredArtifact {
  readonly artifact: Artifact;
  readonly versions: ReadonlyArray<StoredVersion>;
}

/** A decision to cross out with nothing in its place. */
export interface CrossOutRequest {
  readonly threadId: ThreadId;
  readonly decisionId: DecisionId;
  readonly at: string;
}

/** Your review of an artifact in a chat or camp. */
export interface ReviewRequest {
  readonly threadId: ThreadId;
  readonly artifactId: RegisteredArtifactId;
  readonly outcome: ArtifactReviewOutcome;
  readonly by: Actor;
  readonly at: string;
}

/**
 * Where decisions and artifacts are kept (ADR 037). Each command runs its pure rule and journals
 * its events in one transaction.
 */
export class RecordRepository extends Context.Service<
  RecordRepository,
  {
    /**
     * Records a decision, journaled as `DecisionRecorded`, and crosses out the one it replaces in the
     * same transaction, journaled as `DecisionSuperseded` after it. A retried key changes nothing.
     */
    readonly recordDecision: (
      request: DecisionRequest,
    ) => Effect.Effect<Committed<DecisionPlan>, DecisionRefused | ThreadNotFound>;
    /**
     * Crosses a decision out with nothing in its place, journaled as `DecisionSuperseded`. One
     * crossed out already is returned as it is, and nothing is journaled.
     */
    readonly crossOutDecision: (
      request: CrossOutRequest,
    ) => Effect.Effect<Committed<Decision>, DecisionRefused | ThreadNotFound>;
    /** The thread's decisions, crossed-out ones included, newest first. */
    readonly listDecisions: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Decision>>;
    /** The thread's artifacts, each once at its latest version, the most recently changed first. */
    readonly listArtifacts: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Artifact>>;
    /**
     * One of the thread's artifacts with its versions, oldest first, each with where its contents
     * are (#1434); none when the thread has no such artifact.
     */
    readonly artifactVersions: (
      threadId: ThreadId,
      artifactId: RegisteredArtifactId,
    ) => Effect.Effect<Option.Option<StoredArtifact>>;
    /**
     * Reviews or dismisses an artifact waiting for you, journaled as `ArtifactReviewSettled` with the
     * summaries of the Quests whose Tasks made it. One settled that way already is returned as it is,
     * and nothing is journaled.
     */
    readonly reviewArtifact: (
      request: ReviewRequest,
    ) => Effect.Effect<Committed<Artifact>, ArtifactReviewRefused | ThreadNotFound>;
    /**
     * Reviews a pull request artifact GitHub reported merged or closed, journaled as
     * `ArtifactReviewSettled`. Null, with nothing journaled, when it no longer waits for review.
     */
    readonly endPullRequest: (
      artifactId: RegisteredArtifactId,
      at: string,
    ) => Effect.Effect<Committed<Artifact | null>>;
    /** Every pull request artifact still waiting for review, in every chat and camp, oldest change first. */
    readonly waitingPullRequests: Effect.Effect<ReadonlyArray<Artifact>>;
  }
>()("@hobbots/agents/RecordRepository") {}

/** The request key of a call, by where it was made: the app, or a hob's reply. */
const keyOf = (place: "app" | "reply", key: string) => stableJson({ place, key });

/** What a request asked, as a retry is compared with it. */
const inputOf = (text: string, replaces: DecisionId | null) => stableJson({ text, replaces });

/**
 * The decision commands (ADR 037): record and cross out, each announced once committed, and the
 * reads the camp sheet and the context pack take: a thread's decisions, its active ones and its
 * artifacts. A thread that is not there is refused before anything is written.
 */
export class Records extends Context.Service<
  Records,
  {
    /** Records a decision you made in the app; `key` makes a retried request record it once. */
    readonly recordYours: (
      threadId: ThreadId,
      input: { readonly key: string; readonly text: string; readonly replaces: DecisionId | null },
    ) => Effect.Effect<DecisionPlan, DecisionRefused | ThreadNotFound>;
    /** Records a decision a hob's turn made, from `record_decision`. */
    readonly recordHobs: (
      request: Omit<DecisionRequest, "at">,
    ) => Effect.Effect<DecisionPlan, DecisionRefused | ThreadNotFound>;
    /** Crosses a decision out with nothing in its place; again, it changes nothing. */
    readonly crossOut: (
      threadId: ThreadId,
      decisionId: DecisionId,
    ) => Effect.Effect<Decision, DecisionRefused | ThreadNotFound>;
    readonly decisionsOf: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Decision>, ThreadNotFound>;
    /** The decisions that hold, newest first: what the context pack carries. */
    readonly activeDecisions: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Decision>>;
    /** The artifacts index, the most recently changed first: what the context pack carries. */
    readonly artifactsOf: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Artifact>>;
    /** Marks an artifact you looked at reviewed, or dismisses it; the same again changes nothing. */
    readonly review: (
      threadId: ThreadId,
      artifactId: RegisteredArtifactId,
      outcome: ArtifactReviewOutcome,
    ) => Effect.Effect<Artifact, ArtifactReviewRefused | ThreadNotFound>;
    /** Every pull request artifact still waiting for review, for the GitHub Charm to check. */
    readonly waitingPullRequests: Effect.Effect<ReadonlyArray<Artifact>>;
    /** Reviews a pull request artifact GitHub reported merged or closed; null when it no longer waits. */
    readonly pullRequestEnded: (artifactId: RegisteredArtifactId) => Effect.Effect<Artifact | null>;
  }
>()("@hobbots/agents/Records") {
  static readonly layer = Layer.effect(
    Records,
    Effect.gen(function* () {
      const records = yield* RecordRepository;
      const repo = yield* HobbotsRepository;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a record");
      const now = Effect.map(DateTime.now, DateTime.formatIso);

      const known = (threadId: ThreadId) =>
        Effect.flatMap(repo.findThread(threadId), (found) =>
          Option.isNone(found) ? Effect.fail(new ThreadNotFound({ threadId })) : Effect.void,
        );
      const announced = <A, E>(command: Effect.Effect<Committed<A>, E>) =>
        Effect.flatMap(command, (committed) => Effect.as(announce(committed.entries), committed.value));

      return Records.of({
        recordYours: (threadId, input) =>
          Effect.gen(function* () {
            yield* known(threadId);
            return yield* announced(
              records.recordDecision({
                id: DecisionIds.make(crypto.randomUUID()),
                threadId,
                sourceMessageId: null,
                text: input.text,
                replaces: input.replaces,
                actor: OWNER_ACTOR,
                key: keyOf("app", input.key),
                input: inputOf(input.text, input.replaces),
                at: yield* now,
              }),
            );
          }),
        recordHobs: (request) =>
          Effect.gen(function* () {
            yield* known(request.threadId);
            return yield* announced(records.recordDecision({ ...request, at: yield* now }));
          }),
        crossOut: (threadId, decisionId) =>
          Effect.gen(function* () {
            yield* known(threadId);
            return yield* announced(records.crossOutDecision({ threadId, decisionId, at: yield* now }));
          }),
        decisionsOf: (threadId) => Effect.andThen(known(threadId), records.listDecisions(threadId)),
        activeDecisions: (threadId) =>
          Effect.map(records.listDecisions(threadId), (all) => all.filter(DecisionStates.isActive)),
        artifactsOf: (threadId) => records.listArtifacts(threadId),
        review: (threadId, artifactId, outcome) =>
          Effect.gen(function* () {
            yield* known(threadId);
            return yield* announced(
              records.reviewArtifact({ threadId, artifactId, outcome, by: OWNER_ACTOR, at: yield* now }),
            );
          }),
        waitingPullRequests: records.waitingPullRequests,
        pullRequestEnded: (artifactId) =>
          Effect.flatMap(now, (at) => announced(records.endPullRequest(artifactId, at))),
      });
    }),
  );
}

/**
 * The Records set (ADR 037): `record_decision`, for a turn that writes a reply in a chat or camp. A
 * session outside any chat, a step's or a party member's, has no chat to decide in and is offered
 * none. Absent, a turn offers none.
 */
export class RecordTools extends Context.Service<
  RecordTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a turn outside any chat. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/RecordTools") {}

const RECORD_DECISION: HubTool = {
  name: RECORD_DECISION_TOOL,
  description: RECORD_DECISION_DESCRIPTION,
  inputSchema: recordDecisionJsonSchema(),
  label: RECORD_DECISION_LABEL,
};

const decodeInput = Schema.decodeUnknownEffect(RecordDecisionInput);

/** What the hob reads back once a decision is recorded. */
const recordedText = (plan: DecisionPlan): string =>
  [
    `Recorded decision ${plan.recorded.id}: "${plan.recorded.text}"`,
    plan.superseded === null ? null : `Decision ${plan.superseded.id} is crossed out and no longer holds.`,
  ]
    .filter((line) => line !== null)
    .join("\n");

/** `record_decision` for a turn, recording through `Records` as the turn's hob, from its reply. */
export const RecordToolsLive = Layer.effect(
  RecordTools,
  Effect.gen(function* () {
    const records = yield* Records;
    // A runtime runs each call on its own, so it carries the hub's services, its logger included.
    const context = yield* Effect.context<never>();

    const call = (turn: CharmTurn, threadId: ThreadId, messageId: MessageId, raw: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodeInput(raw).pipe(Effect.option);
        if (Option.isNone(decoded)) {
          return { text: "Give the decision as `text` and a `key` for the call.", refused: true };
        }
        const input = decoded.value;
        // What a hob wrote is redacted before it is kept, as everything the journal holds is.
        const text = turn.redactor.text(input.text);
        const replaces = input.replaces === undefined ? null : DecisionIds.make(input.replaces.trim());
        const plan = yield* records.recordHobs({
          id: DecisionIds.make(crypto.randomUUID()),
          threadId,
          sourceMessageId: messageId,
          text,
          replaces,
          actor: hobActor(turn.agentId),
          key: keyOf("reply", `${messageId}\0${input.key}`),
          input: inputOf(text, replaces),
        });
        return { text: turn.redactor.text(recordedText(plan)), refused: false };
      }).pipe(
        Effect.catchTags({
          DecisionRefused: (refused) =>
            Effect.succeed({ text: `Refused (${refused.reason}): ${refused.message}`, refused: true }),
          ThreadNotFound: () =>
            Effect.succeed({ text: "This chat or camp is gone, so nothing was recorded.", refused: true }),
        }),
        Effect.catchCause((cause) =>
          Effect.as(Effect.logError("A record_decision call failed", cause), {
            text: "Hobbots could not record the decision. Try again later.",
            refused: true,
          }),
        ),
        Effect.provideContext(context),
      );

    const offer = (turn: CharmTurn): HubTools | null => {
      const { threadId, messageId } = turn;
      if (threadId === null || messageId === null) return null;
      return {
        tools: [RECORD_DECISION],
        call: (name, input): Effect.Effect<HubToolAnswer> =>
          name === RECORD_DECISION_TOOL
            ? call(turn, threadId, messageId, input)
            : Effect.succeed({ text: `${name} is not offered in this session.`, refused: true }),
      };
    };

    return RecordTools.of({ forTurn: (turn) => Effect.succeed(offer(turn)) });
  }),
);

/**
 * What the context pack reads from the Records (ADR 037): the decisions that hold and the artifacts
 * index, newest first, so a new chapter's first session starts from them.
 */
export const RecordPackSource = Layer.effect(
  PackRecordSource,
  Effect.gen(function* () {
    const records = yield* Records;
    return PackRecordSource.of({
      activeDecisions: (threadId) =>
        Effect.map(records.activeDecisions(threadId), (decisions) =>
          decisions.map((decision) => ({ id: decision.id, text: decision.text, recordedAt: decision.recordedAt })),
        ),
      artifactsIndex: (threadId) =>
        Effect.map(records.artifactsOf(threadId), (artifacts) =>
          artifacts.map((artifact) => ({
            kind: artifact.kind,
            title: artifact.title,
            latestVersion: artifact.latestVersion,
            updatedAt: artifact.updatedAt,
          })),
        ),
    });
  }),
);
