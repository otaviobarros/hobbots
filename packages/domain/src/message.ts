import { Effect, Schema } from "effect";
import { ConfigVersion, RuntimeKind } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";
import { PolicyOperation } from "./policy.ts";
import { Revision } from "./revision.ts";
import { TurnSkill } from "./skills.ts";
import { ToolOutput } from "./tool-output.ts";

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

/**
 * - `queued`: a user message waiting for the thread's current turn to end.
 * - `streaming`: the hob is writing this reply.
 * - `stopping`: the user asked to stop; the reply still counts as in progress until the runtime confirms.
 * - `stopped`: the runtime confirmed the turn ended after a stop request; the partial text is kept.
 * - `interrupted`: the reply was cut off, not by the user: Hobbots ended the turn (a restart, pause or
 *   retirement), or the runtime stopped after it had started writing (`error` says why). Continue resumes it.
 * - `limited`: the provider's usage limit ended the turn; `resetsAt` says when it refills, if known.
 */
export const MessageStatus = Schema.Literals([
  "queued",
  "streaming",
  "stopping",
  "complete",
  "failed",
  "stopped",
  "interrupted",
  "limited",
]);
export type MessageStatus = typeof MessageStatus.Type;

/** A reply whose turn has not ended yet, so its thread is busy. */
export const isInProgress = (status: MessageStatus): boolean => status === "streaming" || status === "stopping";

/** A reply that ended early and that Continue can resume in place. */
export const isResumable = (status: MessageStatus): boolean => status === "interrupted" || status === "limited";

/**
 * - `running`: under way; for a tool call, the policy allowed it and it started.
 * - `awaiting`: a tool call paused on Ask until the user decides (`approvalId`).
 * - `done`: ended; a tool call ended without an error.
 * - `failed`: a tool call ended with an error, a sandbox refusal included.
 * - `denied`: a tool call never ran; `reason` says why and `decidedBy` who refused it.
 * - `unfinished`: its turn ended before it finished: a thinking step, or a tool call still awaiting
 *   approval, which never ran. Steps saved before `uncertain` existed may also be tool calls that ran.
 * - `uncertain`: its turn ended (a crash, a restart, a stop or a runtime failure) while the tool call
 *   was running, or a Charm's write ended without a clear answer (ADR 020), so it may or may not
 *   have taken effect. Hobbots never runs it again on its own.
 *
 * `unfinished` and `uncertain` are final: Continue starts new steps and never revives them.
 */
export const ReplyStepState = Schema.Literals([
  "running",
  "awaiting",
  "done",
  "failed",
  "denied",
  "unfinished",
  "uncertain",
]);
export type ReplyStepState = typeof ReplyStepState.Type;

/** A tool call the step stands for, as the policy decided it (ADR 014). */
export const ToolCall = Schema.Struct({
  /** The runtime's own name for the tool, such as `Bash` or `Edit`. */
  tool: Schema.String,
  operation: PolicyOperation,
  /** The canonical paths, the command's folder, or the remote the call was decided on. */
  targets: Schema.Array(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;

/** What a reply did besides writing, as the runtime reported it: thinking, or a tool call. */
export const ReplyStep = Schema.Struct({
  /** Unique within its reply, which keeps the steps of its earlier turns when Continue resumes it. */
  id: Schema.String,
  kind: Schema.Literals(["thinking", "tool"]),
  /** Short words for the step, such as "Thinking" or "Running pnpm test". */
  label: Schema.String,
  state: ReplyStepState,
  /** For a tool step: the call. */
  call: Schema.optionalKey(ToolCall),
  /** For a tool step that started: when the policy allowed it and it was recorded, just before it ran (ISO 8601). */
  startedAt: Schema.optionalKey(Schema.String),
  /** For an `awaiting` step: the approval it waits on. */
  approvalId: Schema.optionalKey(Schema.String),
  /** For a `denied` step: why the call was refused. For an `uncertain` one: what is known of its outcome. */
  reason: Schema.optionalKey(Schema.String),
  /** For a `denied` step: the policy hook refused it, the user denied its Ask, or the OS sandbox did. */
  decidedBy: Schema.optionalKey(Schema.Literals(["policy", "user", "sandbox"])),
  /** For a tool step that ended: what its call printed, redacted, and cut to its start and end when long. */
  output: Schema.optionalKey(ToolOutput),
});
export type ReplyStep = typeof ReplyStep.Type;

/** A count or a duration the runtime reported, or null when it reported none. */
const Measured = Schema.NullOr(Schema.Number);

/**
 * How long a turn took to get going and how many tokens it used, as its runtime reported them
 * (#398). Any runtime can leave a field null. Durations are milliseconds from the start of the turn;
 * tokens are the main session's alone, without subagents or the runtime's own helper calls.
 */
export const ReplyUsage = Schema.Struct({
  /** Until the runtime sent its first model request: its own startup, such as resuming the session. */
  timeToRequestMs: Measured,
  /** Until the model's response stream opened. */
  timeToFirstStreamMs: Measured,
  /** Until the model's first complete message arrived. */
  timeToFirstTokenMs: Measured,
  /** Input tokens that were neither read from nor written to the prompt cache. */
  inputTokens: Measured,
  outputTokens: Measured,
  cacheReadTokens: Measured,
  cacheWriteTokens: Measured,
});
export type ReplyUsage = typeof ReplyUsage.Type;

export class Message extends Schema.Class<Message>("Message")({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  content: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  /** For an assistant message, the hob configuration version that produced it; null for the user's. */
  configVersion: Schema.NullOr(ConfigVersion),
  /**
   * For an assistant message, the runtime and model of its latest turn (ADR 017): what the chat shows
   * a switch by and what usage is attributed to. Null for the user's, and for a model left to the runtime.
   */
  runtime: Schema.NullOr(RuntimeKind).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  model: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * For an assistant message, what its latest turn took and used, next to that turn's runtime and
   * model. Null until a turn completes with a report, and for the user's.
   */
  usage: Schema.NullOr(ReplyUsage).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** For a `limited` reply, when the provider's allowance refills (ISO 8601), if it said. */
  resetsAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * For an assistant message, the message of yours its turn answers (#900), so a steer receipt knows
   * which turn read it. Null for the user's, for a continuation, which answers work that arrived
   * instead (ADR 019), and for replies from before this was recorded.
   */
  promptId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** For an assistant message, its steps in order. Saved with the reply, so they replay and outlast it. */
  steps: Schema.Array(ReplyStep).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /**
   * For a lead's reply to work that arrived while its Quest runs (ADR 027): true when the reply
   * neither finished the work nor brought you a question, so it is routine progress the room already
   * shows. The chat leaves it out, and it makes no thread unread (#1006). Kept, so its hob's history
   * and an export still hold it.
   */
  quiet: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /**
   * The skills of a turn (ADR 029): on your message, those it was given when the hub accepted it, which
   * its turn uses even after a rollout while it waited; on a reply, those its latest turn used. Null
   * on a hub without a skills library, for a continuation's prompt, and for messages from before.
   */
  skills: Schema.NullOr(Schema.Array(TurnSkill)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  revision: Revision,
}) {}

export class InvalidMessageTransition extends Schema.TaggedError<InvalidMessageTransition>()(
  "InvalidMessageTransition",
  { messageId: MessageId, from: MessageStatus, action: Schema.String },
) {}

/** A step's state once its turn ends: one still under way can never read as active again. */
const endedState = (step: ReplyStep): ReplyStepState => {
  if (step.state === "running") return step.kind === "tool" ? "uncertain" : "unfinished";
  return step.state === "awaiting" ? "unfinished" : step.state;
};

/** Steps as their turn ends: a tool call cut off while it ran is uncertain, anything else still under way unfinished. */
export const endedSteps = (steps: ReadonlyArray<ReplyStep>): ReadonlyArray<ReplyStep> =>
  steps.map((step) => {
    const state = endedState(step);
    return state === step.state ? step : { ...step, state };
  });

/**
 * Whether every tool call in the steps plainly succeeded. A failed, refused or uncertain call is
 * something you need to see, so a reply with one is never kept quiet (#1006).
 */
export const toolsSucceeded = (steps: ReadonlyArray<ReplyStep>): boolean =>
  steps.every((step) => step.kind !== "tool" || step.state === "done");

/**
 * A turn's end. A tool call cut off while it ran is uncertain: it may have taken effect. Anything
 * else still under way, thinking or a call awaiting approval, is unfinished.
 */
const endTurn = (message: Message, fields: Partial<Message>): Message =>
  new Message({
    ...message,
    ...fields,
    steps: endedSteps(message.steps),
  });

const requireInProgress = (message: Message, action: string) =>
  isInProgress(message.status)
    ? undefined
    : new InvalidMessageTransition({
        messageId: message.id,
        from: message.status,
        action,
      });

/**
 * Pure transitions for an assistant message. Only a reply in progress can change; a stop request
 * does not end the turn, so a stopping reply still takes text and may still complete or fail.
 */
export const MessageTransitions = {
  appendDelta: (message: Message, delta: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "appendDelta") ?? new Message({ ...message, content: message.content + delta }),

  /** The turn finished; `usage` is what it took and used, when the runtime said. */
  complete: (message: Message, finalContent?: string, usage?: ReplyUsage): Message | InvalidMessageTransition =>
    requireInProgress(message, "complete") ??
    endTurn(message, {
      content: finalContent ?? message.content,
      status: "complete",
      ...(usage === undefined ? {} : { usage }),
    }),

  fail: (message: Message, error: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "fail") ?? endTurn(message, { status: "failed", error }),

  /**
   * The runtime failed. A reply that had started writing was cut off, so it keeps its text and can
   * be continued; one that had written nothing failed.
   */
  cutOff: (message: Message, error: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "cutOff") ??
    endTurn(message, { status: message.content.length > 0 ? "interrupted" : "failed", error }),

  /** The provider's usage limit ended the turn; the text so far is kept. */
  limit: (message: Message, resetsAt: string | null): Message | InvalidMessageTransition =>
    requireInProgress(message, "limit") ?? endTurn(message, { status: "limited", error: null, resetsAt }),

  /** Continue: a reply that ended early streams again, appending to the text it kept. */
  resume: (message: Message): Message | InvalidMessageTransition =>
    message.role === "assistant" && isResumable(message.status)
      ? new Message({ ...message, status: "streaming", error: null, resetsAt: null, usage: null })
      : new InvalidMessageTransition({ messageId: message.id, from: message.status, action: "resume" }),

  /** Replaces the steps of a reply in progress, as the runtime reports them. */
  setSteps: (message: Message, steps: ReadonlyArray<ReplyStep>): Message | InvalidMessageTransition =>
    requireInProgress(message, "setSteps") ?? new Message({ ...message, steps }),

  /** Records the user's stop request. Asking again while stopping changes nothing. */
  requestStop: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "requestStop") ?? new Message({ ...message, status: "stopping" }),

  /** The turn ended: stopped when the user asked for it, otherwise interrupted by Hobbots. */
  interrupt: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "interrupt") ??
    endTurn(message, { status: message.status === "stopping" ? "stopped" : "interrupted" }),
};

/** Pure transitions for a user message waiting in its thread's queue (CH-008). */
export const QueuedMessageTransitions = {
  /** The message's turn starts: it leaves the queue and joins the transcript. */
  start: (message: Message): Message | InvalidMessageTransition =>
    message.role === "user" && message.status === "queued"
      ? new Message({ ...message, status: "complete" })
      : new InvalidMessageTransition({ messageId: message.id, from: message.status, action: "start" }),
};
