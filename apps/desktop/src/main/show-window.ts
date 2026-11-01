import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

/** The channel the preload bridge calls to bring its window forward, as a notification click does. */
export const showWindowChannel = "hobbots:window:show";

/**
 * Brings the calling window forward, restoring it when minimized. The call takes no arguments,
 * answers only pages the window is allowed to show, and only ever moves the window that asked.
 */
export const handleShowWindowIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly windowOf: (
    event: IpcMainInvokeEvent,
  ) => Pick<BrowserWindow, "isMinimized" | "restore" | "show" | "focus"> | null;
}) => {
  const { ipcMain, isTrusted, windowOf } = options;
  ipcMain.handle(showWindowChannel, (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Not allowed from this page");
    const window = windowOf(event);
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
};
