import { Schema } from "effect";
import { DeviceId } from "./device.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { MAX_QUESTION_OPTIONS, QuestionState, QuestionSurface } from "./quest.ts";
import { Revision } from "./revision.ts";

/**
 * A question the hub itself puts to you (#976), for a decision only the hub can apply, such as who
 * to commit as. It has no Task and no asking hob: it is about a subject the hub names, goes
 * straight to you and never climbs leads. It offers choices by the same rules as a hob's question
 * (#740), and the answer goes to the part of the hub that raised it.
 *
 * The hub sends codes and data, never sentences (#1045, STD-I18N-005): what it asks is an `ask` of
 * one known kind, its choices are stable keys, and the client turns both into text.
 */

export const HubQuestionId = Schema.String.pipe(Schema.brand("HubQuestionId"));
export type HubQuestionId = typeof HubQuestionId.Type;

/** The name and email a commit is made as, as a hub question carries it. */
const Identity = Schema.Struct({
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  email: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
});

/**
 * Who hobs on your account commit as (#741). `reason` says why the hub asks: your Git config sets
 * no identity, or it could not read one in your last answer, which `unread` holds. `github` is the
 * connected GitHub account, with the identity its choice commits as, when the hub reached one.
 */
export const CommitIdentityAsk = Schema.Struct({
  kind: Schema.Literal("commit-identity"),
  reason: Schema.Literals(["no-git-identity", "unreadable-answer"]),
  github: Schema.NullOr(
    Schema.Struct({
      login: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
      identity: Identity,
    }),
  ),
  unread: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
});
export type CommitIdentityAsk = typeof CommitIdentityAsk.Type;

/**
 * The made-up questions behind `HOBBOTS_FAKE_HUB_QUESTIONS`, for trying hub questions and for
 * browser tests: how often to back up, what to call the hub, and, once one is answered, what the
 * hub applied, which `applied` holds: the choice picked, or the words typed.
 */
export const FakeCheckAsk = Schema.Struct({
  kind: Schema.Literal("fake-check"),
  check: Schema.Literals(["backups", "hub-name", "applied"]),
  applied: Schema.NullOr(
    Schema.Struct({
      picked: Schema.NullOr(Schema.Literals(["nightly", "weekly"])),
      answer: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000))),
    }),
  ),
});
export type FakeCheckAsk = typeof FakeCheckAsk.Type;

/** What a hub question asks, by kind: the part of the hub that raised it and applies the answer. */
export const HubQuestionAsk = Schema.Union([CommitIdentityAsk, FakeCheckAsk]);
export type HubQuestionAsk = typeof HubQuestionAsk.Type;
export type HubQuestionKind = HubQuestionAsk["kind"];

/** The choices each kind of hub question can offer, by their stable keys. */
export const HUB_QUESTION_CHOICES = {
  "commit-identity": ["github", "own-git"],
  "fake-check": ["nightly", "weekly"],
} as const satisfies Record<HubQuestionKind, ReadonlyArray<string>>;
export type HubQuestionChoice<K extends HubQuestionKind = HubQuestionKind> = (typeof HUB_QUESTION_CHOICES)[K][number];

/** A choice's key: lowercase words joined by hyphens, never shown to you as it is. */
export const HubQuestionChoiceKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

/** The chat a hub question concerns, whose Needs-you tray shows it too. */
export const HubQuestionChat = Schema.Struct({ agentId: AgentId, threadId: ThreadId });
export type HubQuestionChat = typeof HubQuestionChat.Type;

/**
 * The chat a question about `task`'s work concerns: the thread whose request started its tree, which
 * belongs to the hob that owns the tree's top Task. A Quest's members and steps all point to it, so
 * a question there shows in the Quest's own chat. Null for work with no thread.
 */
export const taskChat = (
  task: { readonly rootId: string; readonly threadId: ThreadId | null },
  tasks: ReadonlyArray<{ readonly id: string; readonly ownerId: AgentId }>,
): HubQuestionChat | null => {
  const root = tasks.find((each) => each.id === task.rootId);
  return task.threadId === null || root === undefined ? null : { agentId: root.ownerId, threadId: task.threadId };
};

/** Tells apart the things of one kind, so the hub asks about each one once at a time. */
export const HubQuestionKey = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200));

interface Choices {
  readonly ask: HubQuestionAsk;
  readonly options?: ReadonlyArray<string>;
  readonly recommended?: string;
}

/**
 * Why a hub question's choices are not right, or undefined when they are: each is one its kind
 * offers, none twice, the recommended one among them, and the GitHub choice only with an account.
 */
export const hubChoicesProblem = ({ ask, options, recommended }: Choices): string | undefined => {
  const known: ReadonlyArray<string> = HUB_QUESTION_CHOICES[ask.kind];
  const unknown = options?.find((key) => !known.includes(key));
  if (unknown !== undefined) return `A ${ask.kind} question offers no choice "${unknown}".`;
  if (options !== undefined && new Set(options).size !== options.length) return "Each choice is offered once.";
  if (recommended !== undefined && !options?.includes(recommended)) return "recommended is one of the choices.";
  if (ask.kind === "commit-identity" && ask.github === null && options?.includes("github"))
    return "The GitHub choice needs a GitHub account.";
  return undefined;
};

/**
 * What the hub raises a question with. It needs a `key` and an `ask` and never names a Task; its
 * choices follow the same rules as a hob's (#740), by key, with `recommended` one of them.
 */
export const RaiseHubQuestion = Schema.Struct({
  key: HubQuestionKey,
  chat: Schema.optionalKey(HubQuestionChat),
  ask: HubQuestionAsk,
  options: Schema.optionalKey(
    Schema.Array(HubQuestionChoiceKey).check(Schema.isMinLength(2), Schema.isMaxLength(MAX_QUESTION_OPTIONS)),
  ),
  recommended: Schema.optionalKey(HubQuestionChoiceKey),
}).check(Schema.makeFilter((input: Choices) => hubChoicesProblem(input)));
export type RaiseHubQuestion = typeof RaiseHubQuestion.Type;

/** How you answered a hub question: by picking one of its choices, or in your own words. */
export type HubAnswer = { readonly picked: string } | { readonly words: string };

/** A question from the hub, open until you answer it or the hub no longer needs the answer. */
export class HubQuestion extends Schema.Class<HubQuestion>("HubQuestion")({
  id: HubQuestionId,
  key: HubQuestionKey,
  chat: Schema.NullOr(HubQuestionChat),
  ask: HubQuestionAsk,
  /** The keys of the choices it offers, none for a question answered in words only. */
  options: Schema.Array(HubQuestionChoiceKey),
  /** The key of the choice the hub recommends, if any. */
  recommended: Schema.NullOr(HubQuestionChoiceKey),
  /** Withdrawn once the hub no longer needs the answer, such as when the decision was made elsewhere. */
  state: QuestionState,
  /** Once answered in your own words, those words; null for a picked choice. */
  answer: Schema.NullOr(Schema.String),
  /** Once answered by a choice, its key; null when the answer was typed. */
  picked: Schema.NullOr(HubQuestionChoiceKey),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
  /** The approved device you answered it from, and where. */
  answeredByDeviceId: Schema.NullOr(DeviceId),
  answeredVia: Schema.NullOr(QuestionSurface),
  revision: Revision,
}) {}
