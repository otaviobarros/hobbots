import type { Locator } from "@playwright/test";

/** A hob's terminal in the Workbench's Terminal tab, named by its tab: the hob's name. */
export const hobTerminal = (panel: Locator, hob: string) =>
  panel.getByRole("tabpanel", { name: new RegExp(`^${hob}\\b`) });

/** The rows a terminal shows, as a screen reader reads them in xterm.js's screen reader mode. */
export const rows = (terminal: Locator) => terminal.getByRole("list");

/** The text a terminal shows in a color of its palette, `red` for ANSI red, as its renderer draws it. */
export const colored = (terminal: Locator, color: "red" | "green" | "yellow", text: string) =>
  terminal
    .locator(`.xterm-rows span.xterm-fg-${{ red: 1, green: 2, yellow: 3 }[color]}`)
    .filter({ hasText: text })
    .first();
