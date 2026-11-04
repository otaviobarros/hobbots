import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { disconnectFromHub } from "../src/main/disconnect.ts";
import { fileSettingsStore } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-disconnect-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const connection = {
  address: "http://studio.example.ts.net:4317",
  name: "Studio",
  nodeId: "nSTUDIO",
  nodeName: "studio.example.ts.net",
  deviceId: "dev1",
};

describe("Disconnect", () => {
  it("fails when the settings could not be saved, so the app never starts again still connected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const settings = fileSettingsStore(join(temp, "settings.json"), async () => {
      throw new Error("ENOSPC: no space left on device");
    });
    const outcome = disconnectFromHub({
      connection,
      state: () => ({ state: "revoked" }),
      hub: { fetchAsDevice: async () => new Response(null, { status: 200 }) },
      token: { read: async () => "hbd_token", remove: async () => {} },
      clearCookies: async () => {},
      settings,
    });
    await expect(outcome).rejects.toThrow("ENOSPC");
    vi.restoreAllMocks();
  });
});
