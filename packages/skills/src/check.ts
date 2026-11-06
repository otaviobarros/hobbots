import { posix } from "node:path";
import {
  SKILL_LIMITS,
  type SkillCheck,
  type SkillDropped,
  type SkillFile,
  SkillFilePath,
  type SkillFlag,
  SkillFrontMatter,
  type SkillName,
  SkillRefused,
  type SkillRevisionHash,
  skillCharmsOf,
} from "@hobbots/domain";
import { Schema } from "effect";
import { parseDocument } from "yaml";
import type { FoundSkill } from "./find.ts";
import { revisionHash, type SkillContent, sha256, skillsCliHash } from "./hash.ts";
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

/** Characters that hide text from a reader: zero-width, direction overrides and tag characters. */
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const URL = /\bhttps?:\/\/[^\s<>"'`)\]\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/g;
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|psm1|bat|cmd|exe|bin)$/i;
const LINK_TARGETS = [/\]\(\s*<?([^)\s>]+)>?/g, /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi];
/** A reference definition, `[name]: target`, on a line that has been trimmed. */
const REFERENCE = /^\[[^\]]+\]:[ \t]*(\S+)/;
/** What ends a URL in prose rather than belonging to it. */
const URL_TRAILING: ReadonlySet<string> = new Set([".", ",", ";", ":", "!", "?"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Markdown with its fenced code taken out, so an example in a code block is not read as a link. One
 * pass over the lines (STD-SEC-005). A fence that is never closed is kept, so it hides nothing.
 */
const withoutCode = (text: string) => {
  const kept: Array<string> = [];
  let fence: { readonly marker: string; readonly lines: Array<string> } | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      if (line.startsWith(fence.marker)) fence = null;
      else fence.lines.push(line);
      continue;
    }
    const marker = line.startsWith("```") ? "```" : line.startsWith("~~~") ? "~~~" : null;
    if (marker === null) kept.push(line);
    else fence = { marker, lines: [line] };
  }
  if (fence !== null) kept.push(...fence.lines);
  return kept.join("\n");
};

/** The URL without the punctuation that ends its sentence, cut by hand (STD-SEC-005). */
const withoutTrailingPunctuation = (url: string) => {
  let end = url.length;
  while (end > 0 && URL_TRAILING.has(url[end - 1] ?? "")) end -= 1;
  return url.slice(0, end);
};

/** The link targets of a file: inline links, `src` and `href`, and reference definitions. */
const linkTargetsOf = (source: string): ReadonlyArray<string> => {
  const targets = LINK_TARGETS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ""));
  for (const line of source.split("\n")) {
    const target = REFERENCE.exec(line.trim())?.[1];
    if (target === undefined) continue;
    const opened = target.startsWith("<") ? target.slice(1) : target;
    targets.push(opened.endsWith(">") ? opened.slice(0, -1) : opened);
  }
  return targets;
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

const checkLinks = (path: string, text: string) => {
  const source = path.toLowerCase().endsWith(".md") ? withoutCode(text) : text;
  for (const target of linkTargetsOf(source)) {
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
  const hidden = HIDDEN.exec(text.startsWith("﻿") ? text.slice(1) : text);
  if (hidden !== null) {
    const codePoint = `U+${(hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    flags.push({ _tag: "HiddenText", path: file.path, codePoint });
  }
  return flags;
};

/** Reads `SKILL.md`, and writes it again without `allowed-tools` when it has them. */
const readSkillFile = (text: string, at: string) => {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return refuse("front-matter", at, `${at} has no front matter between --- lines.`);
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0) {
    return refuse("front-matter", at, `${at} has front matter that is not YAML: ${document.errors[0]?.message}`);
  }
  let frontMatter: SkillFrontMatter;
  try {
    frontMatter = decodeFrontMatter(document.toJS());
  } catch (error) {
    return refuse("front-matter", at, `${at} has front matter Hobbots cannot use: ${(error as Error).message}`);
  }
  if (frontMatter["allowed-tools"] === undefined) return { frontMatter, text, droppedTools: false };
  document.delete("allowed-tools");
  const rest = text.slice(match[0].length);
  return { frontMatter, text: `---\n${document.toString()}---\n${rest}`, droppedTools: true };
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
    const text = textOf(bytes);
    if (text !== null) checkLinks(file.path, text);
    contents.push({ path: file.path, mode: file.mode, bytes });
  }
  return {
    folder: found.folder,
    name: skill.frontMatter.name,
    description: skill.frontMatter.description,
    charms: [...charms].sort(),
    label: (await pluginVersion(tree, found.plugin)) ?? labelOf(skill.frontMatter.metadata),
    flags: contents.flatMap((file) => flagsOf(file, textOf(file.bytes))),
    dropped,
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
    cliHash,
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
