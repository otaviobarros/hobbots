import { Schema } from "effect";
import type { SkillTree } from "./tree.ts";

/**
 * The lock file of the `skills` CLI, `skills-lock.json` at the top of a project (version 1): for
 * each skill it installed, where it came from and the hash of the copy it installed. Import reads it
 * so a project that uses the CLI keeps its versions, and follows each skill's source from then on.
 */
const LockEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  skillPath: Schema.optionalKey(Schema.String),
  computedHash: Schema.String,
});

const LockFile = Schema.Struct({
  version: Schema.Literal(1),
  skills: Schema.Record(Schema.String, LockEntry),
});

const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockFile));

/** What the lock says about one skill. */
export interface LockedSkill {
  /** The Git repository it was installed from, or null for a source Hobbots does not follow. */
  readonly url: string | null;
  readonly ref: string | null;
  /** The skill's folder in that repository. */
  readonly path: string | null;
  readonly computedHash: string;
}

const LOCK_FILE = "skills-lock.json";

/** A GitHub `owner/repo`, as the CLI writes `source` for a GitHub skill. */
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

const urlOf = (entry: typeof LockEntry.Type): string | null => {
  if (entry.sourceUrl !== undefined && /^(?:https|ssh):\/\/|^git@/.test(entry.sourceUrl)) return entry.sourceUrl;
  if (entry.sourceType === "github" && GITHUB_REPOSITORY.test(entry.source))
    return `https://github.com/${entry.source}`;
  if (entry.sourceType === "git" && /^(?:https|ssh):\/\/|^git@/.test(entry.source)) return entry.source;
  return null;
};

/** The skills a source's `skills-lock.json` names, by name; empty when it has none or cannot be read. */
export const readLock = async (tree: SkillTree): Promise<ReadonlyMap<string, LockedSkill>> => {
  if (!tree.entries.some((entry) => entry.path === LOCK_FILE && entry.kind === "file")) return new Map();
  const lock = decodeLock(new TextDecoder().decode(await tree.read(LOCK_FILE)));
  if (lock._tag === "None") return new Map();
  return new Map(
    Object.entries(lock.value.skills).map(([name, entry]) => {
      const path = entry.skillPath?.replace(/\/?SKILL\.md$/, "") ?? null;
      return [
        name,
        {
          url: urlOf(entry),
          ref: entry.ref ?? null,
          path: path === "" ? null : path,
          computedHash: entry.computedHash,
        },
      ];
    }),
  );
};
