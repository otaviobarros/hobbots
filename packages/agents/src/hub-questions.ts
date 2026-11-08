import { HubChoiceNotOffered, HubQuestionClosed, HubQuestionNotFound, UserSession } from "@hobbots/api";
import {
  type Committed,
  type DeviceId,
  type HubAnswer,
  type HubQuestion,
  HubQuestionId,
  type HubQuestionKind,
  type QuestionSurface,
  RaiseHubQuestion,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, type Option, Schema, type Scope, Semaphore } from "effect";
import { EventPublisher } from "./ports.ts";

/** A hub question as the hub raises it, with its id and when. */
export interface NewHubQuestion extends RaiseHubQuestion {
  readonly id: HubQuestionId;
  readonly createdAt: string;
}

/**
 * Why an answer to a hub question was not recorded: there is no such question, it is no longer
 * open, or it picked a choice the question does not offer.
 */
export class HubQuestionRefused extends Schema.TaggedError<HubQuestionRefused>()("HubQuestionRefused", {
  reason: Schema.Literals(["missing", "closed", "unknown-choice"]),
}) {}

/** The questions the hub itself puts to you (#976), journaled with their events. */
export class HubQuestionRepository extends Context.Service<
  HubQuestionRepository,
  {
    /**
     * Stores a new question with its HubQuestionRaised event. While a question of the same kind
     * and key is open, that one is returned instead, with no event: the hub asks about each thing once.
     */
    readonly raise: (input: NewHubQuestion) => Effect.Effect<Committed<HubQuestion>>;
    /**
     * Records your answer with its HubQuestionAnswered event: the key of the choice you picked, or
     * the words you typed (#1045).
     */
    readonly answer: (
      id: HubQuestionId,
      answer: HubAnswer,
      at: string,
      from: { readonly deviceId: DeviceId; readonly via: QuestionSurface | null },
    ) => Effect.Effect<Committed<HubQuestion>, HubQuestionRefused>;
    /** Withdraws an open question with its HubQuestionWithdrawn event; none when it was not open. */
    readonly withdraw: (id: HubQuestionId) => Effect.Effect<Option.Option<Committed<HubQuestion>>>;
    readonly find: (id: HubQuestionId) => Effect.Effect<Option.Option<HubQuestion>>;
    /** The questions waiting for you, oldest first. */
    readonly listOpen: Effect.Effect<ReadonlyArray<HubQuestion>>;
    /** The answered questions of `kind` whose answer the hub has not applied yet, oldest first. */
    readonly listUnapplied: (kind: HubQuestionKind) => Effect.Effect<ReadonlyArray<HubQuestion>>;
    /** Records that the hub applied the question's answer. */
    readonly markApplied: (id: HubQuestionId, at: string) => Effect.Effect<void>;
  }
>()("@hobbots/agents/HubQuestionRepository") {}

/**
 * The part of the hub that raises questions of one `kind` and applies their answers. It gets the
 * answered question: the key of the choice you picked in `picked`, or the words you typed in
 * `answer`. It applies a choice by its key, never by how a client shows it (#1045).
 */
export interface HubQuestionHandler {
  readonly kind: HubQuestionKind;
  readonly apply: (question: HubQuestion) => Effect.Effect<void, unknown>;
}

const decodeRaise = Schema.decodeUnknownEffect(RaiseHubQuestion);

/**
 * Questions the hub itself puts to you (#976). Each goes straight to you, shows in the Inbox, the
 * Needs-you trays and the chat it concerns, and never climbs leads. Your answer goes to the handler
 * of its kind, which applies it. An answer the hub could not apply yet, because it failed
 * or no handler was there, is applied when its handler next registers, such as at the next start.
 */
export class HubQuestions extends Context.Service<
  HubQuestions,
  {
    /** Puts a question to you; while one of the same kind and key is open, returns that one. */
    readonly raise: (input: RaiseHubQuestion) => Effect.Effect<HubQuestion>;
    /** Takes back an open question the hub no longer needs answered. */
    readonly withdraw: (id: HubQuestionId) => Effect.Effect<void>;
    /** The questions waiting for you, oldest first. */
    readonly listOpen: Effect.Effect<ReadonlyArray<HubQuestion>>;
    /**
     * Records your answer, a choice's key or your own words, with the device it came from and
     * `via`, where you answered it, then has the question's handler apply it. Only the user answers
     * (PE-006): it needs a `UserSession`.
     */
    readonly answer: (
      id: HubQuestionId,
      answer: HubAnswer,
      via?: QuestionSurface,
    ) => Effect.Effect<HubQuestion, HubQuestionNotFound | HubQuestionClosed | HubChoiceNotOffered, UserSession>;
    /**
     * Registers the handler for its kind while `Scope` lasts, and applies the answers of that kind
     * still waiting for it.
     */
    readonly handle: (handler: HubQuestionHandler) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@hobbots/agents/HubQuestions") {
  static readonly layer = Layer.effect(
    HubQuestions,
    Effect.gen(function* () {
      const questions = yield* HubQuestionRepository;
      const bus = yield* EventPublisher;
      const scope = yield* Effect.scope;
      const handlers = new Map<HubQuestionKind, HubQuestionHandler>();
      // One application at a time, each reading what is left to apply, so no answer is applied twice.
      const applying = yield* Semaphore.make(1);
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const applyWaiting = (kind: HubQuestionKind) =>
        Semaphore.withPermit(
          applying,
          Effect.gen(function* () {
            const handler = handlers.get(kind);
            if (handler === undefined) return;
            for (const question of yield* questions.listUnapplied(kind)) {
              yield* handler.apply(question).pipe(
                Effect.andThen(Effect.flatMap(nowIso, (at) => questions.markApplied(question.id, at))),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`Could not apply the answer to hub question ${question.id}`, cause),
                ),
              );
            }
          }),
        );

      return HubQuestions.of({
        raise: (input) =>
          Effect.gen(function* () {
            const raised = yield* decodeRaise(input).pipe(Effect.orDie);
            const committed = yield* questions.raise({
              ...raised,
              id: HubQuestionId.make(crypto.randomUUID()),
              createdAt: yield* nowIso,
            });
            yield* bus.publish(committed.entries);
            return committed.value;
          }),
        withdraw: (id) =>
          Effect.gen(function* () {
            const withdrawn = yield* questions.withdraw(id);
            if (withdrawn._tag === "Some") yield* bus.publish(withdrawn.value.entries);
          }),
        listOpen: questions.listOpen,
        answer: (id, answer, via) =>
          Effect.gen(function* () {
            const session = yield* UserSession;
            const committed = yield* questions
              .answer(id, answer, yield* nowIso, { deviceId: session.deviceId, via: via ?? null })
              .pipe(
                Effect.catchTag("HubQuestionRefused", (refused) =>
                  Effect.fail(
                    refused.reason === "missing"
                      ? new HubQuestionNotFound({ hubQuestionId: id })
                      : refused.reason === "closed"
                        ? new HubQuestionClosed({ hubQuestionId: id })
                        : new HubChoiceNotOffered({ hubQuestionId: id }),
                  ),
                ),
              );
            yield* bus.publish(committed.entries);
            // The hub applies it beside your request, so it finishes even if the request goes away.
            yield* applyWaiting(committed.value.ask.kind).pipe(Effect.forkIn(scope));
            return committed.value;
          }),
        handle: (handler) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => handlers.set(handler.kind, handler)),
              () => Effect.sync(() => handlers.delete(handler.kind)),
            );
            yield* applyWaiting(handler.kind);
          }),
      });
    }),
  );
}
