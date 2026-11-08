import { formatList } from "../../lib/format.ts";

/** User-facing copy for the card asking whether a hob will write code, and its setting (STD-I18N-001). */
export const messages = {
  setUp: "Set up GitHub",
  setting: {
    name: "Coding setup card",
    asks: "Hobbots asks once per hob, the first time it can work in a folder, whether it will write code.",
    allHobs: "You turned it off for every hob.",
    someHobs: ({ names }: { names: ReadonlyArray<string> }) => `You turned it off for ${formatList(names)}.`,
    showAgain: "Show it again",
    failed: "Hobbots could not read this setting. Try again in a moment.",
    clearFailed: "Hobbots could not change this setting. Try again.",
    unknownHob: "a hob you removed",
  },
} as const;
