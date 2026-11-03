import { contextBridge, ipcRenderer } from "electron";
import { connectionChannels } from "../main/connection-ipc.ts";
import { folderDialogChannel } from "../main/folder-dialog.ts";
import { keepRunningChannels } from "../main/keep-running.ts";
import { loginItemChannels } from "../main/login-item.ts";
import { CONNECTED_MODE_ARGUMENT } from "../main/mode-argument.ts";
import { notificationChannels } from "../main/notification-choices.ts";
import { openRequestChannel } from "../main/open-request.ts";
import { showFileChannel } from "../main/show-file.ts";

// A request whose notification was clicked, kept until the page listens: a window opened by the
// click loads before the Inbox can show it.
let waitingRequest: string | undefined;
let openListener: ((requestId: string) => void) | undefined;
ipcRenderer.on(openRequestChannel, (_event, requestId: unknown) => {
  if (typeof requestId !== "string") return;
  if (openListener) openListener(requestId);
  else waitingRequest = requestId;
});

/** Calls `listener` with each request to show in the Inbox; answers a function that stops it. */
const onOpenRequest = (listener: (requestId: string) => void) => {
  openListener = listener;
  if (waitingRequest !== undefined) {
    const requestId = waitingRequest;
    waitingRequest = undefined;
    listener(requestId);
  }
  return () => {
    if (openListener === listener) openListener = undefined;
  };
};

/** What the bridge offers on every computer: this app's own settings and opening a request. */
const shared = {
  loginItem: {
    get: () => ipcRenderer.invoke(loginItemChannels.get),
    set: (openAtLogin: boolean) => ipcRenderer.invoke(loginItemChannels.set, openAtLogin),
    openSystemSettings: () => ipcRenderer.invoke(loginItemChannels.openSystemSettings),
  },
  keepRunning: {
    get: () => ipcRenderer.invoke(keepRunningChannels.get),
    set: (on: boolean) => ipcRenderer.invoke(keepRunningChannels.set, on),
  },
  notifications: {
    get: () => ipcRenderer.invoke(notificationChannels.get),
    set: (patch: Record<string, boolean>) => ipcRenderer.invoke(notificationChannels.set, patch),
  },
  onOpenRequest,
};

// A connected desktop's bridge is narrower (ADR 025): a hob's folders and files are the hub's, so
// nothing here reaches this computer's files; the pages fall back to typing a path, as in a browser.
const connected = process.argv.includes(CONNECTED_MODE_ARGUMENT);

contextBridge.exposeInMainWorld(
  "hobbots",
  connected
    ? { ...shared, connection: { get: () => ipcRenderer.invoke(connectionChannels.get) } }
    : {
        ...shared,
        // Opens the system folder picker; it takes nothing from the page and answers a path or null.
        chooseFolder: () => ipcRenderer.invoke(folderDialogChannel),
        // Shows a Task's file in Finder: the page names it only by ids, and the hub says where it is.
        showFile: (attemptId: string, fileId: string) => ipcRenderer.invoke(showFileChannel, attemptId, fileId),
      },
);
