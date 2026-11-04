import type { BrowserWindow } from "electron";
import type { TaskLink } from "./request-notices-model.ts";

/** The channel the main process uses to show a request in the window's Inbox. */
export const openRequestChannel = "hobbots:inbox:open-request";

/** Shows the request in the window's Inbox, as clicking its notification does. */
export const openRequestIn = (window: Pick<BrowserWindow, "webContents">, requestId: string) =>
  window.webContents.send(openRequestChannel, requestId);

/** The channel the main process uses to open a Task in its lead's chat (ADR 027). */
export const openTaskChannel = "hobbots:quest:open-task";

/** Opens the Task in its lead's chat, so the room opens with its lane lit, as clicking its notification does. */
export const openTaskIn = (window: Pick<BrowserWindow, "webContents">, link: TaskLink) =>
  window.webContents.send(openTaskChannel, link);
