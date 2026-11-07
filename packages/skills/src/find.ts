import type { SkillDropped } from "@hobbots/domain";
import { insideOf, parentOf, type SkillTree } from "./tree.ts";

/** How deep under a source's top import looks for a `SKILL.md`, as in `plugins/<plugin>/skills/<skill>`. */
const DEPTH_MAX = 5;

/**
 * A plugin: a folder with a Claude Code manifest (`.claude-plugin/plugin.json`) or a Codex one
 * (`.codex-plugin/plugin.json`, or a `plugin.json` at the folder's top, which Codex reads too).
 */
interface Plugin {
  readonly folder: string;
  /** Its manifest, the first of those it has. */
  readonly manifest: string;
  readonly dropped: ReadonlyArray<SkillDropped>;
}

/** A skill folder found in a source, with what its plugin dropped when it is part of one. */
export interface FoundSkill {
  /** Its folder in the source, or "" when the source is the skill. */
  readonly folder: string;
  /** What the plugin it belongs to holds besides skills, which import leaves out (ADR 029, Import). */
  readonly dropped: ReadonlyArray<SkillDropped>;
  /** The plugin's folder, to read its manifest's version from, or null outside a plugin. */
  readonly plugin: string | null;
  /** The plugin's manifest, or null outside a plugin. */
  readonly manifest: string | null;
}

/** The manifests that make a folder a plugin, the one read first first (ADR 029, Skill sets). */
const MANIFESTS: ReadonlyArray<string> = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];

/** The plugin parts import never keeps, by their place in the plugin, which a set's links cannot bring in. */
export const PLUGIN_ONLY: ReadonlyArray<string> = [
  ...["hooks", "commands", "agents", ".mcp.json"],
  ...[".claude-plugin", ".codex-plugin", "plugin.json"],
];

/** The parts of a plugin that would add authority, each with the place it is in. */
const PLUGIN_PARTS: ReadonlyArray<{ readonly name: string; readonly kind: SkillDropped["kind"] }> = [
  { name: "hooks", kind: "hooks" },
  { name: "commands", kind: "commands" },
  { name: "agents", kind: "agents" },
  { name: ".mcp.json", kind: "mcp-servers" },
];

/** The folder a manifest makes a plugin of, or null when the file is not a manifest. */
const pluginFolderOf = (path: string): string | null => {
  for (const manifest of MANIFESTS) {
    if (path === manifest) return "";
    if (path.endsWith(`/${manifest}`)) return path.slice(0, -manifest.length - 1);
  }
  return null;
};

const pluginsOf = (tree: SkillTree): ReadonlyArray<Plugin> => {
  const paths = new Set(tree.entries.map((entry) => entry.path));
  const at = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);
  const folders = new Set(
    tree.entries.flatMap((entry) => {
      const folder = entry.kind === "file" ? pluginFolderOf(entry.path) : null;
      return folder === null ? [] : [folder];
    }),
  );
  return [...folders].map((folder) => {
    const manifest = MANIFESTS.map((name) => at(folder, name)).find((path) => paths.has(path)) as string;
    const dropped = PLUGIN_PARTS.filter((part) => paths.has(at(folder, part.name))).map((part) => ({
      kind: part.kind,
      path: at(folder, part.name),
    }));
    return { folder, manifest, dropped };
  });
};

/** The plugin a skill folder belongs to: the nearest one above it. */
const pluginOf = (plugins: ReadonlyArray<Plugin>, folder: string): Plugin | null =>
  plugins
    .filter((plugin) => plugin.folder === "" || insideOf(plugin.folder, folder) !== null)
    .sort((a, b) => b.folder.length - a.folder.length)[0] ?? null;

/**
 * Every skill folder in a source: each folder with a `SKILL.md`, up to five levels down, that is not
 * inside another one. A source that is one skill gives its top folder, "".
 */
export const findSkills = (tree: SkillTree): ReadonlyArray<FoundSkill> => {
  const plugins = pluginsOf(tree);
  const folders = tree.entries
    .filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
    .filter((entry) => entry.path.split("/").length <= DEPTH_MAX + 1)
    .map((entry) => parentOf(entry.path))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const outer: Array<string> = [];
  for (const folder of folders) {
    if (!outer.some((above) => above === "" || insideOf(above, folder) !== null)) outer.push(folder);
  }
  return outer.sort().map((folder) => {
    const plugin = pluginOf(plugins, folder);
    return {
      folder,
      dropped: plugin?.dropped ?? [],
      plugin: plugin?.folder ?? null,
      manifest: plugin?.manifest ?? null,
    };
  });
};

/** A set a source holds (ADR 029, Skill sets): its folder, its skills' folders, and its plugin's manifest. */
export interface FoundSet {
  /** The set's folder in the source, "" at its top. */
  readonly folder: string;
  /** Each of its skills' folders, in the source. */
  readonly skills: ReadonlyArray<string>;
  /** The plugin's manifest, or null for a folder of a repository. */
  readonly manifest: string | null;
  /** What the plugin holds besides skills, which import leaves out. */
  readonly dropped: ReadonlyArray<SkillDropped>;
}

/** Each plugin's skills as one set: a plugin with skills is always a set. */
export const pluginSets = (found: ReadonlyArray<FoundSkill>): ReadonlyArray<FoundSet> => {
  const sets = new Map<string, FoundSet>();
  for (const skill of found) {
    // A plugin that is one skill at its top is that skill.
    if (skill.plugin === null || skill.manifest === null || skill.folder === skill.plugin) continue;
    const set = sets.get(skill.plugin);
    sets.set(skill.plugin, {
      folder: skill.plugin,
      skills: [...(set?.skills ?? []), skill.folder],
      manifest: skill.manifest,
      dropped: skill.dropped,
    });
  }
  return [...sets.values()];
};

/**
 * The folder a repository's set of skills reaches up to (ADR 029, Skill sets): the folder that holds
 * the skill's folder, or the one above it when that one is named `skills`, so `<set>/skills/<name>/`
 * and `<set>/references/` make one set. Null for a skill at the source's top, which has no siblings.
 */
export const repositorySetFolder = (skillFolder: string): string | null => {
  if (skillFolder === "") return null;
  const holder = parentOf(skillFolder);
  const base = holder.slice(holder.lastIndexOf("/") + 1);
  return base === "skills" ? parentOf(holder) : holder;
};

/** The loose skills side by side with `skillFolder`, it included: those in the same folder. */
export const siblingsOf = (found: ReadonlyArray<FoundSkill>, skillFolder: string): ReadonlyArray<string> =>
  found
    .filter((skill) => skill.plugin === null && skill.folder !== "" && parentOf(skill.folder) === parentOf(skillFolder))
    .map((skill) => skill.folder);
