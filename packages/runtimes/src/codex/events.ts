import { RuntimeError, type RuntimeEvent, RuntimeLimitReached } from "@hobbots/agents";
import type { ReplyUsage } from "@hobbots/domain";
import { Deferred, type Duration, Effect, Option } from "effect";
import type { AppServerNotification } from "./app-server.ts";
import type {
  FileUpdateChange,
  ThreadItem,
  TokenUsageBreakdown,
  Turn,
  TurnError,
  TurnNotification,
} from "./protocol.ts";

/**
 * How a Codex turn ended, from its `turn/completed` (ADR 024). `interrupted` is the acknowledgement
 * of `turn/interrupt`: Codex has stopped, and what it ran was stopped with it.
 */
export type TurnEnd =
  | { readonly _tag: "Completed"; readonly event: RuntimeEvent }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly error: RuntimeError | RuntimeLimitReached };

/** What one notification means for the turn: events to report, and the end once it arrived. */
export interface TurnStep {
  readonly events: ReadonlyArray<RuntimeEvent>;
  readonly end?: TurnEnd;
}

const NOTHING: TurnStep = { events: [] };

/** Why a turn whose App Server exited before `turn/completed` is not done (ADR 024). */
export const LOST_TURN =
  "Codex stopped before the turn ended, so what it was doing may or may not have finished. Check before running it again.";

/** Why a tool call that was running when Codex stopped is uncertain. */
export const LOST_CALL = "Codex stopped while this ran, so it may or may not have taken effect.";

/**
 * Codex counts cached input inside its input tokens, as OpenAI's API does; Hobbots counts input that
 * was neither read from nor written to the cache, as Claude Code reports it.
 */
const toUsage = (used: TokenUsageBreakdown): ReplyUsage => ({
  // Codex reports no timings for a turn.
  timeToRequestMs: null,
  timeToFirstStreamMs: null,
  timeToFirstTokenMs: null,
  inputTokens: Math.max(0, used.inputTokens - used.cachedInputTokens - used.cacheWriteInputTokens),
  outputTokens: used.outputTokens,
  cacheReadTokens: used.cachedInputTokens,
  cacheWriteTokens: used.cacheWriteInputTokens,
});

const minus = (a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown => ({
  totalTokens: a.totalTokens - b.totalTokens,
  inputTokens: a.inputTokens - b.inputTokens,
  cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
  cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
  outputTokens: a.outputTokens - b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
});

/** The error a failed turn ends with: the usage limit as its own error, anything else as Codex said it. */
const turnFailure = (error: TurnError | null): RuntimeError | RuntimeLimitReached => {
  if (error?.codexErrorInfo === "usageLimitExceeded") return new RuntimeLimitReached({ resetsAt: null });
  const detail = error?.additionalDetails ? ` ${error.additionalDetails}` : "";
  return new RuntimeError({ message: error ? `${error.message}${detail}` : "The Codex turn failed." });
};

/**
 * Maps one Codex turn's notifications to runtime events. Stateful, so make one per turn, once the
 * turn's thread is known. Notifications of other threads or turns are left out, such as a
 * sub-agent's, which Hobbots turns off anyway.
 *
 * A tool call is reported as started by whatever decided and recorded it (`started`); from then on
 * its output and end come from Codex's items. A tool item nobody started is not reported here.
 */
export const codexTurnEvents = (threadId: string) => {
  let turnId: string | null = null;
  // The text of each agent message, in order, so the reply's text matches what was streamed.
  const messages = new Map<string, string>();
  const thinking = new Set<string>();
  const running = new Set<string>();
  // Each file change's files, from its `item/started`, which Codex sends before it asks about the change.
  const patches = new Map<string, Deferred.Deferred<ReadonlyArray<FileUpdateChange>>>();
  const patch = (itemId: string) => {
    const known = patches.get(itemId);
    if (known !== undefined) return known;
    const made = Deferred.makeUnsafe<ReadonlyArray<FileUpdateChange>>();
    patches.set(itemId, made);
    return made;
  };
  let baseline: TokenUsageBreakdown | null = null;
  let latest: TokenUsageBreakdown | null = null;
  let lastError: TurnError | null = null;

  // A new message after one that said something is set apart by a blank line, in the stream and in
  // the reply's text alike.
  const separator = (itemId: string): ReadonlyArray<RuntimeEvent> => {
    if (messages.has(itemId)) return [];
    const spoken = [...messages.values()].some((text) => text.length > 0);
    messages.set(itemId, "");
    return spoken ? [{ _tag: "TextDelta", text: "\n\n" }] : [];
  };

  const text = () => [...messages.values()].filter((message) => message.length > 0).join("\n\n");

  const itemStarted = (item: ThreadItem): TurnStep => {
    switch (item.type) {
      case "reasoning":
        thinking.add(item.id);
        return { events: [{ _tag: "StepStarted", id: item.id, kind: "thinking", label: "Thinking" }] };
      case "agentMessage":
        return { events: separator(item.id) };
      case "fileChange":
        Deferred.doneUnsafe(patch(item.id), Effect.succeed(item.changes));
        return NOTHING;
      default:
        return NOTHING;
    }
  };

  const toolFinished = (item: Extract<ThreadItem, { readonly status: string }>): TurnStep => {
    patches.delete(item.id);
    if (!running.delete(item.id)) return NOTHING;
    const output =
      item.type === "commandExecution"
        ? (item.aggregatedOutput ?? undefined)
        : item.type === "mcpToolCall"
          ? JSON.stringify(item.result ?? item.error)
          : undefined;
    const exitCode = item.type === "commandExecution" ? (item.exitCode ?? undefined) : undefined;
    return {
      events: [
        {
          _tag: "ToolFinished",
          id: item.id,
          failed: item.status !== "completed",
          ...(output === undefined ? {} : { output }),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      ],
    };
  };

  const itemCompleted = (item: ThreadItem): TurnStep => {
    if (item.type === "reasoning") {
      return thinking.delete(item.id) ? { events: [{ _tag: "StepEnded", id: item.id }] } : NOTHING;
    }
    if (item.type === "agentMessage") {
      // The completed item's text is Codex's own record of the message; the deltas only showed it.
      const before = separator(item.id);
      const streamed = messages.get(item.id) ?? "";
      messages.set(item.id, item.text);
      const rest = item.text.startsWith(streamed) ? item.text.slice(streamed.length) : "";
      return { events: rest.length > 0 ? [...before, { _tag: "TextDelta", text: rest }] : before };
    }
    // Codex compacted the thread: it now holds a summary of what came before (#1027).
    if (item.type === "contextCompaction") return { events: [{ _tag: "SessionCompacted" }] };
    return "status" in item ? toolFinished(item) : NOTHING;
  };

  const tokenUsage = (last: TokenUsageBreakdown, total: TokenUsageBreakdown): TurnStep => {
    // The thread's total before this turn's first request, so a resumed thread counts this turn only.
    baseline ??= minus(total, last);
    latest = total;
    return NOTHING;
  };

  const endAll = (): ReadonlyArray<RuntimeEvent> => {
    const ended = [...thinking].map((id): RuntimeEvent => ({ _tag: "StepEnded", id }));
    thinking.clear();
    return ended;
  };

  const turnCompleted = (turn: Turn): TurnStep => {
    const ended = endAll();
    switch (turn.status) {
      case "completed":
        return {
          events: ended,
          end: {
            _tag: "Completed",
            event: {
              _tag: "Completed",
              sessionId: threadId,
              text: text(),
              ...(latest === null || baseline === null ? {} : { usage: toUsage(minus(latest, baseline)) }),
            },
          },
        };
      case "interrupted":
        return { events: ended, end: { _tag: "Interrupted" } };
      default:
        return { events: ended, end: { _tag: "Failed", error: turnFailure(turn.error ?? lastError) } };
    }
  };

  const ours = (params: { readonly threadId?: string; readonly turnId?: string | null }) =>
    params.threadId === threadId && (turnId === null || params.turnId == null || params.turnId === turnId);

  const map = (received: AppServerNotification): TurnStep => {
    // Only the methods below are read, and each by the fields the protocol gives it.
    const notification = received as TurnNotification;
    const params = (notification.params ?? {}) as { readonly threadId?: string; readonly turnId?: string | null };
    if (!ours(params)) return NOTHING;
    switch (notification.method) {
      case "turn/started":
        turnId ??= notification.params.turn.id;
        return NOTHING;
      case "item/started":
        return itemStarted(notification.params.item);
      case "item/completed":
        return itemCompleted(notification.params.item);
      case "item/agentMessage/delta": {
        const { itemId, delta } = notification.params;
        const before = separator(itemId);
        messages.set(itemId, (messages.get(itemId) ?? "") + delta);
        return { events: [...before, { _tag: "TextDelta", text: delta }] };
      }
      case "item/commandExecution/outputDelta":
        return running.has(notification.params.itemId)
          ? { events: [{ _tag: "ToolOutput", id: notification.params.itemId, text: notification.params.delta }] }
          : NOTHING;
      case "thread/tokenUsage/updated":
        return tokenUsage(notification.params.tokenUsage.last, notification.params.tokenUsage.total);
      case "error":
        if (!notification.params.willRetry) lastError = notification.params.error;
        return NOTHING;
      case "turn/completed":
        return turnCompleted(notification.params.turn);
      default:
        return NOTHING;
    }
  };

  return {
    map,
    /** The turn this mapper follows, once Codex has said which, so other turns' notifications are left out. */
    follow: (id: string) => {
      turnId ??= id;
    },
    /**
     * The files a file change touches, once its `item/started` has been read, or none when it does not
     * arrive within `wait`.
     */
    changes: (itemId: string, wait: Duration.Input = "5 seconds") =>
      Deferred.await(patch(itemId)).pipe(Effect.timeoutOption(wait), Effect.map(Option.getOrUndefined)),
    /** A tool call the hub decided, recorded and let run: its output and end are reported from now on. */
    started: (itemId: string) => {
      running.add(itemId);
    },
    /**
     * The App Server exited before `turn/completed`: every running call is uncertain, open steps end,
     * and the turn fails as uncertain, never as done (ADR 024).
     */
    lost: (): { readonly events: ReadonlyArray<RuntimeEvent>; readonly error: RuntimeError } => {
      const uncertain = [...running].map((id): RuntimeEvent => ({ _tag: "ToolUncertain", id, reason: LOST_CALL }));
      running.clear();
      return { events: [...endAll(), ...uncertain], error: new RuntimeError({ message: LOST_TURN }) };
    },
  };
};

export type CodexTurnEvents = ReturnType<typeof codexTurnEvents>;
