import { contextBridge, ipcRenderer } from "electron";
import { connectionChannels } from "../main/connection-ipc.ts";
import { backupDialogChannels, folderDialogChannel } from "../main/folder-dialog.ts";
import { keepRunningChannels } from "../main/keep-running.ts";
import { loginItemChannels } from "../main/login-item.ts";
import { CONNECTED_MODE_ARGUMENT, SETUP_MODE_ARGUMENT } from "../main/mode-argument.ts";
import { notificationChannels } from "../main/notification-choices.ts";
import { openRequestChannel, openTaskChannel } from "../main/open-request.ts";
import { setupChannels } from "../main/setup-ipc.ts";
import { showFileChannel } from "../main/show-file.ts";
import { showMemoryChannel } from "../main/show-memory.ts";
import { windowBackgroundChannel } from "../main/window-background.ts";
import { followTheme, type ThemedPage } from "./follow-theme.ts";

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

/** A Task in its lead's chat, as a notification names it (ADR 027). */
interface TaskLink {
  readonly hobId: string;
  readonly threadId: string;
  readonly taskId: string;
}

const isTaskLink = (value: unknown): value is TaskLink => {
  const link = value as Partial<Record<keyof TaskLink, unknown>> | null;
  return (
    typeof link === "object" &&
    link !== null &&
    typeof link.hobId === "string" &&
    typeof link.threadId === "string" &&
    typeof link.taskId === "string"
  );
};

// A Task whose notification was clicked, kept until the page listens, as a request is.
let waitingTask: TaskLink | undefined;
let taskListener: ((link: TaskLink) => void) | undefined;
ipcRenderer.on(openTaskChannel, (_event, link: unknown) => {
  if (!isTaskLink(link)) return;
  const { hobId, threadId, taskId } = link;
  if (taskListener) taskListener({ hobId, threadId, taskId });
  else waitingTask = { hobId, threadId, taskId };
});

/** Calls `listener` with each Task to open in its lead's chat; answers a function that stops it. */
const onOpenTask = (listener: (link: TaskLink) => void) => {
  taskListener = listener;
  if (waitingTask !== undefined) {
    const link = waitingTask;
    waitingTask = undefined;
    listener(link);
  }
  return () => {
    if (taskListener === listener) taskListener = undefined;
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
  onOpenTask,
};

/** Calls `listener` with each new view of the connection to the hub; answers a function that stops it. */
const onConnectionChange = (listener: (view: unknown) => void) => {
  const forward = (_event: unknown, view: unknown) => listener(view);
  ipcRenderer.on(connectionChannels.changed, forward);
  return () => void ipcRenderer.removeListener(connectionChannels.changed, forward);
};

/** The hub a connected desktop uses, what is wrong with the connection and what the user can do (ADR 025). */
const connection = {
  get: () => ipcRenderer.invoke(connectionChannels.get),
  retry: () => ipcRenderer.invoke(connectionChannels.retry),
  changeAddress: (address: string) => ipcRenderer.invoke(connectionChannels.changeAddress, address),
  openTailscale: () => ipcRenderer.invoke(connectionChannels.openTailscale),
  onChange: onConnectionChange,
  // Disconnect takes nothing from the page.
  disconnect: () => ipcRenderer.invoke(connectionChannels.disconnect),
};

/** Calls `listener` with what the waiting screen shows once the hub opened the request; answers a stop. */
const onWaiting = (listener: (waiting: unknown) => void) => {
  const forward = (_event: Electron.IpcRendererEvent, waiting: unknown) => listener(waiting);
  ipcRenderer.on(setupChannels.waiting, forward);
  return () => void ipcRenderer.off(setupChannels.waiting, forward);
};

/**
 * Setup's local pages, before this computer is anything for Hobbots (ADR 025), get only setup's own
 * calls: Run here, the hubs on the tailnet, Connect with the address typed, and Cancel.
 */
const setup = {
  runHere: () => ipcRenderer.invoke(setupChannels.runHere),
  findHubs: () => ipcRenderer.invoke(setupChannels.findHubs),
  connect: (address: string) => ipcRenderer.invoke(setupChannels.connect, address),
  cancel: () => ipcRenderer.invoke(setupChannels.cancel),
  onWaiting,
};

/** The bridge for this window's mode, which only the main process sets. */
const bridge = () => {
  if (process.argv.includes(SETUP_MODE_ARGUMENT)) return { setup };
  // A connected desktop's bridge is narrower (ADR 025): a hob's folders and files are the hub's, so
  // nothing here reaches this computer's files; the pages fall back to typing a path, as in a browser.
  if (process.argv.includes(CONNECTED_MODE_ARGUMENT)) {
    return { ...shared, connection };
  }
  return {
    ...shared,
    // Opens the system folder picker; it takes nothing from the page and answers a path or null.
    chooseFolder: () => ipcRenderer.invoke(folderDialogChannel),
    // The same picker for a backup: where to save one, or which one to restore.
    chooseBackupFolder: (purpose: "save" | "restore") =>
      ipcRenderer.invoke(purpose === "restore" ? backupDialogChannels.restore : backupDialogChannels.save),
    // Shows a Task's file in Finder: the page names it only by ids, and the hub says where it is.
    showFile: (attemptId: string, fileId: string) => ipcRenderer.invoke(showFileChannel, attemptId, fileId),
    // Opens the memory engine's pages in Finder; it takes nothing from the page.
    showMemoryFiles: () => ipcRenderer.invoke(showMemoryChannel),
  };
};

contextBridge.exposeInMainWorld("hobbots", bridge());

// The window behind the page follows the theme. Setup's pages always use Workshop Night, which the
// window opens with, so they report nothing.
if (!process.argv.includes(SETUP_MODE_ARGUMENT) && "document" in globalThis) {
  followTheme(
    globalThis as unknown as ThemedPage,
    // A window that cannot take it keeps the background it opened with.
    (ground) => void ipcRenderer.invoke(windowBackgroundChannel, ground).catch(() => undefined),
  );
}
