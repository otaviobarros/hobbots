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
import { join } from "node:path";
import { RuntimeError, type SkillMount } from "@hobbots/agents";
import { Effect, type Scope } from "effect";
import { Document, isMap, parseDocument } from "yaml";

/** The plugin a Claude Code turn loads its skills from, so each is listed as `hobbots-skills:<name>`. */
export const SKILLS_PLUGIN = "hobbots-skills";

/** The folder, inside a runtime folder, that holds the turns' skill folders (ADR 029). */
export const SKILL_MOUNTS = "skill-mounts";

/** A turn's skill folder: the plugin folder, and the `skills/` inside it that holds one folder per skill. */
export interface SkillFolder {
  /** The SHA-256 of the mounts, which names the folder. */
  readonly hash: string;
  /** The folder itself, which Claude Code loads as a plugin. */
  readonly folder: string;
  /** Its `skills/` folder, which Codex reads as an extra root. */
  readonly skills: string;
}

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
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((mount) => [mount.name, mount.revision, mount.implicit]),
      ),
    )
    .digest("hex");

/** The `---` front matter at the top of a `SKILL.md`, and the text after it. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * A `SKILL.md` that Claude Code never picks on its own (`disable-model-invocation: true`), from the
 * stored one. Its front matter is rewritten, the rest kept as it is.
 */
export const onlyWhenAskedSkillFile = (text: string): string => {
  const match = FRONT_MATTER.exec(text);
  const document = match ? parseDocument(match[1] as string) : new Document({});
  if (!isMap(document.contents)) document.contents = document.createNode({});
  document.set("disable-model-invocation", true);
  const body = match ? text.slice(match[0].length) : text;
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
  const skillFile = join(target, "SKILL.md");
  writeFileSync(skillFile, onlyWhenAskedSkillFile(readFileSync(skillFile, "utf8")));
  const codexFile = join(target, "agents", "openai.yaml");
  const stored = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : null;
  mkdirSync(join(target, "agents"), { recursive: true });
  writeFileSync(codexFile, onlyWhenAskedCodexFile(stored));
};

/**
 * Makes every file and folder under `path` read-only, or writable again to change or remove it. A
 * file that can be run, such as a skill's script, stays one: only its write bits change.
 */
const setWritable = (path: string, writable: boolean) => {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    if (writable) chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) setWritable(join(path, entry), writable);
    if (!writable) chmodSync(path, 0o500);
  } else if (stat.isFile()) {
    const runnable = (stat.mode & 0o111) !== 0;
    chmodSync(path, (writable ? 0o600 : 0o400) | (runnable ? 0o100 : 0));
  }
};

/** Removes a skill folder, or anything under it, read-only files included. */
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
  const result = { hash, folder, skills: join(folder, "skills") };
  if (existsSync(folder)) return result;
  const draft = join(base, SKILL_MOUNTS, `.draft-${randomUUID()}`);
  try {
    mkdirSync(join(draft, ".claude-plugin"), { recursive: true, mode: 0o700 });
    writeFileSync(join(draft, ".claude-plugin", "plugin.json"), `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`);
    mkdirSync(join(draft, "skills"), { mode: 0o700 });
    for (const mount of mounts) copyMount(join(draft, "skills"), mount);
    setWritable(draft, false);
    // Read-only folders can still be renamed: only their parent must be writable.
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
