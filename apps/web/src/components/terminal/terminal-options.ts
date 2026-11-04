import type { ISearchOptions } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";

/** How many matches the last search found, and which one is picked: -1 past the highlight limit. */
export interface SearchResult {
  readonly resultIndex: number;
  readonly resultCount: number;
}

/** Each xterm.js theme color and the `--color-term-*` token it reads (#908). */
export const THEME_TOKENS = {
  background: "ground",
  foreground: "text",
  cursor: "ground",
  cursorAccent: "ground",
  selectionBackground: "selection",
  selectionInactiveBackground: "selection",
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  brightBlack: "bright-black",
  brightRed: "bright-red",
  brightGreen: "bright-green",
  brightYellow: "bright-yellow",
  brightBlue: "bright-blue",
  brightMagenta: "bright-magenta",
  brightCyan: "bright-cyan",
  brightWhite: "bright-white",
} as const satisfies Partial<Record<keyof ITheme, string>>;

const token = (element: HTMLElement | null, name: string) =>
  element === null ? "" : getComputedStyle(element).getPropertyValue(`--color-term-${name}`).trim();

/** How a search marks its matches: every one on the selection fill, the picked one ringed in focus. */
export const searchDecorations = (element: HTMLElement | null): NonNullable<ISearchOptions["decorations"]> => ({
  matchBackground: token(element, "selection"),
  matchOverviewRuler: token(element, "dim"),
  activeMatchBackground: token(element, "selection"),
  activeMatchBorder: token(element, "focus"),
  activeMatchColorOverviewRuler: token(element, "focus"),
});
