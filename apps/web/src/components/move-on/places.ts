import { type FocusTargets, firstControl } from "./follow-focus.ts";

/** Marks a card that waits on you, such as an open question, so the next one can take focus. */
export const WAITS = { "data-waits": "" } as const;

/** The first card in `scope` that still waits on you, other than the one a decision was made in. */
export const nextWaiting = (scope: Element | null, from: HTMLElement): HTMLElement | null =>
  firstControl([...(scope?.querySelectorAll("[data-waits]") ?? [])].find((card) => !card.contains(from)));

/** The box of the chat's composer in `scope`, while you can type in it. */
export const composerIn = (scope: Element | null): HTMLElement | null =>
  scope?.querySelector<HTMLElement>("[data-composer] textarea:not(:disabled)") ?? null;

/**
 * Where focus goes after you answer a question in the chat (#995): the chat's next question that
 * waits on you, or else its composer.
 */
export const chatTargets: FocusTargets = (from) => {
  const chat = from.closest("main");
  return { next: () => nextWaiting(chat, from), fallback: () => composerIn(chat) };
};
