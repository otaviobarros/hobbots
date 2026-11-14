import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { RuntimeError, type SkillMount } from "@hobbots/agents";
import { Effect, type Scope } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import { Document, isMap, parseDocument } from "yaml";

/** The plugin a Claude Code turn loads its skills from, so each is listed as `hobbots-skills:<name>`. */
export const SKILLS_PLUGIN = "hobbots-skills";

/**
 * The skill you picked for the turn with `/` (ADR 029, Explicit use), when the turn mounted it; null
 * otherwise, so a turn never mentions a skill it does not have.
 */
export const askedMount = (
  asked: string | null | undefined,
  mounts: ReadonlyArray<SkillMount> | null | undefined,
): SkillMount | null => (asked ? ((mounts ?? []).find((mount) => mountName(mount) === asked) ?? null) : null);

/** A mount's full name: `<set>:<name>` for a skill of a set (ADR 029, Skill sets), its name otherwise. */
export const mountName = (mount: SkillMount): string => (mount.set ? `${mount.set.name}:${mount.name}` : mount.name);

/** The folder, inside a runtime folder, that holds the turns' skill folders (ADR 029). */
export const SKILL_MOUNTS = "skill-mounts";

/** A set a turn's folder holds (ADR 029, Skill sets): its name, and its folder, laid out as it was imported. */
interface MountedSet {
  readonly name: string;
  /** The set's folder, which Claude Code loads as a plugin of that name and Codex reads as an extra root. */
  readonly folder: string;
}

/**
 * A turn's skill folder: the plugin folder, the `skills/` inside it that holds one folder per skill,
 * and each set it mounts, in `sets/<set>/`.
 */
export interface SkillFolder {
  /** The SHA-256 of the mounts, which names the folder. */
  readonly hash: string;
  /** The folder itself, which Claude Code loads as a plugin. */
  readonly folder: string;
  /** Its `skills/` folder, which Codex reads as an extra root. */
  readonly skills: string;
  /** The sets it holds, by name. */
  readonly sets: ReadonlyArray<MountedSet>;
}

/** Where a mounted skill's `SKILL.md` is in a turn's folder: in `skills/<name>/`, or in its set's folder. */
export const mountedSkillFile = (folder: SkillFolder, mount: SkillMount): string =>
  mount.set
    ? join(folder.folder, SETS, mount.set.name, ...mount.set.path.split("/"), "SKILL.md")
    : join(folder.skills, mount.name, "SKILL.md");

/** The folder, inside a turn's folder, that holds the sets it mounts. */
const SETS = "sets";

/**
 * The SHA-256 of a set of mounts (ADR 029): each name, revision and whether the hob may pick it on its
 * own, in name order, so the same set always names the same folder. The source folders do not count:
 * a revision's files are the same wherever they are kept.
 */
export const skillMountsHash = (mounts: ReadonlyArray<SkillMount>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...mounts]
          .sort((a, b) => (mountName(a) < mountName(b) ? -1 : mountName(a) > mountName(b) ? 1 : 0))
          .map((mount) =>
            mount.set
              ? [mount.name, mount.revision, mount.implicit, mount.set.name, mount.set.path]
              : [mount.name, mount.revision, mount.implicit],
          ),
      ),
    )
    .digest("hex");

/**
 * The YAML front matter at the top of a `SKILL.md` and the text after it, as a CommonMark parser
 * reads them (STD-DUP-008), or null when the file opens with none.
 */
const frontMatterOf = (file: string): { readonly yaml: string; readonly rest: string } | null => {
  // The parser skips a byte order mark without counting it, so offsets count from after it.
  const text = file.startsWith("\uFEFF") ? file.slice(1) : file;
  const tree = fromMarkdown(text, { extensions: [frontmatter()], mdastExtensions: [frontmatterFromMarkdown()] });
  const first = tree.children[0];
  const end = first?.position?.end.offset;
  if (first?.type !== "yaml" || end === undefined) return null;
  const rest = text.slice(end);
  return { yaml: first.value, rest: rest.slice(rest.startsWith("\r\n") ? 2 : /^[\n\r]/.test(rest) ? 1 : 0) };
};

/**
 * A `SKILL.md` that Claude Code never picks on its own (`disable-model-invocation: true`), from the
 * stored one. Its front matter is rewritten, the rest kept as it is.
 */
export const onlyWhenAskedSkillFile = (text: string): string => {
  const found = frontMatterOf(text);
  const document = found ? parseDocument(found.yaml) : new Document({});
  if (!isMap(document.contents)) document.contents = document.createNode({});
  document.set("disable-model-invocation", true);
  const body = found ? found.rest : text;
  return `---\n${document.toString().trimEnd()}\n---\n${body}`;
};

/**
 * Codex's `agents/openai.yaml` for a skill it never picks on its own
 * (`policy.allow_implicit_invocation: false`), from the stored one or none.
 */
export const onlyWhenAskedCodexFile = (text: string | null): string => {
  const document = text === null ? new Document({}) : parseDocument(text);
  if (!isMap(document.contents)) document.contents = document.createNode({});
  if (!isMap(document.get("policy"))) document.set("policy", document.createNode({}));
  document.setIn(["policy", "allow_implicit_invocation"], false);
  return document.toString();
};

/** Refuses a mount whose files hold a link, which could point outside the skill (ADR 029). */
const assertNoLinks = (folder: string, name: string) => {
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`The skill ${name} holds a link, ${join(entry.parentPath, entry.name)}.`);
  }
};

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Marks a copied skill Only when asked, for Claude Code and for Codex, in the copy only. */
const markOnlyWhenAsked = (target: string) => {
  const skillFile = join(target, "SKILL.md");
  writeFileSync(skillFile, onlyWhenAskedSkillFile(readFileSync(skillFile, "utf8")));
  const codexFile = join(target, "agents", "openai.yaml");
  const stored = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : null;
  mkdirSync(join(target, "agents"), { recursive: true });
  writeFileSync(codexFile, onlyWhenAskedCodexFile(stored));
};

/** Copies one mount into the folder's `skills/<name>/`, marked Only when asked where it is. */
const copyMount = (skills: string, mount: SkillMount) => {
  // The name becomes a folder and a plugin skill's name, so it must be one the library allows.
  if (!SKILL_NAME.test(mount.name)) throw new Error(`${JSON.stringify(mount.name)} is not a skill name.`);
  assertNoLinks(mount.folder, mount.name);
  const target = join(skills, mount.name);
  cpSync(mount.folder, target, { recursive: true });
  if (mount.implicit) return;
  // The copy keeps the revision's modes, which are read-only, so only the copy is opened to be marked.
  setWritable(target, true);
  markOnlyWhenAsked(target);
};

/** Every `SKILL.md` under `folder`, as paths relative to it with `/` between folders. */
const skillFilesIn = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"));

/**
 * Copies one set into `sets/<set>/` as it is stored (ADR 029, Skill sets), so its skills' links to
 * its other files resolve, with a plugin manifest that names it and the folders its skills are in.
 * Only the mounted skills keep their `SKILL.md`, so a skill the hob turned off is listed by no runtime,
 * and each Only when asked one is marked in the copy.
 */
const copySet = (sets: string, name: string, mounts: ReadonlyArray<SkillMount>): MountedSet => {
  if (!SKILL_NAME.test(name) || name === SKILLS_PLUGIN) throw new Error(`${JSON.stringify(name)} is not a set name.`);
  const [first] = mounts;
  if (first === undefined) throw new Error(`The set ${name} has no skill to mount.`);
  if (mounts.some((mount) => mount.folder !== first.folder || mount.revision !== first.revision))
    throw new Error(`The skills of the set ${name} come from different revisions.`);
  const paths = mounts.map((mount) => {
    const path = mount.set?.path ?? "";
    if (!isSetPath(path)) throw new Error(`${JSON.stringify(path)} is not a folder inside the set ${name}.`);
    if (!SKILL_NAME.test(mount.name)) throw new Error(`${JSON.stringify(mount.name)} is not a skill name.`);
    return path;
  });
  assertNoLinks(first.folder, name);
  const target = join(sets, name);
  cpSync(first.folder, target, { recursive: true });
  setWritable(target, true);
  const kept = new Set(paths.map((path) => `${path}/SKILL.md`));
  for (const file of skillFilesIn(target)) if (!kept.has(file)) rmSync(join(target, ...file.split("/")));
  for (const mount of mounts) {
    if (!mount.implicit) markOnlyWhenAsked(join(target, ...(mount.set?.path ?? "").split("/")));
  }
  const folders = [...new Set(paths.map((path) => posix.dirname(path)))].sort();
  mkdirSync(join(target, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(target, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name, description: `The ${name} skills Hobbots gives this hob for this turn.`, skills: folders.map((folder) => (folder === "." ? "./" : `./${folder}`)) }, null, 2)}\n`,
  );
  return { name, folder: target };
};

/** A skill's folder inside its set: relative, with no `.` or `..` part. */
const isSetPath = (path: string): boolean =>
  path !== "" &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && ![...part].some(isUnsafeChar));

/** A backslash or a control character, which no folder of a set may hold. */
const isUnsafeChar = (char: string) => char === "\\" || (char.codePointAt(0) ?? 0) < 0x20;

/** The mounts of each set, by the set's name. */
const setsOf = (mounts: ReadonlyArray<SkillMount>): ReadonlyMap<string, ReadonlyArray<SkillMount>> => {
  const sets = new Map<string, Array<SkillMount>>();
  for (const mount of mounts) {
    if (mount.set) sets.set(mount.set.name, [...(sets.get(mount.set.name) ?? []), mount]);
  }
  return sets;
};

/**
 * Makes every file under `path` read-only, or writable again to change it. A file that can be run,
 * such as a skill's script, stays one: only its write bits change. Folders stay writable to their
 * owner either way, so a folder a stopped hub left behind is removed by a plain `rm -rf` of the data
 * folder (#1196); the sandbox, not the folder's mode, keeps a turn from writing in it.
 */
const setWritable = (path: string, writable: boolean) => {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) setWritable(join(path, entry), writable);
  } else if (stat.isFile()) {
    const runnable = (stat.mode & 0o111) !== 0;
    chmodSync(path, (writable ? 0o600 : 0o400) | (runnable ? 0o100 : 0));
  }
};

/** Removes a skill folder, or anything under it, including one an earlier hub sealed read-only. */
export const removeFolder = (path: string) => {
  if (!existsSync(path)) return;
  setWritable(path, true);
  rmSync(path, { recursive: true, force: true });
};

/** The plugin manifest Claude Code reads; it names the plugin and nothing else. */
const PLUGIN_MANIFEST = {
  name: SKILLS_PLUGIN,
  description: "The skills Hobbots gives this hob for this turn.",
};

/**
 * Writes the mounts' folder once (ADR 029): a plugin manifest and `skills/<name>/` copied from each
 * revision's files, then read-only. Written beside it and renamed into place, so no turn ever reads a
 * folder half written. A folder already there holds the same mounts and is kept as it is.
 */
export const writeSkillFolder = (base: string, mounts: ReadonlyArray<SkillMount>): SkillFolder => {
  const hash = skillMountsHash(mounts);
  const folder = join(base, SKILL_MOUNTS, hash);
  const sets = [...setsOf(mounts).keys()].sort().map((name) => ({ name, folder: join(folder, SETS, name) }));
  const result = { hash, folder, skills: join(folder, "skills"), sets };
  if (existsSync(folder)) return result;
  const draft = join(base, SKILL_MOUNTS, `.draft-${randomUUID()}`);
  try {
    mkdirSync(join(draft, ".claude-plugin"), { recursive: true, mode: 0o700 });
    writeFileSync(join(draft, ".claude-plugin", "plugin.json"), `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`);
    mkdirSync(join(draft, "skills"), { mode: 0o700 });
    for (const mount of mounts) if (!mount.set) copyMount(join(draft, "skills"), mount);
    if (sets.length > 0) mkdirSync(join(draft, SETS), { mode: 0o700 });
    for (const [name, members] of setsOf(mounts)) copySet(join(draft, SETS), name, members);
    setWritable(draft, false);
    if (!existsSync(folder)) renameSync(draft, folder);
  } finally {
    removeFolder(draft);
  }
  return result;
};

/** The sandbox's rule for a turn's skill folder: readable, never writable (ADR 029). */
export const skillFolderScope = (folder: SkillFolder | null): { readonly skillFolder?: string } =>
  folder ? { skillFolder: folder.folder } : {};

/** How many running turns hold each skill folder, by its path. */
const holders = new Map<string, number>();

/** Removes the folders in `base` that no turn holds, such as those a hub that stopped left behind. */
const sweep = (base: string, keep: string) => {
  const root = join(base, SKILL_MOUNTS);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (path !== keep && !holders.has(path)) removeFolder(path);
  }
};

/**
 * The turn's skill folder, held for as long as the turn's scope lasts (ADR 029): written when no turn
 * holds it, shared by overlapping turns with the same mounts, and removed once the last of them ends,
 * its follow-up turns included, since they run in the same scope. Null for a turn without skills.
 */
export const holdSkillFolder = (
  base: string,
  mounts: ReadonlyArray<SkillMount> | null | undefined,
): Effect.Effect<SkillFolder | null, RuntimeError, Scope.Scope> =>
  mounts === null || mounts === undefined || mounts.length === 0
    ? Effect.succeed(null)
    : Effect.acquireRelease(
        Effect.try({
          try: () => {
            const written = writeSkillFolder(base, mounts);
            holders.set(written.folder, (holders.get(written.folder) ?? 0) + 1);
            sweep(base, written.folder);
            return written;
          },
          catch: (error) =>
            new RuntimeError({
              message: `Could not give the hob its skills: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }),
        (written) =>
          Effect.sync(() => {
            const left = (holders.get(written.folder) ?? 1) - 1;
            if (left > 0) {
              holders.set(written.folder, left);
              return;
            }
            holders.delete(written.folder);
            try {
              removeFolder(written.folder);
            } catch {
              // The next turn's sweep removes what is left.
            }
          }),
      );
