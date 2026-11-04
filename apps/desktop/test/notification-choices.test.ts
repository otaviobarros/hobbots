import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  handleNotificationIpc,
  notificationChannels,
  notificationChoices,
  notifyWhenOn,
} from "../src/main/notification-choices.ts";
import { fileSettingsStore } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-notifications-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("notification choices", () => {
  it("are all on by default and keep the other settings beside them", async () => {
    const file = join(temp, "settings.json");
    const settings = fileSettingsStore(file);
    expect(notificationChoices(settings)).toEqual({ requests: true, devices: true, finishes: true, sound: true });
    settings.update({ keepRunningInMenuBar: false });
    settings.update({ notifyDevices: false, notifyFinishes: false });
    await settings.saved();
    expect(notificationChoices(fileSettingsStore(file))).toEqual({
      requests: true,
      devices: false,
      finishes: false,
      sound: true,
    });
    expect(fileSettingsStore(file).read().keepRunningInMenuBar).toBe(false);
  });

  it("answers the bridge only from trusted pages, and saves only known switches", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const settings = fileSettingsStore(join(temp, "ipc.json"));
    handleNotificationIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
      settings,
      isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    });
    const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
    const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
    const set = handlers.get(notificationChannels.set);
    // An unknown key is dropped; a known one that is not a boolean refuses the whole call.
    await expect(set?.(trusted, { sound: false, openAtLogin: true })).resolves.toEqual({
      requests: true,
      devices: true,
      finishes: true,
      sound: false,
    });
    await expect(set?.(trusted, { devices: "no" })).resolves.toEqual({ refused: "malformed" });
    expect(settings.read()).toEqual({ notifySound: false });
    await expect(set?.(stranger, { requests: false })).resolves.toEqual({ refused: "notAllowed" });
    await expect(handlers.get(notificationChannels.get)?.(trusted)).resolves.toEqual({
      requests: true,
      devices: true,
      finishes: true,
      sound: false,
    });
  });

  it("shows a kind only while it is on, silent when the sound is off", () => {
    let choices = { requests: true, devices: false, finishes: true, sound: false };
    const show = vi.fn((_notice: { title: string; body: string; silent: boolean }) => ({ close: () => {} }));
    const requests = notifyWhenOn("requests", () => choices, show);
    const devices = notifyWhenOn("devices", () => choices, show);
    requests({ title: "Pip asks permission", body: "Run npm test" }, () => {});
    devices({ title: "A device asks to connect", body: "iPhone" }, () => {});
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toEqual({ title: "Pip asks permission", body: "Run npm test", silent: true });
    choices = { requests: false, devices: true, finishes: true, sound: true };
    requests({ title: "Pip asks permission", body: "Run npm test" }, () => {});
    devices({ title: "A device asks to connect", body: "iPhone" }, () => {});
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1]?.[0].silent).toBe(false);
  });
});
