import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTED_MODE_ARGUMENT } from "../src/main/mode-argument.ts";

// What the preload script offers the window's pages (ADR 025), with Electron's bridge recorded.

const exposed = vi.hoisted(() => ({ bridge: undefined as Record<string, unknown> | undefined }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.bridge = api;
    },
  },
  ipcRenderer: { on: () => {}, invoke: async () => null },
}));

const bridgeWith = async (argv: ReadonlyArray<string>) => {
  vi.resetModules();
  const saved = process.argv;
  process.argv = [...saved, ...argv];
  try {
    await import("../src/preload/index.ts");
  } finally {
    process.argv = saved;
  }
  return Object.keys(exposed.bridge ?? {}).sort();
};

afterEach(() => {
  exposed.bridge = undefined;
});

describe("the preload bridge", () => {
  // covers DP-001, PE-006
  it("[TC-DP-160] offers a connected desktop no folder picker and nothing that reaches this computer's files", async () => {
    const shared = ["keepRunning", "loginItem", "notifications", "onOpenRequest"];
    expect(await bridgeWith([CONNECTED_MODE_ARGUMENT])).toEqual([...shared, "connection"].sort());
    // The hub it uses, and Disconnect, which takes nothing from the page.
    expect(Object.keys(exposed.bridge?.connection as object).sort()).toEqual(["disconnect", "get"]);
    // On the hub, the folder pickers, the backup folder picker included, and Show in Finder stay.
    expect(await bridgeWith([])).toEqual([...shared, "chooseBackupFolder", "chooseFolder", "showFile"].sort());
  });
});
