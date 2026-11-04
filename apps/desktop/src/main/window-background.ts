import { Schema } from "effect";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { SettingsStore } from "./settings.ts";
import { handleTrusted, type SettingsIpcOptions, withArgs } from "./trusted-ipc.ts";

/**
 * The window's own background, which shows before the page paints and while it resizes. It follows
 * the theme's `ground`: the page reports it each time the theme changes, and the next window opens
 * with the last one. First run always uses Workshop Night, so that is its ground until a page reports.
 */
export const FIRST_RUN_GROUND = "#141228";

/** The channel the preload script reports the page's ground on. */
export const windowBackgroundChannel = "hobbots:window-background:set";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The background a new window opens with: the last ground a page reported, or first run's. */
export const windowBackground = (settings: SettingsStore) => settings.read().windowBackground ?? FIRST_RUN_GROUND;

/**
 * Sets the sending window's background to the ground its page reports, and keeps it for the next
 * window. Only pages the window may show are heard, and only a plain hex color is taken.
 */
export const handleWindowBackgroundIpc = (
  options: SettingsIpcOptions & {
    readonly windowOf: (event: IpcMainInvokeEvent) => Pick<BrowserWindow, "setBackgroundColor"> | null;
  },
) =>
  handleTrusted(options, {
    [windowBackgroundChannel]: withArgs(
      Schema.Tuple([Schema.String.check(Schema.isPattern(HEX_COLOR))]),
      ([color], event) => {
        options.windowOf(event)?.setBackgroundColor(color);
        if (options.settings.read().windowBackground !== color) options.settings.update({ windowBackground: color });
      },
    ),
  });
