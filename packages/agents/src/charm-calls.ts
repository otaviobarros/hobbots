import { CharmCallNotFound, CharmCallSettled, UserSession } from "@hobbots/api";
import {
  type AgentId,
  CharmCall,
  type CharmCallState,
  type MessageId,
  stableJson,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, type Duration, Effect, Layer, Option, type Scope } from "effect";
import type { HubCallStep } from "./runtime.ts";

/** What recording a call found: it is new and may be sent, or a call already holds its key or its site. */
export type CharmCallStart =
  | { readonly _tag: "Started" }
  /** The hob used this key before in the same work: the call it named then, with its result or state. */
  | { readonly _tag: "Existing"; readonly call: CharmCall }
  /** Another call of the same tool on the same site is still being sent or is uncertain. */
  | { readonly _tag: "Blocked"; readonly call: CharmCall };

/**
 * The Charm call records (ADR 020, ADR 031, migrations 0028 and 0074): every Charm write, recorded
 * with its key before anything is sent, so a call the runtime retries is never sent twice, and a call
 * that ended without a clear result is read back before anything else is sent to the same place.
 */
export class CharmCalls extends Context.Service<
  CharmCalls,
  {
    /**
     * Records a call in `sending`, in one transaction with the checks: a call already holding the
     * hob's key in the same work, or in `also`, is returned instead, unless it was `not-sent` with the same input, which this call
     * replaces; a call of the same tool on the same site that is still `sending` or `uncertain`
     * blocks it.
     */
    readonly begin: (call: CharmCall, also?: string) => Effect.Effect<CharmCallStart>;
    /**
     * Moves `call`'s sending, if it is not yet settled, to `state`, with what the hob is told, in one
     * atomic step. None when it is not found, has settled already, or the key was sent again since,
     * so a late or racing outcome never overwrites a settled one or lands on a later sending. The
     * sending is found by its attempt, so it settles even after its reply's calls moved to the Task the
     * reply started (#660).
     */
    readonly settle: (
      call: CharmCall,
      state: CharmCallState,
      result: string | null,
      at: string,
    ) => Effect.Effect<Option.Option<CharmCall>>;
    /** The hob's call with `key` in any of `scopes`. */
    readonly find: (
      agentId: AgentId,
      scopes: ReadonlyArray<string>,
      key: string,
    ) => Effect.Effect<Option.Option<CharmCall>>;
    /** `call`'s sending as stored now, by its attempt, in whatever work it moved to. None when the key was sent again since. */
    readonly current: (call: CharmCall) => Effect.Effect<Option.Option<CharmCall>>;
    /** The call shown as this reply step. */
    readonly findByStep: (
      threadId: ThreadId,
      messageId: MessageId,
      stepId: string,
    ) => Effect.Effect<Option.Option<CharmCall>>;
    /** The thread's calls, oldest first, so its steps can show how each settled. */
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CharmCall>>;
    /** Every call still `sending` or `uncertain`, oldest first, for reading the Charm back. */
    readonly unsettled: Effect.Effect<ReadonlyArray<CharmCall>>;
  }
>()("@hobbots/agents/CharmCalls") {}

/** How the user settles an uncertain call, after looking on the Charm's side. */
export type CharmCallSettlement = "applied" | "not-sent";

/** What the hob is told once the user settled its call, which named `charm`. */
const settledText = (charm: string, outcome: CharmCallSettlement) =>
  outcome === "applied"
    ? `The user looked on ${charm} and settled this call as applied.`
    : `The user looked on ${charm} and settled this call as not sent, so it may be made again.`;

/**
 * The user's side of the call records (ADR 020): the thread's calls, and settling an uncertain one
 * from its step once they have looked on the Charm's side, such as GitHub. Only the user settles a
 * call: it needs a `UserSession`, which no hob, Charm or runtime tool has (PE-006).
 */
export class CharmCallService extends Context.Service<
  CharmCallService,
  {
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CharmCall>>;
    readonly settle: (
      threadId: ThreadId,
      messageId: MessageId,
      stepId: string,
      outcome: CharmCallSettlement,
    ) => Effect.Effect<CharmCall, CharmCallNotFound | CharmCallSettled, UserSession>;
  }
>()("@hobbots/agents/CharmCallService") {
  static readonly layer = Layer.effect(
    CharmCallService,
    Effect.gen(function* () {
      const calls = yield* CharmCalls;
      return CharmCallService.of({
        listForThread: calls.listForThread,
        settle: (threadId, messageId, stepId, outcome) =>
          Effect.gen(function* () {
            yield* UserSession;
            const found = yield* calls.findByStep(threadId, messageId, stepId);
            if (Option.isNone(found)) return yield* new CharmCallNotFound({ stepId });
            const call = found.value;
            if (call.state !== "uncertain") return yield* new CharmCallSettled({ stepId, state: call.state });
            const at = DateTime.formatIso(yield* DateTime.now);
            const settled = yield* calls.settle(call, outcome, settledText(call.charm, outcome), at);
            // Reading the Charm back may have settled it a moment before.
            if (Option.isNone(settled)) {
              const now = yield* calls.current(call);
              return yield* new CharmCallSettled({
                stepId,
                state: Option.isSome(now) ? now.value.state : call.state,
              });
            }
            return settled.value;
          }),
      });
    }),
  );
}

/**
 * The never-twice rule of ADR 020 for every Charm write, which the hub action pipeline runs (ADR
 * 031): a call is recorded with its key before anything is sent, a retried key returns the first
 * result, and a call that ended without a clear answer is read back on the Charm's side, never sent
 * again by itself. Not finding the effect proves nothing, so such a call stays uncertain, and blocks
 * writes of the same tool on the same site, until reading back finds the effect or the user settles
 * it. A tool without a read-back waits for the user alone.
 */

/** How a write ended, with what the hob is told. */
export type WriteOutcome =
  | { readonly _tag: "Applied"; readonly text: string }
  /** The Charm's service answered no, so nothing was done. The same key returns this answer. */
  | { readonly _tag: "Refused"; readonly text: string }
  /** Nothing reached the service. The hob may call again, even with the same key, and is decided again. */
  | { readonly _tag: "NotSent"; readonly text: string }
  /** It may have taken effect. */
  | { readonly _tag: "Uncertain"; readonly text: string };

/** What a hob is told for a call to `charm` that is still uncertain: never to repeat it. */
export const uncertainNote = (charm: string, readsBack: boolean): string =>
  readsBack
    ? `Hobbots does not know whether this took effect. Do not repeat it: Hobbots keeps checking ${charm}, and the user can settle it from the step. Tell the user.`
    : "Hobbots does not know whether this took effect. Do not repeat it: the user can settle it from the step. Tell the user.";

const STATE: Record<WriteOutcome["_tag"], CharmCallState> = {
  Applied: "applied",
  Refused: "refused",
  NotSent: "not-sent",
  Uncertain: "uncertain",
};

/**
 * A tool's way to read the Charm's side back for one of its calls: true when its effect is there, or
 * what the hob is told about it when reading back learned more than the plan knew, such as a pull
 * request's link.
 */
export type ReadBack = (call: CharmCall) => Effect.Effect<boolean | string, unknown>;

/** When an uncertain call is read back again: a few times over the next minutes, then the user decides. */
export const READ_BACK_AFTER: ReadonlyArray<Duration.Input> = ["20 seconds", "1 minute", "3 minutes", "10 minutes"];

export interface CharmWrite {
  readonly agentId: AgentId;
  /** The work the key belongs to (#660): the turn's `CharmTurn.scope`. */
  readonly scope: string;
  /** Another scope a retry of the key is found in: the turn's `CharmTurn.also`. */
  readonly also?: string | undefined;
  readonly tool: string;
  readonly key: string;
  /** The call's input without its key, as the record keeps it: redacted. */
  readonly input: unknown;
  readonly site: string;
  /** What the hub fixed when it decided, which reading back compares against. */
  readonly plan: object;
  /** What the hob is told when reading the Charm back finds the call took effect. */
  readonly appliedText: string;
  readonly step: HubCallStep | undefined;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
}

/** The scopes a turn's retried key is found in: its own, then its reply's (#660). */
export const scopesOf = (turn: { readonly scope: () => string; readonly also?: string | undefined }) =>
  turn.also === undefined ? [turn.scope()] : [turn.scope(), turn.also];

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Runs `charm`'s writes under the call records, and reads uncertain ones back with each tool's
 * `readBack`. `charm` is the Charm's name as the hob and the user read it, such as "GitHub".
 */
export const makeCharmCallRunner = (charm: string, readBacks: Readonly<Record<string, ReadBack>>) =>
  Effect.gen(function* () {
    const calls = yield* CharmCalls;
    // Read-backs run in the Charm's scope, so they stop with the hub.
    const scope = yield* Effect.scope;

    /** What the hob is told for a call of this Charm's that is still uncertain. */
    const noteFor = (call: Pick<CharmCall, "charm" | "tool">) =>
      uncertainNote(call.charm, Object.hasOwn(readBacks, call.tool));

    /** The answer an earlier call with the same key gave, or why the key cannot be used. */
    const earlierAnswer = (call: CharmCall, input: string): string => {
      if (call.input !== input) {
        return `You already used the key ${call.key} for another call. Choose a new key for a new call.`;
      }
      switch (call.state) {
        case "sending":
          return "This call is still being sent. Wait for its result, and do not repeat it.";
        case "uncertain":
          return `${call.result ?? `This call ended without a clear answer from ${call.charm}.`} ${noteFor(call)}`;
        default:
          return `You made this call before, so it was not sent again. Its result then: ${call.result ?? "none recorded."}`;
      }
    };

    /** Settles the call as applied when its effect is on the Charm's side; what the hob is told when it did. */
    const readBack = (call: CharmCall) =>
      Effect.gen(function* () {
        const check = readBacks[call.tool];
        if (check === undefined) return Option.none<string>();
        const found = yield* check(call).pipe(Effect.orElseSucceed(() => false));
        if (found === false) return Option.none<string>();
        const text = found === true ? call.appliedText : found;
        const at = yield* nowIso;
        // Settles only this sending: the user may have settled it, and the key been sent again, meanwhile.
        const settled = yield* calls.settle(call, "applied", text, at);
        return Option.map(settled, () => text);
      });

    /** Reads an uncertain call back a few more times, in the background, until it settles. */
    const watch = (call: CharmCall) =>
      Effect.gen(function* () {
        for (const delay of READ_BACK_AFTER) {
          yield* Effect.sleep(delay);
          // By its attempt: starting a Task moves its reply's calls to the Task's work meanwhile (#660).
          const now = yield* calls.current(call);
          if (Option.isNone(now) || now.value.state !== "uncertain") return;
          if (Option.isSome(yield* readBack(now.value))) return;
        }
      }).pipe(Effect.forkIn(scope), Effect.asVoid);

    // Calls the hub left in flight when it stopped are uncertain now, and are read back like any
    // other. Each Charm's runner takes its own calls only.
    const startup = Effect.gen(function* () {
      for (const call of yield* calls.unsettled) {
        if (call.charm !== charm) continue;
        const at = yield* nowIso;
        const uncertain =
          call.state === "sending"
            ? yield* calls.settle(call, "uncertain", "The hub stopped while this call was being sent.", at)
            : Option.some(call);
        if (Option.isSome(uncertain) && Option.isNone(yield* readBack(uncertain.value))) yield* watch(uncertain.value);
      }
    });
    yield* startup.pipe(Effect.ignore, Effect.forkIn(scope));

    /**
     * The answer for a key used before in the same work, before anything is decided, so a retried call never asks the
     * user again. None when the key is new, or names a call that was not sent and may run again.
     */
    const earlier = (agentId: AgentId, scopes: ReadonlyArray<string>, key: string, input: unknown) =>
      Effect.gen(function* () {
        const stored = yield* calls.find(agentId, scopes, key);
        if (Option.isNone(stored)) return Option.none<string>();
        const call = stored.value;
        const sameInput = call.input === stableJson(input);
        if (call.state === "not-sent" && sameInput) return Option.none<string>();
        // An uncertain call may have settled on the Charm's side since: look before answering.
        const found = call.state === "uncertain" && sameInput ? yield* readBack(call) : Option.none<string>();
        if (Option.isSome(found)) {
          return Option.some(`You made this call before, so it was not sent again. Its result then: ${found.value}`);
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
          scope: write.scope,
          key: write.key,
          attempt: crypto.randomUUID(),
          charm,
          tool: write.tool,
          input: stableJson(write.input),
          site: write.site,
          plan: JSON.stringify(write.plan),
          appliedText: write.appliedText,
          state: "sending",
          result: null,
          threadId: write.threadId,
          messageId: write.messageId,
          stepId: write.step?.id ?? null,
          createdAt: at,
          updatedAt: at,
        });
        const started = yield* calls.begin(record, write.also);
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
        const found = sent._tag === "Uncertain" ? yield* readBack(record) : Option.none<string>();
        const outcome: WriteOutcome = Option.isSome(found) ? { _tag: "Applied", text: found.value } : sent;
        if (outcome._tag !== "Applied" || sent._tag !== "Uncertain") {
          yield* calls.settle(record, STATE[outcome._tag], outcome.text, yield* nowIso);
        }
        if (outcome._tag === "Uncertain") {
          write.step?.report({ _tag: "ToolUncertain", id: write.step.id, reason: outcome.text });
          yield* watch(record);
          return { _tag: "Uncertain", text: `${outcome.text} ${noteFor(record)}` } as const;
        }
        return outcome;
      });

    return { earlier, run };
  });

export type CharmCallRunner = Effect.Success<ReturnType<typeof makeCharmCallRunner>>;
