import { CAMP_HOBS_MAX, type MakeCampPayload } from "@hobbots/api";
import { AgentId, CAMP_GOAL_MAX, CHANNEL_TITLE_MAX, type ChannelId } from "@hobbots/domain";
import { Schema } from "effect";
import { ApiError } from "../../api/client.ts";

// Make a camp (ADR 037, #1378) as one reducer over a union of its steps (STD-REACT-029): you edit the
// camp's name, goal, hobs and privacy, it is saved under a key, and a failure keeps what you typed.

/** What you typed in the sheet, as you typed it. */
export interface CampDraft {
  readonly title: string;
  readonly goal: string;
  readonly private: boolean;
  /** Whether the chapter it is made from moves into it, when it is made from one. */
  readonly chapter: boolean;
  /**
   * The hobs picked, in the order picked (ADR 039, Members): the first leads the camp's quests, and
   * the others join as members.
   */
  readonly hobs: ReadonlyArray<AgentId>;
}

/** Why a field cannot be sent yet. */
export type CampProblem = "title-missing" | "title-long" | "goal-long" | "hobs-missing" | "hobs-many";

/**
 * Why the hub did not make the camp. `chapter-busy`: a reply still runs in the chat, so its chapter
 * stays put until it ends. `chapter-refused`: the chapter moved or changed meanwhile.
 */
export type MakeCampError = "hob-unavailable" | "chapter-busy" | "chapter-refused" | "unreachable";

export type MakeCamp =
  | {
      readonly step: "editing";
      readonly draft: CampDraft;
      /** The fields whose problems show: each once it lost focus, all of them after a send. */
      readonly shown: ReadonlySet<keyof CampDraft>;
    }
  | { readonly step: "saving"; readonly draft: CampDraft; readonly key: ChannelId }
  | {
      readonly step: "failed";
      readonly draft: CampDraft;
      readonly key: ChannelId;
      readonly error: MakeCampError;
      /** The hob the hub turned away, when it named one. */
      readonly hob: AgentId | null;
    };

export type MakeCampEvent =
  | { readonly _tag: "Edit"; readonly draft: CampDraft }
  | { readonly _tag: "Leave"; readonly field: keyof CampDraft }
  /**
   * `key` is a new key, used unless a failed camp is tried again unchanged. `held`: the chat's
   * chapter cannot move now, as while a reply runs there, so a camp it comes along with waits.
   */
  | { readonly _tag: "Send"; readonly key: ChannelId; readonly held?: boolean }
  | { readonly _tag: "Failed"; readonly error: MakeCampError; readonly hob?: AgentId | null };

/**
 * A new camp's sheet, named `title`, with `goal`, and the chapter it is made from moving into it when
 * `chapter`.
 */
export const startMakeCamp = (title = "", chapter = false, goal = "", hobs: ReadonlyArray<AgentId> = []): MakeCamp => ({
  step: "editing",
  draft: { title, goal, private: false, chapter, hobs },
  shown: new Set(),
});

/**
 * The hobs picked once `hob` is ticked or unticked: a new pick goes last, so the first hob picked
 * keeps leading. `locked` stays first and picked, as the hob whose chapter moves into the camp does.
 */
export const toggleHob = (
  hobs: ReadonlyArray<AgentId>,
  hob: AgentId,
  locked: AgentId | null = null,
): ReadonlyArray<AgentId> => {
  if (hob === locked) return hobs;
  return hobs.includes(hob) ? hobs.filter((each) => each !== hob) : [...hobs, hob];
};

/**
 * The hobs picked once the chapter's own hob comes along again: the chapter moves to the camp its
 * hob leads, so that hob is picked and first, and the others keep their order.
 */
export const withChapterHob = (hobs: ReadonlyArray<AgentId>, hob: AgentId): ReadonlyArray<AgentId> => [
  hob,
  ...hobs.filter((each) => each !== hob),
];

// The rules the hub checks, stated once here for the sheet (STD-REACT-017).
const Title = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(CHANNEL_TITLE_MAX));
const Goal = Schema.String.check(Schema.isMaxLength(CAMP_GOAL_MAX));

/** What is wrong with each field of the draft, read as the hub reads it: trimmed. */
export const campProblems = (draft: CampDraft): Partial<Record<keyof CampDraft, CampProblem>> => {
  const title = draft.title.trim();
  const titleFits: boolean = Schema.is(Title)(title);
  const goalFits: boolean = Schema.is(Goal)(draft.goal.trim());
  return {
    ...(!titleFits && { title: title.length === 0 ? ("title-missing" as const) : ("title-long" as const) }),
    ...(!goalFits && { goal: "goal-long" as const }),
    ...(draft.hobs.length === 0 && { hobs: "hobs-missing" as const }),
    // The lead and at most CAMP_HOBS_MAX others, as the hub takes them.
    ...(draft.hobs.length > CAMP_HOBS_MAX + 1 && { hobs: "hobs-many" as const }),
  };
};

/**
 * What Make a camp sends for a draft with no problems: trimmed, and no goal when it is blank, and the
 * hobs after the first, which leads it and the camp is made for (`campLead`).
 */
export const campPayload = (draft: CampDraft, key: ChannelId): MakeCampPayload => {
  const goal = draft.goal.trim();
  return {
    key,
    title: draft.title.trim(),
    goal: goal === "" ? null : goal,
    private: draft.private,
    hobs: draft.hobs.slice(1),
  };
};

/** The hob a draft's camp is made for, which leads its quests: the first picked. */
export const campLead = (draft: CampDraft): AgentId | undefined => draft.hobs[0];

const ALL_FIELDS: ReadonlySet<keyof CampDraft> = new Set(["title", "goal", "private", "chapter", "hobs"]);

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
      // The hub would refuse the move; the sheet holds the camp until the chapter can move.
      if (event.held === true && state.draft.chapter) return state;
      if (Object.keys(campProblems(state.draft)).length > 0) return { ...state, step: "editing", shown: ALL_FIELDS };
      // Trying a failed camp again, unchanged, keeps its key, so a camp made before its answer was lost
      // is not made twice. An edit after a failure goes back to editing, and asks under a new key.
      const key = state.step === "failed" ? state.key : event.key;
      return { step: "saving", draft: state.draft, key };
    }
    case "Failed":
      return state.step === "saving" ? { ...state, step: "failed", error: event.error, hob: event.hob ?? null } : state;
  }
};

/** The hob a refused request names, such as one picked that was paused meanwhile. */
export const refusedHob = (error: unknown): AgentId | null => {
  const named = error instanceof ApiError ? error.fields["agentId"] : undefined;
  return typeof named === "string" ? AgentId.make(named) : null;
};

/** The failure a refused or lost request shows. */
export const makeCampError = (error: unknown): MakeCampError => {
  if (!(error instanceof ApiError)) return "unreachable";
  // The hob, or another hob picked, takes no new work, or is gone.
  if (error.tag === "HobUnavailable" || error.tag === "AgentNotFound") return "hob-unavailable";
  // A reply runs in the chat, or a quest in the chapter is led by a hob the camp does not admit.
  if (error.tag === "ChapterMoveRefused" && error.fields["reason"] === "reply-running") return "chapter-busy";
  // The chapter moved or merged meanwhile; the camp was not made.
  return error.tag === "ChapterMoveRefused" || error.tag === "ChapterMissing" ? "chapter-refused" : "unreachable";
};
