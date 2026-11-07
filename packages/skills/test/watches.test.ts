import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderWatches } from "../src/watches.ts";
import { folderOf, skillMd } from "./fixtures.ts";

// #1060: the watches on ~/.agents/skills (ADR 029).

describe("the watches on ~/.agents/skills", () => {
  // covers ADR 029 (The clean-runtime rule: ~/.agents/skills stays, through Hobbots), #1060
  it("[TC-AG-147] asks for one more read whenever a watch is new, the first ones included", async () => {
    const folder = await folderOf({ "release/SKILL.md": skillMd("release") });
    let reads = 0;
    const watches = folderWatches(folder, () => {
      reads += 1;
    });
    try {
      // The first read lists the folders before they are watched; a change in between is read next.
      await watches.rewatch(["", "release"]);
      expect(reads).toBe(1);

      // The same folders, still watched: nothing more to read.
      await watches.rewatch(["", "release"]);
      expect(reads).toBe(1);

      // A folder put in place of another is watched anew, and asks again.
      await mkdir(join(folder, "release-next"));
      await rm(join(folder, "release"), { recursive: true });
      await rename(join(folder, "release-next"), join(folder, "release"));
      const before = reads;
      await watches.rewatch(["", "release"]);
      expect(reads).toBeGreaterThan(before);
    } finally {
      watches.close();
    }
  });
});
