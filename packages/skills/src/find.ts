import type { SkillDropped } from "@hobbots/domain";
import { insideOf, parentOf, type SkillTree } from "./tree.ts";

/** How deep under a source's top import looks for a `SKILL.md`, as in `plugins/<plugin>/skills/<skill>`. */
const DEPTH_MAX = 5;

/** A Claude Code plugin: a folder with `.claude-plugin/plugin.json`. */
interface Plugin {
  readonly folder: string;
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
}

/** The parts of a plugin that would add authority, each with the place it is in. */
const PLUGIN_PARTS: ReadonlyArray<{ readonly name: string; readonly kind: SkillDropped["kind"] }> = [
  { name: "hooks", kind: "hooks" },
  { name: "commands", kind: "commands" },
  { name: "agents", kind: "agents" },
  { name: ".mcp.json", kind: "mcp-servers" },
];

const pluginsOf = (tree: SkillTree): ReadonlyArray<Plugin> => {
  const paths = new Set(tree.entries.map((entry) => entry.path));
  return tree.entries
    .filter((entry) => entry.kind === "file" && /(?:^|\/)\.claude-plugin\/plugin\.json$/.test(entry.path))
    .map((entry) => {
      const folder = parentOf(parentOf(entry.path));
      const at = (name: string) => (folder === "" ? name : `${folder}/${name}`);
      const dropped = PLUGIN_PARTS.filter((part) => paths.has(at(part.name))).map((part) => ({
        kind: part.kind,
        path: at(part.name),
      }));
      return { folder, dropped };
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
    return { folder, dropped: plugin?.dropped ?? [], plugin: plugin?.folder ?? null };
  });
};
