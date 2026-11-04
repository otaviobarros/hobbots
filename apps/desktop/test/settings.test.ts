import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileSettingsStore, saveBeforeQuit } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-settings-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the desktop settings file", () => {
  it("is read once, answers from memory, and saves each update in order without blocking", async () => {
    const file = join(temp, "nested", "settings.json");
    const settings = fileSettingsStore(file);
    expect(settings.update({ keepRunningInMenuBar: false })).toEqual({ keepRunningInMenuBar: false });
    settings.update({ notifySound: false, windowBackground: "#f7f4ef" });
    settings.update({ windowBackground: undefined });
    // Read at once, before any save landed.
    expect(settings.read()).toEqual({ keepRunningInMenuBar: false, notifySound: false });
    await settings.saved();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ keepRunningInMenuBar: false, notifySound: false });

    // A change made to the file by anyone else is not read again: the app is its only writer.
    writeFileSync(file, JSON.stringify({ notifySound: true }));
    expect(settings.read().notifySound).toBe(false);
    expect(fileSettingsStore(file).read()).toEqual({ notifySound: true });
  });

  it("says when the latest save failed, and is saved again once a later save works", async () => {
    let full = true;
    const written: string[] = [];
    const settings = fileSettingsStore(join(temp, "failing.json"), async (_file, saved) => {
      if (full) throw new Error("ENOSPC: no space left on device");
      written.push(JSON.stringify(saved));
    });
    settings.update({ notifySound: false });
    await expect(settings.saved()).rejects.toThrow("ENOSPC");
    full = false;
    settings.update({ notifyDevices: false });
    await expect(settings.saved()).resolves.toBeUndefined();
    expect(written).toEqual([JSON.stringify({ notifySound: false, notifyDevices: false })]);
  });
});

describe("quitting with unsaved settings", () => {
  const failingThen = (failures: number) => {
    let left = failures;
    return fileSettingsStore(join(temp, `quit-${failures}.json`), async () => {
      if (left-- > 0) throw new Error("EACCES");
    });
  };

  it("asks, saves again on Try again, and quits once the save works", async () => {
    const settings = failingThen(1);
    settings.update({ notifySound: false });
    const asked: string[] = [];
    await saveBeforeQuit(settings, async (prompt) => {
      asked.push(prompt.message);
      return 0;
    });
    expect(asked).toHaveLength(1);
    await expect(settings.saved()).resolves.toBeUndefined();
  });

  it("quits without the last change when the user chooses Quit anyway", async () => {
    const settings = failingThen(5);
    settings.update({ notifySound: false });
    let asked = 0;
    await saveBeforeQuit(settings, async () => {
      asked++;
      return 1;
    });
    expect(asked).toBe(1);
  });
});
