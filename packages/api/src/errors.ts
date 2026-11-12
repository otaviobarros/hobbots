import {
  AgentId,
  AnyOperation,
  ApprovalId,
  ApprovalLifetime,
  ApprovalState,
  CharmCallState,
  GrantId,
  HobStanding,
  HubQuestionId,
  MessageId,
  QuestId,
  QuestionId,
  SafetyPreset,
  TaskId,
  ThreadArchiveRefusal,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  { agentId: AgentId },
  { httpApiStatus: 404 },
) {}

/**
 * A hob that is not active refuses new work: a paused hob until it is woken, a retired hob for
 * good, and a hob finishing its open Tasks before it retires (`retiring`). Also returned when
 * pausing or waking a retired hob.
 */
export class HobUnavailable extends Schema.TaggedError<HobUnavailable>()(
  "HobUnavailable",
  { agentId: AgentId, status: HobStanding },
  { httpApiStatus: 409 },
) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  "ThreadNotFound",
  { threadId: ThreadId },
  { httpApiStatus: 404 },
) {}

/** A tool step with no full log: the step, its reply or its thread is not there, or its output was shown whole. */
export class ToolLogNotFound extends Schema.TaggedError<ToolLogNotFound>()(
  "ToolLogNotFound",
  { messageId: MessageId, stepId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The thread was not archived or restored, for `reason`; nothing changed. */
export class ThreadArchiveRefused extends Schema.TaggedError<ThreadArchiveRefused>()(
  "ThreadArchiveRefused",
  { threadId: ThreadId, reason: ThreadArchiveRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * Why Start fresh did nothing: the thread is not its hob's open chat (`not-open-chat`), or what
 * stops an archive stops it too.
 */
export const StartFreshRefusal = Schema.Literals([...ThreadArchiveRefusal.literals, "not-open-chat"]);
export type StartFreshRefusal = typeof StartFreshRefusal.Type;

/** Start fresh was refused for `reason`; nothing changed. */
export class StartFreshRefused extends Schema.TaggedError<StartFreshRefused>()(
  "StartFreshRefused",
  { threadId: ThreadId, reason: StartFreshRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * The key of Make a camp or Start fresh, which becomes the new thread's id, already names another
 * thread or another request; nothing changed. The same request sent again is answered, not refused.
 */
export class ThreadKeyReused extends Schema.TaggedError<ThreadKeyReused>()(
  "ThreadKeyReused",
  { threadId: ThreadId },
  { httpApiStatus: 409 },
) {}

/** An archived thread is read-only: it takes no new messages, replies or brain switch until it is restored. */
export class ThreadArchived extends Schema.TaggedError<ThreadArchived>()(
  "ThreadArchived",
  { threadId: ThreadId, archivedAt: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A message that is not waiting in the thread's queue: it already started, was removed, or is elsewhere. */
export class MessageNotQueued extends Schema.TaggedError<MessageNotQueued>()(
  "MessageNotQueued",
  { messageId: MessageId },
  { httpApiStatus: 409 },
) {}

/**
 * A reply Continue cannot resume: it did not end early, it is not the thread's latest message, or
 * another turn is running in its thread.
 */
export class ReplyNotResumable extends Schema.TaggedError<ReplyNotResumable>()(
  "ReplyNotResumable",
  { messageId: MessageId },
  { httpApiStatus: 409 },
) {}

/**
 * A new hob the server will not create: a field that fails the payload schema, or a brain the
 * runtime does not offer. `field` names the payload field, or is null when the body is not a hob.
 */
export class InvalidHob extends Schema.TaggedError<InvalidHob>()(
  "InvalidHob",
  { field: Schema.NullOr(Schema.String), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * Revert undoes only the hob's latest change (ADR 034): refused as `not-latest` once another version
 * followed it, and as `first-version` for the version the hob was summoned with.
 */
export class RevertRefused extends Schema.TaggedError<RevertRefused>()(
  "RevertRefused",
  {
    agentId: AgentId,
    version: Schema.Int,
    reason: Schema.Literals(["not-latest", "first-version"]),
  },
  { httpApiStatus: 409 },
) {}

/** A folder the hub will not let hobs work in: not an absolute path, or not a folder on the hub. */
export class InvalidFolder extends Schema.TaggedError<InvalidFolder>()(
  "InvalidFolder",
  { folder: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * A per-hob override that would allow more than the installation's preset. Overrides only narrow;
 * a widening needs a separately recorded user grant (ADR 014).
 */
export class OverrideWidens extends Schema.TaggedError<OverrideWidens>()(
  "OverrideWidens",
  { preset: SafetyPreset, operations: Schema.Array(AnyOperation), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * A per-hob override of Ask for an operation that takes Allow or Never only, such as Search the web
 * (ADR 036), which is never stored.
 */
export class UnofferedAnswer extends Schema.TaggedError<UnofferedAnswer>()(
  "UnofferedAnswer",
  { operations: Schema.Array(AnyOperation), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** An override for a Charm operation no Charm the hub holds declares (ADR 031). */
export class UndeclaredOperation extends Schema.TaggedError<UndeclaredOperation>()(
  "UndeclaredOperation",
  { operations: Schema.Array(Schema.String), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A Charm granted to a hob that the hub does not hold (ADR 031). */
export class UnknownCharm extends Schema.TaggedError<UnknownCharm>()(
  "UnknownCharm",
  { charms: Schema.Array(Schema.String), message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()(
  "ApprovalNotFound",
  { approvalId: ApprovalId },
  { httpApiStatus: 404 },
) {}

/**
 * An approval request that can no longer take this decision: it expired (its reply stopped, its hob
 * retired, the server restarted or the policy changed), or it was already decided the other way.
 * Deciding it again the same way is not an error. `state` is where it stands.
 */
export class ApprovalClosed extends Schema.TaggedError<ApprovalClosed>()(
  "ApprovalClosed",
  { approvalId: ApprovalId, state: ApprovalState },
  { httpApiStatus: 409 },
) {}

/** A high-risk request is approved only with the user's confirmation (PE-007). */
export class ApprovalNotConfirmed extends Schema.TaggedError<ApprovalNotConfirmed>()(
  "ApprovalNotConfirmed",
  { approvalId: ApprovalId },
  { httpApiStatus: 422 },
) {}

/** The decision names another action than the one the request is for, so it does not apply. */
export class ApprovalActionChanged extends Schema.TaggedError<ApprovalActionChanged>()(
  "ApprovalActionChanged",
  { approvalId: ApprovalId },
  { httpApiStatus: 409 },
) {}

/**
 * A lifetime the request does not offer (ADR 015): This Quest or Always on a high-risk action, a
 * command Hobbots cannot read fully, an Ask from an override, a restriction or a safety check, or
 * This Quest before Quests exist. The user can still allow it once.
 */
export class ApprovalNotGrantable extends Schema.TaggedError<ApprovalNotGrantable>()(
  "ApprovalNotGrantable",
  { approvalId: ApprovalId, lifetime: ApprovalLifetime },
  { httpApiStatus: 422 },
) {}

/** A rule to save that the card did not offer: another action's, or broader than the request's own. */
export class GrantRuleRefused extends Schema.TaggedError<GrantRuleRefused>()(
  "GrantRuleRefused",
  { approvalId: ApprovalId, message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class GrantNotFound extends Schema.TaggedError<GrantNotFound>()(
  "GrantNotFound",
  { grantId: GrantId },
  { httpApiStatus: 404 },
) {}

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { taskId: TaskId },
  { httpApiStatus: 404 },
) {}

export class QuestNotFound extends Schema.TaggedError<QuestNotFound>()(
  "QuestNotFound",
  { questId: QuestId },
  { httpApiStatus: 404 },
) {}

/**
 * A Cancel, Retry or Reassign the Task's records refuse where it stands, with why: such as a Retry
 * of a Task that has not failed, or a Reassign while its turn runs. A Retry or Reassign refused
 * changed nothing; a Cancel refused partway keeps the Tasks it already moved, and asking again
 * finishes it.
 */
export class TaskNotControllable extends Schema.TaggedError<TaskNotControllable>()(
  "TaskNotControllable",
  { taskId: TaskId, reason: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class QuestionNotFound extends Schema.TaggedError<QuestionNotFound>()(
  "QuestionNotFound",
  { questionId: QuestionId },
  { httpApiStatus: 404 },
) {}

/** A question that is no longer the user's to answer: it was answered, or it is with a lead. */
export class QuestionClosed extends Schema.TaggedError<QuestionClosed>()(
  "QuestionClosed",
  { questionId: QuestionId },
  { httpApiStatus: 409 },
) {}

export class HubQuestionNotFound extends Schema.TaggedError<HubQuestionNotFound>()(
  "HubQuestionNotFound",
  { hubQuestionId: HubQuestionId },
  { httpApiStatus: 404 },
) {}

/** A question from the hub that is no longer yours to answer: it was answered or withdrawn (#976). */
export class HubQuestionClosed extends Schema.TaggedError<HubQuestionClosed>()(
  "HubQuestionClosed",
  { hubQuestionId: HubQuestionId },
  { httpApiStatus: 409 },
) {}

/** An answer to a question from the hub that picked a choice the question does not offer (#1045). */
export class HubChoiceNotOffered extends Schema.TaggedError<HubChoiceNotOffered>()(
  "HubChoiceNotOffered",
  { hubQuestionId: HubQuestionId },
  { httpApiStatus: 400 },
) {}

/**
 * A note the Task can no longer take: the Task has ended, or the note's key was already used for
 * another Task or text.
 */
export class NoteRefused extends Schema.TaggedError<NoteRefused>()(
  "NoteRefused",
  { taskId: TaskId, reason: Schema.Literals(["task-ended", "key-reused"]) },
  { httpApiStatus: 409 },
) {}

/** No Charm call shows as this reply step. */
export class CharmCallNotFound extends Schema.TaggedError<CharmCallNotFound>()(
  "CharmCallNotFound",
  { stepId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The Charm call is no longer uncertain, so there is nothing to settle (ADR 020). */
export class CharmCallSettled extends Schema.TaggedError<CharmCallSettled>()(
  "CharmCallSettled",
  { stepId: Schema.String, state: CharmCallState },
  { httpApiStatus: 409 },
) {}
