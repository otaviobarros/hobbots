import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dropCachedClientOnUpdate } from "../src/main/client-cache.ts";
import { fileSettingsStore } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-client-cache-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the cached web client after an update", () => {
  // covers DP-001
  it("[TC-DP-275] is dropped once when the app version changes, before a window loads", async () => {
    // Settings written by a version that did not record its own, such as 0.0.1.
    const file = join(temp, "settings.json");
    writeFileSync(file, JSON.stringify({ mode: "hub" }));
    const clearCache = vi.fn(async () => undefined);

    const first = fileSettingsStore(file);
    await dropCachedClientOnUpdate("0.0.2", first, clearCache);
    expect(clearCache).toHaveBeenCalledTimes(1);
    await first.saved();

    // The next launch of the same version keeps the cache.
    const settings = fileSettingsStore(file);
    expect(settings.read()).toEqual({ mode: "hub", appVersion: "0.0.2" });
    await dropCachedClientOnUpdate("0.0.2", settings, clearCache);
    expect(clearCache).toHaveBeenCalledTimes(1);

    await dropCachedClientOnUpdate("0.0.3", settings, clearCache);
    expect(clearCache).toHaveBeenCalledTimes(2);
    expect(settings.read().appVersion).toBe("0.0.3");
  });

  it("tries again on the next launch when the cache could not be cleared", async () => {
    const settings = fileSettingsStore(join(temp, "failing.json"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await dropCachedClientOnUpdate("0.0.2", settings, async () => {
      throw new Error("cache busy");
    });
    expect(error).toHaveBeenCalledOnce();
    expect(settings.read().appVersion).toBeUndefined();
    error.mockRestore();
  });
});
