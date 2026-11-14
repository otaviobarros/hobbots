import { posix } from "node:path";
import {
  RESERVED_SET_NAME,
  SKILL_DESCRIPTION_MAX,
  SKILL_HIDDEN_TEXT,
  SKILL_LIMITS,
  type SkillCheck,
  type SkillDropped,
  type SkillFile,
  SkillFilePath,
  type SkillFlag,
  SkillFrontMatter,
  SkillName,
  SkillRefused,
  type SkillRevisionHash,
  type SkillSetContent,
  type SkillSetSkill,
  skillCharmsOf,
} from "@hobbots/domain";
import { Schema } from "effect";
import { parseDocument } from "yaml";
import { type FoundSet, type FoundSkill, PLUGIN_ONLY } from "./find.ts";
import { revisionHash, type SkillContent, sha256, skillsCliHash } from "./hash.ts";
import { type LinkTarget, readSkillMarkdown } from "./markdown.ts";
import { insideOf, type SkillTree } from "./tree.ts";

/** A skill that passed every check, as a revision would hold it. */
export interface CheckedSkill {
  readonly folder: string;
  readonly name: SkillName;
  readonly description: string;
  readonly charms: ReadonlyArray<string>;
  readonly label: string | null;
  readonly flags: ReadonlyArray<SkillFlag>;
  readonly dropped: ReadonlyArray<SkillDropped>;
  readonly contents: ReadonlyArray<SkillContent>;
  readonly files: ReadonlyArray<SkillFile>;
  readonly hash: SkillRevisionHash;
  /** The `skills` CLI's hash of the folder as it was read, before anything was dropped. */
  readonly cliHash: string;
  /** For a set (ADR 029, Skill sets), the skills it holds; null for a skill. */
  readonly set: SkillSetContent | null;
}

export type CheckResult =
  | { readonly _tag: "Passed"; readonly skill: CheckedSkill }
  | { readonly _tag: "Refused"; readonly folder: string; readonly refusal: SkillRefused };

class Refusal extends Error {
  constructor(
    readonly check: SkillCheck,
    readonly path: string | null,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (check: SkillCheck, path: string | null, message: string): never => {
  throw new Refusal(check, path, message);
};

const decodeFrontMatter = Schema.decodeUnknownSync(SkillFrontMatter);
const isFilePath = Schema.is(SkillFilePath);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of a file, or null when it is not UTF-8 text. */
const textOf = (bytes: Uint8Array): string | null => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

const URL = /\bhttps?:\/\/[^\s<>"'`)\]\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/g;
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|psm1|bat|cmd|exe|bin)$/i;
/** What ends a URL in prose rather than belonging to it. */
const URL_TRAILING: ReadonlySet<string> = new Set([".", ",", ";", ":", "!", "?"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The URL without the punctuation that ends its sentence, cut by hand (STD-SEC-005). */
const withoutTrailingPunctuation = (url: string) => {
  let end = url.length;
  while (end > 0 && URL_TRAILING.has(url[end - 1] ?? "")) end -= 1;
  return url.slice(0, end);
};

/** Whether a link in the file at `path` reaches outside the skill: an absolute path, a `file:` URL, or `..` past the top. */
const reachesOutside = (path: string, target: string): boolean => {
  if (target.startsWith("#")) return false;
  if (SCHEME.test(target)) return /^file:/i.test(target);
  if (/^[/\\~]/.test(target) || /^[a-z]:[\\/]/i.test(target)) return true;
  const bare = target.split(/[?#]/)[0] ?? "";
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {}
  const resolved = posix.normalize(posix.join(posix.dirname(path), decoded.replaceAll("\\", "/")));
  return resolved === ".." || resolved.startsWith("../");
};

const checkLinks = (path: string, links: ReadonlyArray<LinkTarget>) => {
  for (const { target } of links) {
    if (reachesOutside(path, target)) refuse("outside-path", path, `${path} links to ${target}, outside the skill.`);
  }
};

const flagsOf = (file: SkillContent, text: string | null): ReadonlyArray<SkillFlag> => {
  const flags: Array<SkillFlag> = [];
  if (file.mode === "executable" || SCRIPT_EXTENSIONS.test(file.path) || text?.startsWith("#!")) {
    flags.push({ _tag: "Script", path: file.path });
  }
  if (text === null) return flags;
  const urls = (text.match(URL) ?? []).map(withoutTrailingPunctuation);
  for (const url of new Set(urls)) flags.push({ _tag: "Url", path: file.path, url });
  const hidden = SKILL_HIDDEN_TEXT.exec(text.startsWith("﻿") ? text.slice(1) : text);
  if (hidden !== null) {
    const codePoint = `U+${(hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    flags.push({ _tag: "HiddenText", path: file.path, codePoint });
  }
  return flags;
};

/** Reads `SKILL.md`, and writes it again without `allowed-tools` when it has them. */
const readSkillFile = (text: string, at: string) => {
  const { frontMatter: found, links } = readSkillMarkdown("SKILL.md", text);
  if (found === null) return refuse("front-matter", at, `${at} has no front matter between --- lines.`);
  const document = parseDocument(found.yaml);
  if (document.errors.length > 0) {
    return refuse("front-matter", at, `${at} has front matter that is not YAML: ${document.errors[0]?.message}`);
  }
  let frontMatter: SkillFrontMatter;
  try {
    frontMatter = decodeFrontMatter(document.toJS());
  } catch (error) {
    return refuse("front-matter", at, `${at} has front matter Hobbots cannot use: ${(error as Error).message}`);
  }
  if (frontMatter["allowed-tools"] === undefined) return { frontMatter, text, links, droppedTools: false };
  document.delete("allowed-tools");
  // The text after the front matter is kept as it is, and so are its links.
  return { frontMatter, text: `---\n${document.toString()}---\n${found.rest}`, links, droppedTools: true };
};

/** Reads Codex's `agents/openai.yaml`, and writes it again without its tool dependencies. */
const readCodexMetadata = (text: string) => {
  const document = parseDocument(text);
  if (document.errors.length > 0 || !document.has("dependencies")) return null;
  const tools = (document.toJS() as { dependencies?: { tools?: ReadonlyArray<{ type?: unknown; value?: unknown }> } })
    .dependencies?.tools;
  const charms = (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.type === "mcp" && typeof tool.value === "string")
    .map((tool) => String(tool.value).toLowerCase());
  document.delete("dependencies");
  return { charms, text: document.toString() };
};

const encoder = new TextEncoder();

const listFiles = (tree: SkillTree, found: FoundSkill) => {
  const entries = tree.entries.flatMap((entry) => {
    const relative = insideOf(found.folder, entry.path);
    return relative === null ? [] : [{ ...entry, relative }];
  });
  for (const entry of entries) {
    if (entry.kind === "symlink") refuse("symlink", entry.path, `${entry.path} is a link; a skill holds only files.`);
    if (entry.kind === "other") refuse("unreadable", entry.path, `${entry.path} is not a file or a folder.`);
    if (!isFilePath(entry.relative)) refuse("outside-path", entry.path, `${entry.path} reaches outside the skill.`);
  }
  const files = entries.filter((entry) => entry.kind === "file");
  if (files.length > SKILL_LIMITS.files) {
    refuse("too-many-files", null, `The skill holds ${files.length} files; the most is ${SKILL_LIMITS.files}.`);
  }
  const size = files.reduce((total, file) => total + file.size, 0);
  if (size > SKILL_LIMITS.bytes) refuse("too-large", null, "The skill is larger than 5 MB.");
  return files;
};

const pluginVersion = async (tree: SkillTree, plugin: string | null): Promise<string | null> => {
  if (plugin === null) return null;
  const manifest = textOf(
    await tree.read(plugin === "" ? ".claude-plugin/plugin.json" : `${plugin}/.claude-plugin/plugin.json`),
  );
  try {
    const version = (JSON.parse(manifest ?? "{}") as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
};

const labelOf = (metadata: SkillFrontMatter["metadata"]): string | null =>
  typeof metadata?.version === "string" ? metadata.version : null;

/** What a revision stores of its contents: the files, their flags and the revision's hash. */
const stored = (contents: ReadonlyArray<SkillContent>) => ({
  flags: contents.flatMap((file) => flagsOf(file, textOf(file.bytes))),
  contents,
  files: contents
    .map(
      (file): SkillFile => ({
        path: file.path,
        mode: file.mode,
        size: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      }),
    )
    .sort((a, b) => (a.path < b.path ? -1 : 1)),
  hash: revisionHash(contents),
});

/**
 * Checks one skill folder of a source before anything is written (ADR 029, Import): valid front
 * matter, no link or path outside the skill, no link of the file system, at most 5 MB in 200 files.
 * Drops what would add authority, with a note, and flags what deserves a careful look. Runs nothing.
 */
const checkFolder = async (tree: SkillTree, found: FoundSkill): Promise<CheckedSkill> => {
  const listed = listFiles(tree, found);
  const unsorted = await Promise.all(
    listed.map(async (entry) => ({
      path: entry.relative,
      source: entry.path,
      mode: entry.executable ? ("executable" as const) : ("regular" as const),
      bytes: await tree.read(entry.path),
    })),
  );
  const read = unsorted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const cliHash = skillsCliHash(read);
  const skillFile = read.find((file) => file.path === "SKILL.md");
  const skillText = skillFile === undefined ? null : textOf(skillFile.bytes);
  const at = found.folder === "" ? "SKILL.md" : `${found.folder}/SKILL.md`;
  if (skillText === null) return refuse("front-matter", at, `${at} is not UTF-8 text.`);
  const skill = readSkillFile(skillText, at);
  const dropped: Array<SkillDropped> = [...found.dropped];
  if (skill.droppedTools) dropped.push({ kind: "allowed-tools", path: at });
  const charms = new Set(skillCharmsOf(skill.frontMatter));
  const contents: Array<SkillContent> = [];
  for (const file of read) {
    let bytes = file.bytes;
    if (file.path === "SKILL.md") bytes = encoder.encode(skill.text);
    if (file.path === "agents/openai.yaml") {
      const codex = readCodexMetadata(textOf(file.bytes) ?? "");
      if (codex !== null) {
        for (const charm of codex.charms) charms.add(charm);
        dropped.push({ kind: "tool-dependencies", path: file.source });
        bytes = encoder.encode(codex.text);
      }
    }
    if (file.path === "SKILL.md") checkLinks(file.path, skill.links);
    else {
      const text = textOf(bytes);
      if (text !== null) checkLinks(file.path, readSkillMarkdown(file.path, text).links);
    }
    contents.push({ path: file.path, mode: file.mode, bytes });
  }
  return {
    folder: found.folder,
    name: skill.frontMatter.name,
    description: skill.frontMatter.description,
    charms: [...charms].sort(),
    label: (await pluginVersion(tree, found.plugin)) ?? labelOf(skill.frontMatter.metadata),
    dropped,
    ...stored(contents),
    cliHash,
    set: null,
  };
};

/** Checks one skill folder, answering what passed or the first rule it broke. */
export const checkSkill = async (tree: SkillTree, found: FoundSkill): Promise<CheckResult> => {
  try {
    return { _tag: "Passed", skill: await checkFolder(tree, found) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      _tag: "Refused",
      folder: found.folder,
      refusal: new SkillRefused({ check: error.check, path: error.path, message: error.message }),
    };
  }
};

const isSkillName = Schema.is(SkillName);

/** `path` inside a set's folder, or `path` itself at the source's top. */
const inSet = (set: FoundSet, path: string) => (set.folder === "" ? path : `${set.folder}/${path}`);

/** Where a link in the file at `path` leads, inside the set: a normalized path, or null for an anchor or a URL. */
const linkedPath = (path: string, target: string): string | null => {
  if (target.startsWith("#") || SCHEME.test(target)) return null;
  const bare = target.split(/[?#]/)[0] ?? "";
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {}
  if (decoded === "") return null;
  const resolved = posix.normalize(posix.join(posix.dirname(path), decoded.replaceAll("\\", "/")));
  return resolved === "." ? null : resolved.replace(/\/$/, "");
};

/**
 * The paths inside a set that a file at `path` links to (ADR 029, Skill sets), each once, as the set
 * lays them out: a link to a folder names the folder. Anchors, URLs and links outside the set are left out.
 */
export const setLinksOf = (path: string, text: string): ReadonlyArray<string> => {
  const linked = readSkillMarkdown(path, text).links.flatMap(({ target }) => {
    const at = linkedPath(path, target);
    return at === null || at === ".." || at.startsWith("../") || at.startsWith("/") ? [] : [at];
  });
  return [...new Set(linked)];
};

/**
 * A file's text with each link that leads inside a set pointed elsewhere: `to` gets the path inside
 * the set a link leads to and gives the new target, or null to leave the link as written. What
 * follows the path, such as `#a-heading`, is kept.
 */
export const rewriteSetLinks = (path: string, text: string, to: (linked: string) => string | null): string => {
  const retarget = (target: string) => {
    const linked = linkedPath(path, target);
    if (linked === null) return target;
    const moved = to(linked);
    if (moved === null) return target;
    const at = target.search(/[?#]/);
    return at === -1 ? moved : `${moved}${target.slice(at)}`;
  };
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let rewritten = text.slice(bom.length);
  // From the last link back, so each target's offsets still hold when it is replaced.
  for (const { from, to, target } of [...readSkillMarkdown(path, text).links].reverse()) {
    rewritten = `${rewritten.slice(0, from)}${retarget(target)}${rewritten.slice(to)}`;
  }
  return `${bom}${rewritten}`;
};

/** Whether a set's path is a part of the plugin import never keeps, such as its hooks or its manifest. */
const pluginOnly = (path: string) => PLUGIN_ONLY.some((part) => path === part || path.startsWith(`${part}/`));

interface SetEntry {
  readonly path: string;
  readonly source: string;
  readonly kind: TreeEntryKind;
  readonly executable: boolean;
  readonly size: number;
}
type TreeEntryKind = SkillTree["entries"][number]["kind"];

/**
 * The files a set keeps (ADR 029, Skill sets): every file of its skills' folders, then each file a
 * kept file links to inside the set, a linked folder's files included, and the files those link to.
 * A link outside the set is refused; one to a file that is not there, or to a part of the plugin
 * import never keeps, is left alone. Reads each kept file once.
 */
const setFiles = async (tree: SkillTree, set: FoundSet, skillFolders: ReadonlyArray<string>) => {
  const entries = new Map<string, SetEntry>();
  for (const entry of tree.entries) {
    const path = insideOf(set.folder, entry.path);
    if (path !== null && path !== "") entries.set(path, { ...entry, path, source: entry.path });
  }
  const kept = new Map<string, SetEntry>();
  const queue: Array<string> = [];
  let size = 0;
  // The limits count each file as it is kept, before it is read, as a loose skill's do.
  const keep = (entry: SetEntry) => {
    if (entry.kind === "symlink") refuse("symlink", entry.source, `${entry.source} is a link; a set holds only files.`);
    if (entry.kind === "other") refuse("unreadable", entry.source, `${entry.source} is not a file or a folder.`);
    if (!isFilePath(entry.path)) refuse("outside-path", entry.source, `${entry.source} reaches outside the set.`);
    if (entry.kind !== "file" || kept.has(entry.path)) return;
    kept.set(entry.path, entry);
    size += entry.size;
    checkSetLimits(kept.size, size);
    queue.push(entry.path);
  };
  const keepFolder = (folder: string) => {
    for (const entry of entries.values())
      if (entry.path.startsWith(`${folder}/`) && !pluginOnly(entry.path)) keep(entry);
  };
  for (const folder of skillFolders) keepFolder(folder);
  const bytes = new Map<string, Uint8Array>();
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const entry = kept.get(path) as SetEntry;
    const read = await tree.read(entry.source);
    bytes.set(path, read);
    const text = textOf(read);
    if (text === null) continue;
    for (const { target } of readSkillMarkdown(path, text).links) {
      if (reachesOutside(path, target)) {
        refuse("outside-path", inSet(set, path), `${inSet(set, path)} links to ${target}, outside the set.`);
      }
      const linked = linkedPath(path, target);
      if (linked === null || pluginOnly(linked)) continue;
      const found = entries.get(linked);
      if (found === undefined) continue;
      if (found.kind === "directory") keepFolder(linked);
      else keep(found);
    }
  }
  const files = [...kept.values()];
  return files
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ ...file, bytes: bytes.get(file.path) as Uint8Array }));
};

/** Refuses a set over the limits a skill has, which count the whole set. */
const checkSetLimits = (files: number, bytes: number) => {
  if (files > SKILL_LIMITS.files) {
    refuse("too-many-files", null, `The set holds more than ${SKILL_LIMITS.files} files.`);
  }
  if (bytes > SKILL_LIMITS.bytes) refuse("too-large", null, "The set is larger than 5 MB.");
};

/** What a plugin's manifest says of it: its name, version and description, each when it is text. */
const manifestOf = async (tree: SkillTree, manifest: string | null) => {
  if (manifest === null) return { name: null, version: null, description: null };
  let parsed: { readonly name?: unknown; readonly version?: unknown; readonly description?: unknown } = {};
  try {
    parsed = JSON.parse(textOf(await tree.read(manifest)) ?? "{}") ?? {};
  } catch {
    return refuse("front-matter", manifest, `${manifest} is not JSON.`);
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return { name: text(parsed.name), version: text(parsed.version), description: text(parsed.description) };
};

/** A set's description: its manifest's, at most 1,024 characters, or one that lists its skills. */
const setDescription = (given: string | null, skills: ReadonlyArray<SkillSetSkill>) => {
  const description = given ?? `Skills: ${skills.map((skill) => skill.name).join(", ")}.`;
  return description.length > SKILL_DESCRIPTION_MAX
    ? `${description.slice(0, SKILL_DESCRIPTION_MAX - 1)}…`
    : description;
};

/** The set's name, refused when it is not one a set can have. */
const setNameOf = (name: string | null, set: FoundSet): SkillName => {
  const at = set.manifest ?? (set.folder === "" ? "." : set.folder);
  if (name === null || !isSkillName(name)) {
    return refuse(
      "front-matter",
      at,
      `${at} names the set ${JSON.stringify(name ?? "")}, which is not a name a set can have: lower-case letters, digits and single hyphens.`,
    );
  }
  if (name === RESERVED_SET_NAME) return refuse("front-matter", at, `A set cannot be named ${RESERVED_SET_NAME}.`);
  return name;
};

/**
 * Checks a set before anything is written (ADR 029, Skill sets): its name, each of its skills' front
 * matter, the files it keeps and the links between them, and the limits, which count the whole set.
 * Drops what would add authority, with a note, and flags what deserves a careful look. Runs nothing.
 */
const checkSetFolder = async (tree: SkillTree, set: FoundSet, folderName: string | null): Promise<CheckedSkill> => {
  const manifest = await manifestOf(tree, set.manifest);
  const name = setNameOf(manifest.name ?? folderName, set);
  const skillFolders = set.skills.map((folder) => insideOf(set.folder, folder) as string);
  const read = await setFiles(tree, set, skillFolders);
  const cliHash = skillsCliHash(read);
  const dropped: Array<SkillDropped> = [...set.dropped];
  const rewritten = new Map<string, Uint8Array>();
  const skills: Array<SkillSetSkill> = [];
  for (const folder of skillFolders) {
    const path = `${folder}/SKILL.md`;
    const skillFile = read.find((file) => file.path === path);
    const skillText = skillFile === undefined ? null : textOf(skillFile.bytes);
    if (skillText === null) return refuse("front-matter", inSet(set, path), `${inSet(set, path)} is not UTF-8 text.`);
    const skill = readSkillFile(skillText, inSet(set, path));
    if (skill.droppedTools) {
      dropped.push({ kind: "allowed-tools", path: inSet(set, path) });
      rewritten.set(path, encoder.encode(skill.text));
    }
    const charms = new Set(skillCharmsOf(skill.frontMatter));
    const codexPath = `${folder}/agents/openai.yaml`;
    const codexFile = read.find((file) => file.path === codexPath);
    const codex = codexFile === undefined ? null : readCodexMetadata(textOf(codexFile.bytes) ?? "");
    if (codex !== null) {
      for (const charm of codex.charms) charms.add(charm);
      dropped.push({ kind: "tool-dependencies", path: inSet(set, codexPath) });
      rewritten.set(codexPath, encoder.encode(codex.text));
    }
    if (skills.some((one) => one.name === skill.frontMatter.name)) {
      return refuse("front-matter", inSet(set, path), `Two skills of the set are named ${skill.frontMatter.name}.`);
    }
    skills.push({
      name: skill.frontMatter.name,
      description: skill.frontMatter.description,
      path: folder,
      charms: [...charms].sort(),
    });
  }
  const contents: Array<SkillContent> = read.map((file) => ({
    path: file.path,
    mode: file.executable ? "executable" : "regular",
    bytes: rewritten.get(file.path) ?? file.bytes,
  }));
  skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    folder: set.folder,
    name,
    description: setDescription(manifest.description, skills),
    charms: [...new Set(skills.flatMap((skill) => skill.charms))].sort(),
    label: manifest.version,
    dropped,
    ...stored(contents),
    cliHash,
    set: { skills },
  };
};

/**
 * Checks one set, answering what passed or the first rule it broke. `folderName` names a set that
 * is a folder of a repository, which has no manifest to name it.
 */
export const checkSet = async (tree: SkillTree, set: FoundSet, folderName: string | null): Promise<CheckResult> => {
  try {
    return { _tag: "Passed", skill: await checkSetFolder(tree, set, folderName) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      _tag: "Refused",
      folder: set.folder,
      refusal: new SkillRefused({ check: error.check, path: error.path, message: error.message }),
    };
  }
};
