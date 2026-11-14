import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHubDataFolder } from "../src/command-line.ts";

// Issue #1454: the member-reads dry run migrates the folder it is given, so it must never take the
// hub's own data folder, wherever HOBBOTS_DATA_DIR sets it, for a copy.

describe("the hub's own data folder", () => {
  // covers ADR 039 (Members: migration with a dry run)
  it("[TC-OP-1454-01] is the configured folder or the default, by any spelling of its path, and a copy is not", () => {
    const root = mkdtempSync(join(tmpdir(), "hub-folders-"));
    const configured = join(root, "configured");
    const fallback = join(root, "default");
    const copy = join(root, "copy");
    for (const folder of [configured, fallback, copy]) mkdirSync(folder);
    symlinkSync(configured, join(root, "link"));
    const hub = [configured, fallback];

    expect(isHubDataFolder(configured, hub)).toBe(true);
    expect(isHubDataFolder(join(root, "copy", "..", "configured"), hub)).toBe(true);
    expect(isHubDataFolder(join(root, "link"), hub)).toBe(true);
    expect(isHubDataFolder(fallback, hub)).toBe(true);
    expect(isHubDataFolder(copy, hub)).toBe(false);
    // A default folder that does not exist yet still compares by its path.
    expect(isHubDataFolder(join(root, "missing"), [join(root, "missing")])).toBe(true);
  });
});
