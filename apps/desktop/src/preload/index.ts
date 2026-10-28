import { contextBridge } from "electron";

const apiUrl = process.argv.find((arg) => arg.startsWith("--hobbots-api="))?.split("=")[1];

contextBridge.exposeInMainWorld("hobbots", {
  apiUrl: apiUrl ?? "http://127.0.0.1:4317",
});
