import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterAll, describe, expect, it } from "vitest";
import { fileSettingsStore } from "../src/main/settings.ts";
import {
  FIRST_RUN_GROUND,
  handleWindowBackgroundIpc,
  windowBackground,
  windowBackgroundChannel,
} from "../src/main/window-background.ts";
import { followTheme, type ThemedPage } from "../src/preload/follow-theme.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-window-background-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the window background", () => {
  it("follows the ground the page reports, and the next window opens with it", async () => {
    const file = join(temp, "settings.json");
    const settings = fileSettingsStore(file);
    expect(windowBackground(settings)).toBe(FIRST_RUN_GROUND);

    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const painted: string[] = [];
    handleWindowBackgroundIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
      settings,
      isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
      windowOf: () => ({ setBackgroundColor: (color) => void painted.push(color) }),
    });
    const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
    const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
    const handler = handlers.get(windowBackgroundChannel);

    await handler?.(trusted, "#f7f4ef");
    await settings.saved();
    expect(painted).toEqual(["#f7f4ef"]);
    expect(windowBackground(fileSettingsStore(file))).toBe("#f7f4ef");

    // Anything but a plain hex color is ignored, and other pages are refused.
    await expect(handler?.(trusted, "red; background: url(x)")).resolves.toEqual({ refused: "malformed" });
    await expect(handler?.(stranger, "#000000")).resolves.toEqual({ refused: "notAllowed" });
    expect(painted).toEqual(["#f7f4ef"]);
    expect(windowBackground(fileSettingsStore(file))).toBe("#f7f4ef");
  });

  it("hears the page's ground when it loads and when its theme changes", () => {
    let ground = "#141228";
    let loaded = () => {};
    let themeChanged = () => {};
    const page: ThemedPage = {
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: (name) => (name === "--color-ground" ? ` ${ground}` : "") }),
      MutationObserver: class {
        constructor(callback: () => void) {
          themeChanged = callback;
        }
        observe() {}
      },
      addEventListener: (_type, listener) => {
        loaded = listener;
      },
    };
    const reported: string[] = [];
    followTheme(page, (color) => reported.push(color));
    expect(reported).toEqual([]);
    loaded();
    ground = "#f7f4ef";
    themeChanged();
    themeChanged();
    expect(reported).toEqual(["#141228", "#f7f4ef"]);
  });
});
