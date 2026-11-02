import { CharmCalls, type HubCallStep } from "@hobbots/agents";
import {
  type AgentId,
  CharmCall,
  type CharmCallState,
  type MessageId,
  stableJson,
  type ThreadId,
} from "@hobbots/domain";
import { DateTime, type Duration, Effect, Option, type Scope } from "effect";

/**
 * The never-twice rule of ADR 020 for every Charm write: a call is recorded with its key before
 * anything is sent, a retried key returns the first result, and a call that ended without a clear
 * answer is read back on GitHub, never sent again by itself. Not finding the effect proves nothing,
 * so such a call stays uncertain, and blocks writes of the same tool on the same site, until reading
 * back finds the effect or the user settles it. #323 builds it for Push, #324 reuses it.
 */

/** How a write ended, with what the hob is told. */
export type WriteOutcome =
  | { readonly _tag: "Applied"; readonly text: string }
  /** GitHub answered no, so nothing was done. The same key returns this answer. */
  | { readonly _tag: "Refused"; readonly text: string }
  /** Nothing reached GitHub. The hob may call again, even with the same key, and is decided again. */
  | { readonly _tag: "NotSent"; readonly text: string }
  /** It may have taken effect. */
  | { readonly _tag: "Uncertain"; readonly text: string };

/** What a hob is told for a call that is still uncertain: never to repeat it. */
export const UNCERTAIN_NOTE =
  "Hobbots does not know whether this took effect. Do not repeat it: Hobbots keeps checking GitHub, and the user can settle it from the step. Tell the user.";

const STATE: Record<WriteOutcome["_tag"], CharmCallState> = {
  Applied: "applied",
  Refused: "refused",
  NotSent: "not-sent",
  Uncertain: "uncertain",
};

/** A tool's way to read GitHub back for one of its calls: true when its effect is there. */
export type ReadBack = (call: CharmCall) => Effect.Effect<boolean, unknown>;

/** When an uncertain call is read back again: a few times over the next minutes, then the user decides. */
export const READ_BACK_AFTER: ReadonlyArray<Duration.Input> = ["20 seconds", "1 minute", "3 minutes", "10 minutes"];

export interface CharmWrite {
  readonly agentId: AgentId;
  readonly tool: string;
  readonly key: string;
  /** The call's input without its key. */
  readonly input: unknown;
  readonly site: string;
  /** What the hub fixed when it decided, which reading back compares against. */
  readonly plan: object;
  /** What the hob is told when reading GitHub back finds the call took effect. */
  readonly appliedText: string;
  readonly step: HubCallStep | undefined;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
}

/** The answer an earlier call with the same key gave, or why the key cannot be used. */
const earlierAnswer = (call: CharmCall, input: string): string => {
  if (call.input !== input) {
    return `You already used the key ${call.key} for another call. Choose a new key for a new call.`;
  }
  switch (call.state) {
    case "sending":
      return "This call is still being sent. Wait for its result, and do not repeat it.";
    case "uncertain":
      return `${call.result ?? "This call ended without a clear answer from GitHub."} ${UNCERTAIN_NOTE}`;
    default:
      return `You made this call before, so it was not sent again. Its result then: ${call.result ?? "none recorded."}`;
  }
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Runs Charm writes under the call records, and reads uncertain ones back with each tool's `readBack`. */
export const makeCharmCallRunner = (readBacks: Readonly<Record<string, ReadBack>>) =>
  Effect.gen(function* () {
    const calls = yield* CharmCalls;
    // Read-backs run in the Charm's scope, so they stop with the hub.
    const scope = yield* Effect.scope;

    /** Settles the call as applied when its effect is on GitHub; true when it did. */
    const readBack = (call: CharmCall) =>
      Effect.gen(function* () {
        const check = readBacks[call.tool];
        if (check === undefined) return false;
        const found = yield* check(call).pipe(Effect.orElseSucceed(() => false));
        if (!found) return false;
        const at = yield* nowIso;
        // Settles only this sending: the user may have settled it, and the key been sent again, meanwhile.
        return Option.isSome(yield* calls.settle(call, "applied", appliedText(call), at));
      });

    /** Reads an uncertain call back a few more times, in the background, until it settles. */
    const watch = (call: CharmCall) =>
      Effect.gen(function* () {
        for (const delay of READ_BACK_AFTER) {
          yield* Effect.sleep(delay);
          const now = yield* calls.find(call.agentId, call.key);
          if (Option.isNone(now) || now.value.attempt !== call.attempt || now.value.state !== "uncertain") return;
          if (yield* readBack(now.value)) return;
        }
      }).pipe(Effect.forkIn(scope), Effect.asVoid);

    // Calls the hub left in flight when it stopped are uncertain now, and are read back like any other.
    const startup = Effect.gen(function* () {
      for (const call of yield* calls.unsettled) {
        const at = yield* nowIso;
        const uncertain =
          call.state === "sending"
            ? yield* calls.settle(call, "uncertain", "The hub stopped while this call was being sent.", at)
            : Option.some(call);
        if (Option.isSome(uncertain) && !(yield* readBack(uncertain.value))) yield* watch(uncertain.value);
      }
    });
    yield* startup.pipe(Effect.ignore, Effect.forkIn(scope));

    /**
     * The answer for a key used before, before anything is decided, so a retried call never asks the
     * user again. None when the key is new, or names a call that was not sent and may run again.
     */
    const earlier = (agentId: AgentId, key: string, input: unknown) =>
      Effect.gen(function* () {
        const stored = yield* calls.find(agentId, key);
        if (Option.isNone(stored)) return Option.none<string>();
        const call = stored.value;
        const sameInput = call.input === stableJson(input);
        if (call.state === "not-sent" && sameInput) return Option.none<string>();
        // An uncertain call may have settled on GitHub since: look before answering.
        if (call.state === "uncertain" && sameInput && (yield* readBack(call))) {
          return Option.some(
            `You made this call before, so it was not sent again. Its result then: ${appliedText(call)}`,
          );
        }
        return Option.some(earlierAnswer(call, stableJson(input)));
      });

    /**
     * Records the write, sends it with `send`, and stores how it ended. A write whose end is unclear
     * is read back once at once, and in the background after that.
     */
    const run = (
      write: CharmWrite,
      send: Effect.Effect<WriteOutcome>,
    ): Effect.Effect<WriteOutcome, never, Scope.Scope> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const record = new CharmCall({
          agentId: write.agentId,
          key: write.key,
          attempt: crypto.randomUUID(),
          tool: write.tool,
          input: stableJson(write.input),
          site: write.site,
          plan: JSON.stringify({ ...write.plan, appliedText: write.appliedText }),
          state: "sending",
          result: null,
          threadId: write.threadId,
          messageId: write.messageId,
          stepId: write.step?.id ?? null,
          createdAt: at,
          updatedAt: at,
        });
        const started = yield* calls.begin(record);
        if (started._tag === "Existing") {
          return { _tag: "Refused", text: earlierAnswer(started.call, record.input) } as const;
        }
        if (started._tag === "Blocked") {
          return {
            _tag: "Refused",
            text: "An earlier call to the same place has not settled yet, so this one did not run. Hobbots will not send two at once. Ask the user to check the earlier one.",
          } as const;
        }
        const sent = yield* send;
        const outcome: WriteOutcome =
          sent._tag === "Uncertain" && (yield* readBack(record))
            ? { _tag: "Applied", text: appliedText(record) }
            : sent;
        if (outcome._tag !== "Applied" || sent._tag !== "Uncertain") {
          yield* calls.settle(record, STATE[outcome._tag], outcome.text, yield* nowIso);
        }
        if (outcome._tag === "Uncertain") {
          write.step?.report({ _tag: "ToolUncertain", id: write.step.id, reason: outcome.text });
          yield* watch(record);
          return { _tag: "Uncertain", text: `${outcome.text} ${UNCERTAIN_NOTE}` } as const;
        }
        return outcome;
      });

    return { earlier, run };
  });

/** What a call found applied by reading GitHub back is told, from its plan. */
const appliedText = (call: CharmCall): string => {
  const plan = JSON.parse(call.plan) as { readonly appliedText?: unknown };
  return typeof plan.appliedText === "string" ? plan.appliedText : "GitHub shows it took effect.";
};

export type CharmCallRunner = Effect.Success<ReturnType<typeof makeCharmCallRunner>>;
