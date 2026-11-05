import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTED_MODE_ARGUMENT, SETUP_MODE_ARGUMENT } from "../src/main/mode-argument.ts";

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
    const shared = ["keepRunning", "loginItem", "notifications", "onOpenRequest", "onOpenTask"];
    expect(await bridgeWith([CONNECTED_MODE_ARGUMENT])).toEqual([...shared, "connection"].sort());
    // The hub it uses, what is wrong with the connection and what can be done, and Disconnect;
    // none of them reaches this computer's files.
    expect(Object.keys(exposed.bridge?.connection as object).sort()).toEqual([
      "changeAddress",
      "disconnect",
      "get",
      "onChange",
      "openTailscale",
      "retry",
    ]);
    // On the hub, the folder pickers, the backup folder picker included, and Show in Finder stay.
    expect(await bridgeWith([])).toEqual(
      [...shared, "chooseBackupFolder", "chooseFolder", "showFile", "showMemoryFiles"].sort(),
    );
  });

  // covers DP-001, PE-006
  it("[TC-DP-203] offers setup's local pages only setup's own calls, and none of the hub's", async () => {
    expect(await bridgeWith([SETUP_MODE_ARGUMENT])).toEqual(["setup"]);
    const setup = exposed.bridge?.setup as Record<string, unknown>;
    expect(Object.keys(setup).sort()).toEqual(["cancel", "connect", "findHubs", "onWaiting", "runHere"]);
  });
});
