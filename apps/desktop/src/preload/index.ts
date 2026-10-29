import { contextBridge, ipcRenderer } from "electron";
import { loginItemChannels } from "../main/login-item.ts";

const apiUrl = process.argv.find((arg) => arg.startsWith("--hobbots-api="))?.split("=")[1];

contextBridge.exposeInMainWorld("hobbots", {
  apiUrl: apiUrl ?? "http://127.0.0.1:4317",
  loginItem: {
    get: () => ipcRenderer.invoke(loginItemChannels.get),
    set: (openAtLogin: boolean) => ipcRenderer.invoke(loginItemChannels.set, openAtLogin),
    openSystemSettings: () => ipcRenderer.invoke(loginItemChannels.openSystemSettings),
  },
});
