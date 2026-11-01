import { contextBridge, ipcRenderer } from "electron";
import { folderDialogChannel } from "../main/folder-dialog.ts";
import { keepRunningChannels } from "../main/keep-running.ts";
import { loginItemChannels } from "../main/login-item.ts";
import { openRequestChannel } from "../main/open-request.ts";

const apiUrl = process.argv.find((arg) => arg.startsWith("--hobbots-api="))?.split("=")[1];

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

contextBridge.exposeInMainWorld("hobbots", {
  apiUrl: apiUrl ?? "http://127.0.0.1:4317",
  loginItem: {
    get: () => ipcRenderer.invoke(loginItemChannels.get),
    set: (openAtLogin: boolean) => ipcRenderer.invoke(loginItemChannels.set, openAtLogin),
    openSystemSettings: () => ipcRenderer.invoke(loginItemChannels.openSystemSettings),
  },
  keepRunning: {
    get: () => ipcRenderer.invoke(keepRunningChannels.get),
    set: (on: boolean) => ipcRenderer.invoke(keepRunningChannels.set, on),
  },
  // Opens the system folder picker; it takes nothing from the page and answers a path or null.
  chooseFolder: () => ipcRenderer.invoke(folderDialogChannel),
  onOpenRequest,
});
