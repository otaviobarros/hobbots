import { spawn } from "node:child_process";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderTree } from "../src/sources/folder.ts";
import { folderOf, skillMd } from "./fixtures.ts";

// #1060: a folder is read as it was listed, never through a link put in place since (ADR 029, Import).

const listed = () => folderOf({ "SKILL.md": skillMd("release"), "notes/steps.md": "Tag, then push." });
const outside = () => folderOf({ "steps.md": "secret", "SKILL.md": "secret" });

describe("folder source", () => {
  // covers ADR 029 (Import: no links, nothing outside the skill), #1060
  it("[TC-AG-137] refuses a file swapped for a link, or for another file, after the listing", async () => {
    const root = await listed();
    const elsewhere = await outside();
    const tree = await folderTree(root);
    expect(new TextDecoder().decode(await tree.read("notes/steps.md"))).toBe("Tag, then push.");

    await rm(join(root, "SKILL.md"));
    await symlink(join(elsewhere, "SKILL.md"), join(root, "SKILL.md"));
    await expect(tree.read("SKILL.md")).rejects.toThrow("changed while it was read");

    await writeFile(join(root, "notes/new.md"), "other");
    await rename(join(root, "notes/new.md"), join(root, "notes/steps.md"));
    await expect(tree.read("notes/steps.md")).rejects.toThrow("changed while it was read");
  });

  it("[TC-AG-138] refuses a file whose folder was swapped for a link outside the skill after the listing", async () => {
    const root = await listed();
    const elsewhere = await outside();
    const tree = await folderTree(root);
    await rename(join(root, "notes"), join(root, "kept"));
    await symlink(elsewhere, join(root, "notes"));
    await expect(tree.read("notes/steps.md")).rejects.toThrow("changed while it was read");

    // The same name, as a real folder again but a new one, is refused too.
    await rm(join(root, "notes"));
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/steps.md"), "Tag, then push.");
    await expect(tree.read("notes/steps.md")).rejects.toThrow("changed while it was read");
  });

  it("[TC-AG-140] never reads outside the skill while a folder in it is swapped for a link and back, during listing and reading", async () => {
    const root = await listed();
    const elsewhere = await outside();
    // A separate process swaps notes for a link to the outside folder and back, as fast as it can.
    const swapper = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const notes = ${JSON.stringify(join(root, "notes"))}, kept = notes + "-real", out = ${JSON.stringify(elsewhere)};
       const end = Date.now() + 3000;
       while (Date.now() < end) {
         try { fs.renameSync(notes, kept); fs.symlinkSync(out, notes); fs.unlinkSync(notes); fs.renameSync(kept, notes); } catch {}
       }`,
    ]);
    let swapping = true;
    const done = new Promise((resolve) => swapper.on("exit", resolve)).then(() => {
      swapping = false;
    });
    const seen: Array<string> = [];
    // List and read for as long as the swapper runs, however slow the machine is.
    while (swapping) {
      const tree = await folderTree(root).catch(() => null);
      if (tree === null) continue;
      for (const entry of tree.entries) {
        if (entry.kind !== "file") continue;
        const bytes = await tree.read(entry.path).catch(() => null);
        if (bytes !== null) seen.push(new TextDecoder().decode(bytes));
      }
    }
    await done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes("secret"))).toBe(false);
  }, 20_000);
});
