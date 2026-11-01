import type { BrowserWindow } from "electron";

/** The channel the main process uses to show a request in the window's Inbox. */
export const openRequestChannel = "hobbots:inbox:open-request";

/** Shows the request in the window's Inbox, as clicking its notification does. */
export const openRequestIn = (window: Pick<BrowserWindow, "webContents">, requestId: string) =>
  window.webContents.send(openRequestChannel, requestId);
