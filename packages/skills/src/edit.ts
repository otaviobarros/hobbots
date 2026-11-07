import { posix } from "node:path";
import { type SkillSetSkill, savedSkillInstructions } from "@hobbots/domain";
import { parseDocument } from "yaml";
import { rewriteSetLinks, setLinksOf } from "./check.ts";
import { folderTree } from "./sources/folder.ts";
import type { SkillTree, TreeEntry } from "./tree.ts";

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

/** Where a copy of a set's skill keeps the set's files it links to, beside its own. */
const LINKED = "linked";

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of a file, or null when it is not UTF-8 text, so its bytes are copied as they are. */
const textOf = (bytes: Uint8Array): string | null => {
  try {
    const text = strict.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

/** The folder for the set's files in a copy of `member`: `linked`, or `linked-2` and on when the skill has its own. */
const linkedRootOf = (paths: ReadonlyArray<string>, member: SkillSetSkill): string => {
  const own = paths
    .filter((path) => path.startsWith(`${member.path}/`))
    .map((path) => path.slice(member.path.length + 1));
  const taken = (root: string) => own.some((path) => path === root || path.startsWith(`${root}/`));
  let root = LINKED;
  for (let n = 2; taken(root); n += 1) root = `${LINKED}-${n}`;
  return root;
};

/**
 * Where a file of the set goes in a copy of `member`, before clashes: the skill's own files at the
 * copy's top, and every other file under `root` as the set lays it out. Another skill's `SKILL.md`
 * is renamed after its folder, so no runtime takes it for a second skill.
 */
const naturalPlace = (member: SkillSetSkill, root: string, path: string) => {
  if (path.startsWith(`${member.path}/`)) return path.slice(member.path.length + 1);
  const parent = posix.dirname(path);
  const name = posix.basename(path) === "SKILL.md" && parent !== "." ? `${posix.basename(parent)}.md` : null;
  return `${root}/${name === null ? path : `${parent}/${name}`}`;
};

/** `at`, or `at` with `-2`, `-3` and on before its extension, whichever no other file of the copy holds. */
const freePlace = (at: string, taken: ReadonlySet<string>): string => {
  const clash = (one: string) =>
    [...taken].some((held) => held === one || held.startsWith(`${one}/`) || one.startsWith(`${held}/`));
  const extension = posix.extname(at);
  const stem = at.slice(0, at.length - extension.length);
  let place = at;
  for (let n = 2; clash(place); n += 1) place = `${stem}-${n}${extension}`;
  return place;
};

/**
 * Where each file a copy of `member` brings goes: one place each, so no file is lost. Files that keep
 * their name are placed first; a renamed `SKILL.md` that would land on another file gets a numbered name.
 */
const placesOf = (paths: ReadonlyArray<string>, member: SkillSetSkill, root: string): ReadonlyMap<string, string> => {
  const renamed = (path: string) => !path.startsWith(`${member.path}/`) && posix.basename(path) === "SKILL.md";
  const ordered = [...paths].sort((a, b) => Number(renamed(a)) - Number(renamed(b)) || a.localeCompare(b));
  const places = new Map<string, string>();
  const taken = new Set<string>();
  for (const path of ordered) {
    const place = freePlace(naturalPlace(member, root, path), taken);
    places.set(path, place);
    taken.add(place);
  }
  return places;
};

/** Where a folder of the set goes in a copy of `member`. */
const placeFolder = (member: SkillSetSkill, root: string, linked: string): string => {
  if (linked === member.path) return ".";
  if (linked.startsWith(`${member.path}/`)) return linked.slice(member.path.length + 1);
  return `${root}/${linked}`;
};

/**
 * The set's files a copy of `member` brings: the skill's own folder, and every file of the set it
 * links to, directly or through those files. A link to a folder brings the folder's files.
 */
const linkedClosure = async (
  tree: SkillTree,
  member: SkillSetSkill,
): Promise<ReadonlyMap<string, { readonly entry: TreeEntry; readonly text: string | null }>> => {
  const files = new Map(tree.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
  const kept = new Map<string, { readonly entry: TreeEntry; readonly text: string | null }>();
  const queue = [...files.keys()].filter((path) => path.startsWith(`${member.path}/`));
  while (queue.length > 0) {
    const path = queue.shift() ?? "";
    const entry = files.get(path);
    if (entry === undefined || kept.has(path)) continue;
    const text = textOf(await tree.read(path));
    kept.set(path, { entry, text });
    if (text === null) continue;
    for (const linked of setLinksOf(path, text)) {
      if (files.has(linked)) queue.push(linked);
      else queue.push(...[...files.keys()].filter((one) => one.startsWith(`${linked}/`)));
    }
  }
  return kept;
};

/**
 * A copy of one skill of a set (ADR 029, Skill sets), named `name`: its folder at the top, its
 * `SKILL.md` renamed, and the set's files it links to under `linked/`, with the links that lead to
 * them pointed at their new places, so the copy works without the set. A file that is not text, or
 * that no link in it changes, keeps its bytes.
 */
export const memberCopyTree = async (folder: string, member: SkillSetSkill, name: string): Promise<SkillTree> => {
  const tree = await folderTree(folder);
  const kept = await linkedClosure(tree, member);
  const root = linkedRootOf([...tree.entries.map((entry) => entry.path)], member);
  const places = placesOf([...kept.keys()], member, root);
  const place = (path: string) => places.get(path) ?? path;
  const files = new Map<
    string,
    { readonly source: string; readonly entry: TreeEntry; readonly bytes: Uint8Array | null }
  >();
  for (const [path, { entry, text }] of kept) {
    const at = place(path);
    const to = (linked: string) => {
      const folderKept = [...kept.keys()].some((one) => one.startsWith(`${linked}/`));
      const target = kept.has(linked) ? place(linked) : folderKept ? placeFolder(member, root, linked) : null;
      // A link inside the skill's own folder, or to a file the copy does not bring, stays as written.
      if (target === null || (path.startsWith(`${member.path}/`) && linked.startsWith(`${member.path}/`))) return null;
      return posix.relative(posix.dirname(at), target) || posix.basename(target);
    };
    const changed = text === null ? null : rewriteSetLinks(path, text, to);
    const named = at === "SKILL.md" && changed !== null ? renameSkillFile(changed, name) : changed;
    files.set(at, { source: path, entry, bytes: named === null || named === text ? null : encoder.encode(named) });
  }
  return {
    commit: null,
    entries: [...files].map(([path, { entry, bytes }]) => ({ ...entry, path, size: bytes?.length ?? entry.size })),
    read: (path) => {
      const file = files.get(path);
      if (file === undefined) return Promise.reject(new Error(`${path} is not in the copy.`));
      return file.bytes === null ? tree.read(file.source) : Promise.resolve(file.bytes);
    },
  };
};
