import { describe, expect, it } from "vitest";
import {
  closeAction,
  listNames,
  quitWhileWorkingDialog,
  renderTrayIcon,
  TRAY_SIZE,
  trayModel,
} from "../src/main/menu-bar-model.ts";
import { initialStatus, type ServerStatus } from "../src/main/server.ts";

const alphaAt = (pixels: Buffer, size: number, x: number, y: number) => pixels[(y * size + x) * 4 + 3];
const alphas = (pixels: Buffer) => new Set(pixels.filter((_, i) => i % 4 === 3));

describe("the menu-bar icon", () => {
  it("draws the chief in whole-pixel cells at 1× and 2×, black so macOS can tint it", () => {
    for (const scale of [1, 2] as const) {
      const pixels = renderTrayIcon("running", scale);
      expect(pixels.length).toBe((TRAY_SIZE * scale) ** 2 * 4);
      expect(pixels.filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true);
      expect(alphas(pixels)).toEqual(new Set([0, 255]));
    }
  });

  it("dims the chief while starting or stopped and adds a badge on error", () => {
    expect(alphas(renderTrayIcon("starting", 2))).toEqual(new Set([0, 115]));
    expect(alphas(renderTrayIcon("stopped", 1))).toEqual(new Set([0, 115]));
    const size = TRAY_SIZE * 2;
    const error = renderTrayIcon("error", 2);
    expect(alphaAt(error, size, size - 1, size - 1)).toBe(255);
    expect(alphaAt(error, size, size - 9, size - 9)).toBe(0);
    expect(alphaAt(renderTrayIcon("running", 2), size, size - 1, size - 1)).toBe(0);
  });
});

describe("the menu-bar menu", () => {
  const status = (patch: Partial<ServerStatus>): ServerStatus => ({ ...initialStatus, owned: true, ...patch });

  it("says what the server is doing, and offers a restart only when it is not running", () => {
    expect(trayModel(status({ state: "running" }), ["Aldric", "Aldric", "Pip"], 4317)).toEqual({
      tooltip: "Hobbots is running · 2 hobs working",
      title: "Hobbots is running",
      detail: "2 hobs working · localhost:4317",
      canRestart: false,
    });
    expect(trayModel(status({ state: "running" }), [], 4317).detail).toBe("No hobs working · localhost:4317");
    expect(trayModel(status({ state: "starting" }), [], 4317)).toMatchObject({ canRestart: false });
    expect(trayModel(status({ state: "stopped" }), [], 4317)).toMatchObject({
      title: "The server is stopped",
      canRestart: true,
    });
    expect(trayModel(status({ state: "error", problem: "Boom." }), [], 4317)).toMatchObject({
      title: "The server hit a problem",
      detail: "Boom.",
      canRestart: true,
    });
  });
});

describe("closing the window", () => {
  const base = { keepRunning: true, quitting: false, otherWindows: false, working: ["Aldric"] };

  it("keeps Hobbots running while the switch is on", () => {
    expect(closeAction(base)).toBe("close");
  });

  it("quits with the switch off, asking first only when hobs are working", () => {
    expect(closeAction({ ...base, keepRunning: false, working: [] })).toBe("quit");
    expect(closeAction({ ...base, keepRunning: false })).toBe("confirm");
    expect(closeAction({ ...base, keepRunning: false, quitting: true })).toBe("close");
    expect(closeAction({ ...base, keepRunning: false, otherWindows: true })).toBe("close");
  });

  it("asks first when the server cannot say whether hobs are working", () => {
    expect(closeAction({ ...base, keepRunning: false, working: null })).toBe("confirm");
    expect(quitWhileWorkingDialog(null)).toMatchObject({ message: "Quit Hobbots?", buttons: ["Quit", "Cancel"] });
  });

  it("names the hobs whose work will stop", () => {
    expect(listNames(["Aldric"])).toBe("Aldric");
    expect(listNames(["Aldric", "Pip", "Aldric", "Tinker"])).toBe("Aldric, Pip and Tinker");
    expect(quitWhileWorkingDialog(["Aldric", "Pip"])).toEqual({
      message: "Quit Hobbots while hobs are working?",
      detail: "Aldric and Pip will stop. Their unfinished work comes back as interrupted next time you open Hobbots.",
      buttons: ["Quit", "Cancel"],
    });
  });
});
