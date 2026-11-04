import { Schema } from "effect";
import type { SettingsStore } from "./settings.ts";
import { handleTrusted, noArgs, type SettingsIpcOptions, withArgs } from "./trusted-ipc.ts";

/** Whether closing the last window keeps Hobbots running in the menu bar; on until the user turns it off. */
export const keepsRunning = (settings: SettingsStore) => settings.read().keepRunningInMenuBar ?? true;

/** Channels the preload bridge calls; each answers with the current choice. */
export const keepRunningChannels = {
  get: "hobbots:keep-running:get",
  set: "hobbots:keep-running:set",
} as const;

/** Answers the bridge's calls, only from pages the window is allowed to show. */
export const handleKeepRunningIpc = (options: SettingsIpcOptions) =>
  handleTrusted(options, {
    [keepRunningChannels.get]: noArgs(() => keepsRunning(options.settings)),
    [keepRunningChannels.set]: withArgs(Schema.Tuple([Schema.Boolean]), async ([on]) => {
      options.settings.update({ keepRunningInMenuBar: on });
      await options.settings.saved();
      return keepsRunning(options.settings);
    }),
  });
