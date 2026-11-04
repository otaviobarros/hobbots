import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileSettingsStore } from "../src/main/settings.ts";

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
});
