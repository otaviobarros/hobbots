import { savedSkillInstructions } from "@hobbots/domain";
import { parseDocument } from "yaml";
import { folderTree } from "./sources/folder.ts";
import type { SkillTree } from "./tree.ts";

/** What an edit in Hobbots changes in a skill: what it is for, and its instructions. Its name stays. */
export interface SkillEdit {
  readonly description: string;
  /** The `SKILL.md` text after its front matter. */
  readonly instructions: string;
}

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A `SKILL.md` with the edit applied: the description set in its front matter, every other key kept
 * as it was written, and the instructions after it.
 */
const editSkillFile = (text: string, edit: SkillEdit): string => {
  const document = parseDocument(FRONT_MATTER.exec(text)?.[1] ?? "");
  document.set("description", edit.description);
  return `---\n${document.toString()}---\n\n${savedSkillInstructions(edit.instructions)}`;
};

/** A `SKILL.md` under another name: `name` set in its front matter, every other line kept as it was. */
const renameSkillFile = (text: string, name: string): string => {
  const found = FRONT_MATTER.exec(text);
  const document = parseDocument(found?.[1] ?? "");
  document.set("name", name);
  return `---\n${document.toString()}---\n${found === null ? text : text.slice(found[0].length)}`;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A revision's folder with its `SKILL.md` changed by `change`, every other file as it is. */
const withSkillFile = async (folder: string, change: (text: string) => string): Promise<SkillTree> => {
  const tree = await folderTree(folder);
  const skillFile = encoder.encode(change(decoder.decode(await tree.read("SKILL.md"))));
  return {
    commit: null,
    entries: tree.entries.map((entry) => (entry.path === "SKILL.md" ? { ...entry, size: skillFile.length } : entry)),
    read: (path) => (path === "SKILL.md" ? Promise.resolve(skillFile) : tree.read(path)),
  };
};

/** A revision's folder with the edit applied to its `SKILL.md`, as a source like any other. */
export const editedTree = (folder: string, edit: SkillEdit): Promise<SkillTree> =>
  withSkillFile(folder, (text) => editSkillFile(text, edit));

/** A revision's folder as a copy named `name` (ADR 029, Make a copy): the same files, its `SKILL.md` renamed. */
export const copiedTree = (folder: string, name: string): Promise<SkillTree> =>
  withSkillFile(folder, (text) => renameSkillFile(text, name));
