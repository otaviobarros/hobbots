import { type Agent, type AgentId, type HistoryFilter, STARTER_ROLES, type Thread } from "@hobbots/domain";
import { Schema } from "effect";
import type { ThreadActivity } from "../../api/activity.ts";
import { firstLine } from "../../lib/format.ts";
import type { HobNeed, HobState } from "../../lib/hob-state.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { blockerWhat } from "../blockers/blocker-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** The page's tabs; Chats is the default and stays out of the URL. */
const HOB_PAGE_TABS = ["chats", "history", "memory", "skills"] as const;
export const HobPageTab = Schema.Literals(HOB_PAGE_TABS);
export type HobPageTab = typeof HobPageTab.Type;

export const isHobPageTab = Schema.is(HobPageTab);

/** The History tab's filters, in the order they show; Everything is the default and stays out of the URL. */
export const HISTORY_FILTERS = ["all", "work", "you", "quest"] as const satisfies ReadonlyArray<HistoryFilter>;

/** The badge variants a hob's state tag takes (the four status families of the design system). */
type StateTagVariant = "needs-you" | "working" | "resting" | "failed" | "done";

export interface StateTag {
  readonly variant: StateTagVariant;
  /** The family's glyph, so the tag reads without color. */
  readonly glyph: string;
  readonly word: string;
}

/**
 * A hob's state as one tag: needs you, working, resting or failed, with its glyph and word. A `fresh`
 * hob, one with no chats yet, rests as New.
 */
export const stateTag = (state: HobState, fresh = false): StateTag => {
  if (fresh && (state === "idle" || state === "asleep")) return { variant: "done", glyph: "✦", word: copy.tags.new };
  switch (state) {
    case "needs-you":
    case "waiting":
      return { variant: "needs-you", glyph: "!", word: copy.tags.needsYou };
    case "working":
    case "thinking":
      return { variant: "working", glyph: "●", word: copy.tags.working };
    case "on-command":
      return { variant: "working", glyph: "◷", word: copy.tags.onCommand };
    case "failed":
      return { variant: "failed", glyph: "✗", word: copy.tags.failed };
    case "paused":
      return { variant: "resting", glyph: "◷", word: copy.tags.paused };
    case "idle":
    case "asleep":
      return { variant: "resting", glyph: "◷", word: copy.tags.resting };
  }
};

/** The quiet line under the role: how many chats, and since when the hob has been around. */
export const statsLine = (hob: Pick<Agent, "createdAt">, chats: number): string =>
  copy.stats.line({ chats: copy.stats.chats({ count: chats }), since: copy.stats.since({ date: hob.createdAt }) });

/** What the speech bubble says, or null when the hob is resting and has nothing to say. */
export type Doing =
  | { readonly kind: "needs-you"; readonly text: string }
  | { readonly kind: "live"; readonly text: string }
  | { readonly kind: "quiet"; readonly text: string };

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a hob waits on you for, in one line, as the tray says it: "Asks to push your work". A lead
 * holding a member's question names the member who asked.
 */
export const needLine = (need: HobNeed, hobId: AgentId, nameOf: (id: AgentId) => string): string => {
  switch (need.kind) {
    case "approval":
      return copy.doing.asksTo({ action: lowerFirst(operationLabel(need.operation)) });
    case "stuck":
      return copy.doing.stuck({ what: blockerWhat(need.item) });
    case "question":
      return need.askerId === hobId
        ? copy.doing.asksYou({ text: firstLine(need.text) })
        : copy.doing.passesOn({ name: nameOf(need.askerId), text: firstLine(need.text) });
  }
};

/**
 * What the hob is doing, for the bubble in its hero. Needing you comes first, with what it asks when
 * `need` says, then the chat it is writing in or thinking about. A paused hob says so; a resting hob
 * shows no bubble.
 */
export const doingOf = (
  state: HobState,
  threads: ReadonlyArray<Pick<Thread, "id" | "title">>,
  activity: Readonly<Record<string, ThreadActivity>>,
  need?: string,
): Doing | null => {
  if (state === "needs-you" || state === "waiting") return { kind: "needs-you", text: need ?? copy.doing.waiting };
  if (state === "paused") return { kind: "quiet", text: copy.doing.paused };
  const writing = threads.find((thread) => activity[thread.id] === "working");
  if (writing) return { kind: "live", text: copy.doing.writing({ title: writing.title }) };
  const thinking = threads.find((thread) => activity[thread.id] === "thinking");
  if (thinking) return { kind: "live", text: copy.doing.thinking({ title: thinking.title }) };
  const waiting = threads.find((thread) => activity[thread.id] === "waiting");
  if (waiting) return { kind: "live", text: copy.doing.onCommand({ title: waiting.title }) };
  return null;
};

/** What a new hob says first: hello, and its role's line when it took a starter role. */
export const helloOf = (hob: Pick<Agent, "name" | "role">): string =>
  copy.newHob.hello({ name: hob.name, note: STARTER_ROLES.find((role) => role.id === hob.role)?.note ?? null });

/** Three first asks that fit the hob: its own for an everyday helper, else its role family's. */
export const startersOf = (hob: Pick<Agent, "role">): ReadonlyArray<string> => {
  const role = STARTER_ROLES.find((each) => each.id === hob.role);
  const starters: Readonly<Record<string, ReadonlyArray<string>>> = copy.newHob.starters;
  return (role && (starters[role.id] ?? starters[role.family])) ?? copy.newHob.starters.assistant;
};
