import { describe, expect, it } from "vitest";
import {
  closeAction,
  connectedTrayModel,
  listNames,
  pauseItem,
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

describe("Pause remote access in the menu", () => {
  it("offers Pause while remote access is on, Resume while paused, and nothing while it is off or the server is not running", () => {
    expect(pauseItem("running", { enabled: true, paused: false })).toMatchObject({
      label: "Pause remote access",
      pause: true,
    });
    expect(pauseItem("running", { enabled: true, paused: true })).toMatchObject({
      label: "Resume remote access",
      pause: false,
    });
    expect(pauseItem("running", { enabled: false, paused: true })).toBeNull();
    expect(pauseItem("running", null)).toBeNull();
    expect(pauseItem("stopped", { enabled: true, paused: false })).toBeNull();
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

describe("the menu-bar icon on a connected desktop", () => {
  const hub = { nodeName: "studio.example.ts.net", address: "http://studio.example.ts.net:4317" };

  it("names the hub by its computer and says which side to update", () => {
    expect(connectedTrayModel({ state: "connected", version: "0.5.0" }, hub)).toEqual({
      icon: "running",
      title: "Connected to studio",
      detail: hub.address,
      actions: [],
    });
    expect(connectedTrayModel({ state: "unsupported", side: "hubOlder", version: "0.3.0" }, hub)).toMatchObject({
      icon: "error",
      title: "studio runs an older Hobbots (0.3.0).",
      detail: "Update Hobbots on studio to connect.",
    });
    expect(connectedTrayModel({ state: "unsupported", side: "appOlder", version: "9.0.0" }, hub).detail).toBe(
      "Update Hobbots on this Mac.",
    );
    expect(connectedTrayModel({ state: "otherNode" }, hub).title).toBe(`${hub.address} is now a different computer.`);
    expect(connectedTrayModel({ state: "revoked" }, hub).title).toBe("This Mac was removed from studio.");
    expect(connectedTrayModel({ state: "unreachable" }, hub).icon).toBe("stopped");
  });

  // covers DP-001
  it("[TC-DP-169] gives each reason the hub cannot be reached its own words and what the user can do", () => {
    const hub = { nodeName: "studio.example.ts.net", address: "http://studio.example.ts.net:4317" };
    const model = (state: Parameters<typeof connectedTrayModel>[0]) => {
      const { title, detail, actions } = connectedTrayModel(state, hub);
      return { title, detail, actions };
    };
    expect(model({ state: "tailscaleOff" })).toEqual({
      title: "Tailscale is off on this Mac.",
      detail: "Open Tailscale and turn it on. Hobbots reconnects by itself.",
      actions: ["openTailscale", "tryAgain"],
    });
    expect(model({ state: "hubOffline" })).toEqual({
      title: "studio is offline.",
      detail: "It may be asleep, shut down, or off Tailscale. Hobbots tries again.",
      actions: ["tryAgain"],
    });
    expect(model({ state: "unreachable" })).toEqual({
      title: "Hobbots on studio isn't answering.",
      detail: "It may be closed, remote access may be paused or off, or its port changed. Hobbots tries again.",
      actions: ["tryAgain", "changeAddress"],
    });
    expect(model({ state: "otherNode" }).actions).toEqual(["changeAddress", "disconnect"]);
    expect(model({ state: "notHobbots" })).toEqual({
      title: `Something other than Hobbots answers at ${hub.address}.`,
      detail: hub.address,
      actions: ["changeAddress"],
    });
    for (const state of ["revoked", "unknownDevice"] as const) {
      expect(model({ state })).toMatchObject({
        detail: "Ask studio again, or disconnect.",
        actions: ["askAgain", "disconnect"],
      });
    }
    expect(model({ state: "unknownDevice" }).title).toBe("studio no longer knows this Mac.");
  });
});
