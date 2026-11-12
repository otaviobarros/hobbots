import { DECISION_TEXT_MAX, type Decision } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";

// Recording a decision from the camp sheet (ADR 037) as one reducer over a union of its steps
// (STD-REACT-029): you write a new decision or a change to one, it is saved under a key, and a
// failure keeps what you wrote. A change records a new decision that crosses the old one out.

/** Why the decision cannot be sent yet. */
export type DecisionProblem = "text-missing" | "text-long";

/** Why the hub did not record it. */
export type RecordDecisionError = "refused" | "unreachable";

/** What the form holds: the text, and the decision it changes, or null for a new one. */
interface Draft {
  readonly text: string;
  readonly replaces: Decision | null;
}

export type DecisionForm =
  | { readonly step: "closed" }
  | (Draft & { readonly step: "writing"; readonly shown: boolean })
  | (Draft & { readonly step: "saving"; readonly key: string })
  | (Draft & { readonly step: "failed"; readonly key: string; readonly error: RecordDecisionError });

export type DecisionFormEvent =
  /** Opens the form for a new decision, or for a change to `replaces`. */
  | { readonly _tag: "Open"; readonly replaces: Decision | null }
  | { readonly _tag: "Edit"; readonly text: string }
  /** `key` is a new key, used unless a failed decision is sent again unchanged. */
  | { readonly _tag: "Send"; readonly key: string }
  | { readonly _tag: "Saved" }
  | { readonly _tag: "Failed"; readonly error: RecordDecisionError }
  | { readonly _tag: "Close" };

export const DECISION_FORM_CLOSED: DecisionForm = { step: "closed" };

/** What is wrong with the text, read as the hub reads it: trimmed. */
export const decisionProblem = (text: string): DecisionProblem | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "text-missing";
  return trimmed.length > DECISION_TEXT_MAX ? "text-long" : null;
};

const sendDecision = (state: DecisionForm, key: string): DecisionForm => {
  if (state.step === "closed" || state.step === "saving") return state;
  if (decisionProblem(state.text) !== null) return { ...state, step: "writing", shown: true };
  // Sending a failed decision again, unchanged, keeps its key, so one saved before its answer was
  // lost is not recorded twice.
  return { step: "saving", text: state.text, replaces: state.replaces, key: state.step === "failed" ? state.key : key };
};

export const decisionFormStep = (state: DecisionForm, event: DecisionFormEvent): DecisionForm => {
  switch (event._tag) {
    case "Open":
      return state.step === "saving" ? state : { step: "writing", text: "", replaces: event.replaces, shown: false };
    case "Edit":
      // Nothing changes while it saves; an edit after a failure writes again, under a new key.
      if (state.step === "closed" || state.step === "saving") return state;
      return { step: "writing", text: event.text, replaces: state.replaces, shown: state.step === "failed" };
    case "Send":
      return sendDecision(state, event.key);
    case "Saved":
      return state.step === "saving" ? DECISION_FORM_CLOSED : state;
    case "Failed":
      return state.step === "saving" ? { ...state, step: "failed", error: event.error } : state;
    case "Close":
      return state.step === "saving" ? state : DECISION_FORM_CLOSED;
  }
};

/** The failure a refused or lost request shows. */
export const recordDecisionError = (error: unknown): RecordDecisionError =>
  error instanceof ApiError && error.tag === "DecisionChangeRefused" ? "refused" : "unreachable";
