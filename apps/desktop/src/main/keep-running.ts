import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { SettingsStore } from "./settings.ts";

/** Whether closing the last window keeps Hobbots running in the menu bar; on until the user turns it off. */
export const keepsRunning = (settings: SettingsStore) => settings.read().keepRunningInMenuBar ?? true;

/** Channels the preload bridge calls; each answers with the current choice. */
export const keepRunningChannels = {
  get: "hobbots:keep-running:get",
  set: "hobbots:keep-running:set",
} as const;

/** Answers the bridge's calls, only from pages the window is allowed to show. */
export const handleKeepRunningIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly settings: SettingsStore;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
}) => {
  const { ipcMain, settings, isTrusted } = options;
  const guarded =
    <A extends unknown[]>(f: (...args: A) => boolean) =>
    (event: IpcMainInvokeEvent, ...args: A) => {
      if (!isTrusted(event)) throw new Error("Not allowed from this page");
      return f(...args);
    };
  ipcMain.handle(
    keepRunningChannels.get,
    guarded(() => keepsRunning(settings)),
  );
  ipcMain.handle(
    keepRunningChannels.set,
    guarded((on: unknown) => {
      settings.update({ keepRunningInMenuBar: on === true });
      return keepsRunning(settings);
    }),
  );
};
