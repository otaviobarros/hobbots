import type { StartFreshRefusal } from "@hobbots/api";
import type { ThreadId } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";

// Start fresh (ADR 037, #1378) as one reducer over a union of its steps (STD-REACT-029): the sheet
// asks, the chat starts fresh under a key, and a failure says why and can be tried again.

/** Why the chat was not started fresh: the hub's refusal, or no answer. */
export type StartFreshError = StartFreshRefusal | "unreachable";

export type StartFresh =
  | { readonly step: "asking" }
  | { readonly step: "starting"; readonly key: ThreadId }
  | { readonly step: "failed"; readonly key: ThreadId; readonly error: StartFreshError };

export type StartFreshEvent =
  /** `key` is a new key, used unless a failed try is tried again, whose key is kept. */
  { readonly _tag: "Start"; readonly key: ThreadId } | { readonly _tag: "Failed"; readonly error: StartFreshError };

export const ASKING: StartFresh = { step: "asking" };

export const startFreshStep = (state: StartFresh, event: StartFreshEvent): StartFresh => {
  switch (event._tag) {
    case "Start":
      if (state.step === "starting") return state;
      // The same request again: had the first gone through before its answer was lost, the hub
      // answers it as it did, instead of starting the new chat fresh too.
      return { step: "starting", key: state.step === "failed" ? state.key : event.key };
    case "Failed":
      return state.step === "starting" ? { ...state, step: "failed", error: event.error } : state;
  }
};

const REFUSALS: ReadonlySet<string> = new Set<StartFreshRefusal>([
  "reply-running",
  "approval-pending",
  "hob-retired",
  "not-open-chat",
]);

/** The failure a refused or lost request shows. */
export const startFreshError = (error: unknown): StartFreshError => {
  if (!(error instanceof ApiError) || error.tag !== "StartFreshRefused") return "unreachable";
  const reason = String(error.fields.reason);
  return REFUSALS.has(reason) ? (reason as StartFreshRefusal) : "unreachable";
};

/** Whether trying again can help: a refusal stands until what caused it changes, but a lost answer may not. */
export const canRetry = (error: StartFreshError) => error !== "not-open-chat" && error !== "hob-retired";
