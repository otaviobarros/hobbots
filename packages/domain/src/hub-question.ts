import { Schema } from "effect";
import { DeviceId } from "./device.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { choicesProblem, MAX_QUESTION_OPTIONS, QuestionOption, QuestionState, QuestionSurface } from "./quest.ts";
import { Revision } from "./revision.ts";

/**
 * A question the hub itself puts to you (#976), for a decision only the hub can apply, such as who
 * to commit as. It has no Task and no asking hob: it is about a subject the hub names, goes
 * straight to you and never climbs leads. It offers choices by the same rules as a hob's question
 * (#740), and the answer goes to the part of the hub that raised it.
 */

export const HubQuestionId = Schema.String.pipe(Schema.brand("HubQuestionId"));
export type HubQuestionId = typeof HubQuestionId.Type;

/**
 * What a hub question is about. `kind` names the part of the hub that raised it and applies the
 * answer, such as `commit-identity`; `key` tells apart the things of that kind, so the hub asks
 * about each one once at a time; `title` is how a card names it.
 */
export const HubQuestionSubject = Schema.Struct({
  kind: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  key: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
});
export type HubQuestionSubject = typeof HubQuestionSubject.Type;

/** The chat a hub question concerns, whose Needs-you tray shows it too. */
export const HubQuestionChat = Schema.Struct({ agentId: AgentId, threadId: ThreadId });
export type HubQuestionChat = typeof HubQuestionChat.Type;

/**
 * What the hub raises a question with. It needs a subject and never names a Task; its choices follow
 * the same rules as a hob's (#740), with `recommended` an index from 0.
 */
export const RaiseHubQuestion = Schema.Struct({
  subject: HubQuestionSubject,
  chat: Schema.optionalKey(HubQuestionChat),
  text: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4000)),
  options: Schema.optionalKey(
    Schema.Array(QuestionOption).check(Schema.isMinLength(2), Schema.isMaxLength(MAX_QUESTION_OPTIONS)),
  ),
  recommended: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(
  Schema.makeFilter((input: { readonly options?: ReadonlyArray<QuestionOption>; readonly recommended?: number }) =>
    choicesProblem(input.options, input.recommended, 0),
  ),
);
export type RaiseHubQuestion = typeof RaiseHubQuestion.Type;

/** A question from the hub, open until you answer it or the hub no longer needs the answer. */
export class HubQuestion extends Schema.Class<HubQuestion>("HubQuestion")({
  id: HubQuestionId,
  subject: HubQuestionSubject,
  chat: Schema.NullOr(HubQuestionChat),
  text: Schema.String,
  /** The choices it offers, none for a question answered in words only. */
  options: Schema.Array(QuestionOption),
  /** The index in `options` of the one the hub recommends, if any. */
  recommended: Schema.NullOr(Schema.Int),
  /** Withdrawn once the hub no longer needs the answer, such as when the decision was made elsewhere. */
  state: QuestionState,
  answer: Schema.NullOr(Schema.String),
  /** Once answered, the index in `options` of the choice picked; null when the answer was typed. */
  picked: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
  /** The approved device you answered it from, and where. */
  answeredByDeviceId: Schema.NullOr(DeviceId),
  answeredVia: Schema.NullOr(QuestionSurface),
  revision: Revision,
}) {}
