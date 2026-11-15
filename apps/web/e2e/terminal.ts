import type { Locator } from "@playwright/test";

/** A hob's terminal in the Workbench's Terminal tab, named by its tab: the hob's name. */
export const hobTerminal = (panel: Locator, hob: string) =>
  panel.getByRole("tabpanel", { name: new RegExp(`^${hob}\\b`) });

/** The rows a terminal shows, as a screen reader reads them in xterm.js's screen reader mode. */
export const rows = (terminal: Locator) => terminal.getByRole("list");
