import type { Agent, Thread } from "@hobbots/domain";
import type { HobState } from "../../lib/hob-state.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** The page's two tabs; Chats is the default and stays out of the URL. */
const HOB_PAGE_TABS = ["chats", "history"] as const;
export type HobPageTab = (typeof HOB_PAGE_TABS)[number];

export const isHobPageTab = (value: unknown): value is HobPageTab =>
  typeof value === "string" && (HOB_PAGE_TABS as ReadonlyArray<string>).includes(value);

/** The badge variants a hob's state tag takes (the four status families of the design system). */
type StateTagVariant = "needs-you" | "working" | "resting" | "failed";

export interface StateTag {
  readonly variant: StateTagVariant;
  /** The family's glyph, so the tag reads without color. */
  readonly glyph: string;
  readonly word: string;
}

/** A hob's state as one tag: needs you, working, resting or failed, with its glyph and word. */
export const stateTag = (state: HobState): StateTag => {
  switch (state) {
    case "needs-you":
    case "waiting":
      return { variant: "needs-you", glyph: "!", word: copy.tags.needsYou };
    case "working":
    case "thinking":
      return { variant: "working", glyph: "●", word: copy.tags.working };
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

/**
 * What the hob is doing, for the bubble in its hero. Needing you comes first, then the chat it is
 * writing in or thinking about. A paused hob says so; a resting hob shows no bubble.
 */
export const doingOf = (
  state: HobState,
  threads: ReadonlyArray<Pick<Thread, "id" | "title">>,
  activity: Readonly<Record<string, "thinking" | "working">>,
): Doing | null => {
  if (state === "needs-you" || state === "waiting") return { kind: "needs-you", text: copy.doing.waiting };
  if (state === "paused") return { kind: "quiet", text: copy.doing.paused };
  const writing = threads.find((thread) => activity[thread.id] === "working");
  if (writing) return { kind: "live", text: copy.doing.writing({ title: writing.title }) };
  const thinking = threads.find((thread) => activity[thread.id] === "thinking");
  if (thinking) return { kind: "live", text: copy.doing.thinking({ title: thinking.title }) };
  return null;
};
