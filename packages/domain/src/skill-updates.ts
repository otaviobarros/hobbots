import { Schema } from "effect";
import {
  SkillFileMode,
  SkillFilePath,
  SkillFlag,
  SkillId,
  SkillName,
  SkillRevisionHash,
  SkillSourceId,
} from "./skills.ts";

/**
 * Updates from a source (ADR 029, Updates from a source): a skill imported from Git is checked once a
 * day and on Check now, and an upstream change waits here, beside the library, until you accept it.
 * Nothing in the library changes on its own, except a skill you set to Update automatically, and even
 * then an update that raises a flag waits for you.
 */

/** How a file of the skill changes with the update. */
export const SkillUpdateFileChange = Schema.Literals(["added", "removed", "changed"]);
export type SkillUpdateFileChange = typeof SkillUpdateFileChange.Type;

/** A file the update adds, removes or changes, with its mode and size after it (before it, for a removed one). */
export const SkillUpdateFile = Schema.Struct({
  path: SkillFilePath,
  change: SkillUpdateFileChange,
  mode: SkillFileMode,
  size: Schema.Int,
});
export type SkillUpdateFile = typeof SkillUpdateFile.Type;

/**
 * A `SKILL.md` the update changes, with its text before and after: null before for a new one, null
 * after for one it removes. A set has one per skill it holds; a text too long to keep is cut and says so.
 */
export const SkillUpdateInstructions = Schema.Struct({
  path: SkillFilePath,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});
export type SkillUpdateInstructions = typeof SkillUpdateInstructions.Type;

/**
 * Where an update stands: `waiting` for you, or `dismissed` when you said Not now, which keeps that
 * upstream revision out of Updates until the source changes again.
 */
export const SkillUpdateState = Schema.Literals(["waiting", "dismissed"]);
export type SkillUpdateState = typeof SkillUpdateState.Type;

/**
 * An upstream revision of a skill the library does not have yet, with its review: the files it adds,
 * removes and changes against the skill's newest revision, each `SKILL.md` before and after, and the
 * flags it raises. A skill has at most one; a newer upstream change replaces it.
 */
export class SkillUpdate extends Schema.Class<SkillUpdate>("SkillUpdate")({
  skillId: SkillId,
  name: SkillName,
  sourceId: SkillSourceId,
  /** The skill's newest revision when the update was found, which accepting it moves on from. */
  base: SkillRevisionHash,
  baseNumber: Schema.Int,
  /** The upstream content, by hash: what accepting it adds, if the source still holds it. */
  hash: SkillRevisionHash,
  /** The commit it was read at. */
  commit: Schema.NullOr(Schema.String),
  /** A version the source carries, such as a plugin's version, shown as a label only. */
  label: Schema.NullOr(Schema.String),
  /** The skill's folder inside its source, or null for the source's root. */
  path: Schema.NullOr(Schema.String),
  files: Schema.Array(SkillUpdateFile),
  instructions: Schema.Array(SkillUpdateInstructions),
  /**
   * What deserves a careful look in what the update changes: a script it adds or changes, a URL the
   * skill did not have, or hidden text in a file it adds or changes. Any flag keeps it from applying
   * on its own, whatever the skill's setting.
   */
  flags: Schema.Array(SkillFlag),
  state: SkillUpdateState,
  foundAt: Schema.String,
}) {}

/** Whether an update may apply on its own, on a skill set to Update automatically: only one with no flag. */
export const skillUpdateIsClean = (update: Pick<SkillUpdate, "flags">): boolean => update.flags.length === 0;

/** A source the last check could not read, and why. */
export const SkillUpdateProblem = Schema.Struct({ sourceId: SkillSourceId, message: Schema.String });
export type SkillUpdateProblem = typeof SkillUpdateProblem.Type;

/** The last check of every Git source: when it ran, or null before the first, and the sources it could not read. */
export const SkillUpdateCheck = Schema.Struct({
  checkedAt: Schema.NullOr(Schema.String),
  problems: Schema.Array(SkillUpdateProblem),
});
export type SkillUpdateCheck = typeof SkillUpdateCheck.Type;

/** How often the hub checks Git sources on its own: once a day. */
export const SKILL_UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Whether a check is due at `now`: none ran yet, or the last one ran a day or more before. */
export const skillUpdateCheckDue = (check: SkillUpdateCheck, now: string): boolean =>
  check.checkedAt === null || Date.parse(now) - Date.parse(check.checkedAt) >= SKILL_UPDATE_CHECK_EVERY_MS;
