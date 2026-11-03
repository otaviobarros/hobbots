import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { SettingsStore } from "./settings.ts";

/** What a bridge for a desktop setting needs: where to answer, the saved settings, and who may ask. */
export interface SettingsIpcOptions {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly settings: SettingsStore;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
}

/** Answers each channel with its handler, only from pages the window is allowed to show. */
export const handleTrusted = (
  { ipcMain, isTrusted }: Pick<SettingsIpcOptions, "ipcMain" | "isTrusted">,
  handlers: Readonly<Record<string, (arg: unknown) => unknown>>,
) => {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, arg: unknown) => {
      if (!isTrusted(event)) throw new Error("Not allowed from this page");
      return handler(arg);
    });
  }
};
