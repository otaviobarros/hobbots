import type { MakeCampPayload } from "@hobbots/api";
import { CAMP_GOAL_MAX, THREAD_TITLE_MAX, type ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { ApiError } from "../../api/client.ts";

// Make a camp (ADR 037, #1378) as one reducer over a union of its steps (STD-REACT-029): you edit the
// camp's name, goal and privacy, it is saved under a key, and a failure keeps what you typed.

/** What you typed in the sheet, as you typed it. */
export interface CampDraft {
  readonly title: string;
  readonly goal: string;
  readonly private: boolean;
}

/** Why a field cannot be sent yet. */
export type CampProblem = "title-missing" | "title-long" | "goal-long";

/** Why the hub did not make the camp. */
export type MakeCampError = "hob-unavailable" | "unreachable";

export type MakeCamp =
  | {
      readonly step: "editing";
      readonly draft: CampDraft;
      /** The fields whose problems show: each once it lost focus, all of them after a send. */
      readonly shown: ReadonlySet<keyof CampDraft>;
    }
  | { readonly step: "saving"; readonly draft: CampDraft; readonly key: ThreadId }
  | { readonly step: "failed"; readonly draft: CampDraft; readonly key: ThreadId; readonly error: MakeCampError };

export type MakeCampEvent =
  | { readonly _tag: "Edit"; readonly draft: CampDraft }
  | { readonly _tag: "Leave"; readonly field: keyof CampDraft }
  /** `key` is a new key, used unless a failed camp is tried again unchanged. */
  | { readonly _tag: "Send"; readonly key: ThreadId }
  | { readonly _tag: "Failed"; readonly error: MakeCampError };

export const startMakeCamp = (title = ""): MakeCamp => ({
  step: "editing",
  draft: { title, goal: "", private: false },
  shown: new Set(),
});

// The rules the hub checks, stated once here for the sheet (STD-REACT-017).
const Title = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(THREAD_TITLE_MAX));
const Goal = Schema.String.check(Schema.isMaxLength(CAMP_GOAL_MAX));

/** What is wrong with each field of the draft, read as the hub reads it: trimmed. */
export const campProblems = (draft: CampDraft): Partial<Record<keyof CampDraft, CampProblem>> => {
  const title = draft.title.trim();
  const titleFits: boolean = Schema.is(Title)(title);
  const goalFits: boolean = Schema.is(Goal)(draft.goal.trim());
  return {
    ...(!titleFits && { title: title.length === 0 ? ("title-missing" as const) : ("title-long" as const) }),
    ...(!goalFits && { goal: "goal-long" as const }),
  };
};

/** What Make a camp sends for a draft with no problems: trimmed, and no goal when it is blank. */
export const campPayload = (draft: CampDraft, key: ThreadId): MakeCampPayload => {
  const goal = draft.goal.trim();
  return { key, title: draft.title.trim(), goal: goal === "" ? null : goal, private: draft.private };
};

const ALL_FIELDS: ReadonlySet<keyof CampDraft> = new Set(["title", "goal", "private"]);

export const makeCampStep = (state: MakeCamp, event: MakeCampEvent): MakeCamp => {
  switch (event._tag) {
    case "Edit":
      // Nothing changes while the camp is being made.
      if (state.step === "saving") return state;
      return { step: "editing", draft: event.draft, shown: state.step === "editing" ? state.shown : ALL_FIELDS };
    case "Leave":
      return state.step === "editing" ? { ...state, shown: new Set([...state.shown, event.field]) } : state;
    case "Send": {
      if (state.step === "saving") return state;
      if (Object.keys(campProblems(state.draft)).length > 0) return { ...state, step: "editing", shown: ALL_FIELDS };
      // Trying a failed camp again, unchanged, keeps its key, so a camp made before its answer was lost
      // is not made twice. An edit after a failure goes back to editing, and asks under a new key.
      const key = state.step === "failed" ? state.key : event.key;
      return { step: "saving", draft: state.draft, key };
    }
    case "Failed":
      return state.step === "saving" ? { ...state, step: "failed", error: event.error } : state;
  }
};

/** The failure a refused or lost request shows. */
export const makeCampError = (error: unknown): MakeCampError =>
  error instanceof ApiError && error.tag === "HobUnavailable" ? "hob-unavailable" : "unreachable";
