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
});
