import { contextBridge, ipcRenderer } from "electron";
import { folderDialogChannel } from "../main/folder-dialog.ts";
import { keepRunningChannels } from "../main/keep-running.ts";
import { loginItemChannels } from "../main/login-item.ts";
import { showWindowChannel } from "../main/show-window.ts";

const apiUrl = process.argv.find((arg) => arg.startsWith("--hobbots-api="))?.split("=")[1];

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
  // Brings this window forward, as clicking a request's notification does; it takes nothing from the page.
  showWindow: () => ipcRenderer.invoke(showWindowChannel),
});
