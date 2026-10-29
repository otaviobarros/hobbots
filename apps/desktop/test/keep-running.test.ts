import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterAll, describe, expect, it } from "vitest";
import { handleKeepRunningIpc, keepRunningChannels, keepsRunning } from "../src/main/keep-running.ts";
import { fileSettingsStore } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-keep-running-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("keep running in the menu bar", () => {
  // covers EX-005
  it("is on by default and keeps the login-item choice beside it", () => {
    const file = join(temp, "settings.json");
    const settings = fileSettingsStore(file);
    expect(keepsRunning(settings)).toBe(true);
    settings.update({ openAtLogin: false });
    settings.update({ keepRunningInMenuBar: false });
    expect(keepsRunning(fileSettingsStore(file))).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ openAtLogin: false, keepRunningInMenuBar: false });
  });

  it("answers the bridge only from trusted pages", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const settings = fileSettingsStore(join(temp, "ipc.json"));
    handleKeepRunningIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
      settings,
      isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    });
    const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
    const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
    expect(handlers.get(keepRunningChannels.set)?.(trusted, false)).toBe(false);
    expect(handlers.get(keepRunningChannels.get)?.(trusted)).toBe(false);
    expect(() => handlers.get(keepRunningChannels.set)?.(stranger, true)).toThrow("Not allowed from this page");
    expect(keepsRunning(settings)).toBe(false);
  });
});
