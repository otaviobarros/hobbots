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
  it("are all on by default and keep the other settings beside them", () => {
    const file = join(temp, "settings.json");
    const settings = fileSettingsStore(file);
    expect(notificationChoices(settings)).toEqual({ requests: true, devices: true, sound: true });
    settings.update({ keepRunningInMenuBar: false });
    settings.update({ notifyDevices: false });
    expect(notificationChoices(fileSettingsStore(file))).toEqual({ requests: true, devices: false, sound: true });
    expect(fileSettingsStore(file).read().keepRunningInMenuBar).toBe(false);
  });

  it("answers the bridge only from trusted pages, and saves only known switches", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const settings = fileSettingsStore(join(temp, "ipc.json"));
    handleNotificationIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
      settings,
      isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    });
    const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
    const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
    expect(
      handlers.get(notificationChannels.set)?.(trusted, { sound: false, openAtLogin: true, devices: "no" }),
    ).toEqual({ requests: true, devices: true, sound: false });
    expect(settings.read()).toEqual({ notifySound: false });
    expect(() => handlers.get(notificationChannels.set)?.(stranger, { requests: false })).toThrow(
      "Not allowed from this page",
    );
    expect(handlers.get(notificationChannels.get)?.(trusted)).toEqual({ requests: true, devices: true, sound: false });
  });

  it("shows a kind only while it is on, silent when the sound is off", () => {
    let choices = { requests: true, devices: false, sound: false };
    const show = vi.fn((_notice: { title: string; body: string; silent: boolean }) => ({ close: () => {} }));
    const requests = notifyWhenOn("requests", () => choices, show);
    const devices = notifyWhenOn("devices", () => choices, show);
    requests({ title: "Pip asks permission", body: "Run npm test" }, () => {});
    devices({ title: "A device asks to connect", body: "iPhone" }, () => {});
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toEqual({ title: "Pip asks permission", body: "Run npm test", silent: true });
    choices = { requests: false, devices: true, sound: true };
    requests({ title: "Pip asks permission", body: "Run npm test" }, () => {});
    devices({ title: "A device asks to connect", body: "iPhone" }, () => {});
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1]?.[0].silent).toBe(false);
  });
});
