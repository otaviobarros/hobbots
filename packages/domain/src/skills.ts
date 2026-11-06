import { Effect, Schema } from "effect";
import { AgentId } from "./ids.ts";
import { MemoryScope } from "./memory.ts";
import { Revision } from "./revision.ts";

/**
 * Skills in Hobbots' own words (ADR 029). A skill is a folder with a `SKILL.md` and the files it
 * refers to; the library keeps each one once, as immutable revisions, and an assignment says where
 * it applies. No runtime, Charm or file layout shows in these types.
 */

/**
 * A skill's name, as its `SKILL.md` front matter gives it: lower-case letters, digits and single
 * hyphens, never at the start or the end, at most 64 characters. Unique in the library.
 */
export const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "A skill name is lower-case letters, digits and single hyphens, not at the start or the end.",
  }),
  Schema.isMaxLength(64),
).pipe(Schema.brand("SkillName"));
export type SkillName = typeof SkillName.Type;

/** The most a skill's description may hold, in characters. */
export const SKILL_DESCRIPTION_MAX = 1024;

/** What a skill is for, as the model sees it before it reads the rest: at most 1,024 characters. */
export const SkillDescription = Schema.String.check(
  Schema.isNonEmpty({ message: "A skill needs a description." }),
  Schema.isMaxLength(SKILL_DESCRIPTION_MAX, {
    message: `A skill's description is at most ${SKILL_DESCRIPTION_MAX} characters.`,
  }),
);

/** A skill in the library, which keeps its id across revisions and renames of its source. */
export const SkillId = Schema.String.pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

/**
 * A revision of a skill: the SHA-256, in lower-case hex, of a canonical listing of its files. The same
 * content always has the same hash, so importing it again finds the revision it already is.
 */
export const SkillRevisionHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, { message: "A skill revision is a SHA-256 in lower-case hex." }),
).pipe(Schema.brand("SkillRevisionHash"));
export type SkillRevisionHash = typeof SkillRevisionHash.Type;

/** A place a skill comes from, recorded once and shared by the skills it holds. */
export const SkillSourceId = Schema.String.pipe(Schema.brand("SkillSourceId"));
export type SkillSourceId = typeof SkillSourceId.Type;

/** An assignment of a skill to a scope. */
export const SkillAssignmentId = Schema.String.pipe(Schema.brand("SkillAssignmentId"));
export type SkillAssignmentId = typeof SkillAssignmentId.Type;

/** Where a skill applies: every hob, any hob in a project's folders, or one hob. Memory's scopes. */
export const SkillScope = MemoryScope;
export type SkillScope = MemoryScope;

/**
 * The front matter of a `SKILL.md`, as far as Hobbots reads it. Other keys are kept in the file and
 * ignored. `allowed-tools` is read only so that import can drop it: a skill grants nothing.
 */
export const SkillFrontMatter = Schema.Struct({
  name: SkillName,
  description: SkillDescription,
  license: Schema.optionalKey(Schema.String),
  compatibility: Schema.optionalKey(Schema.String),
  "allowed-tools": Schema.optionalKey(Schema.Unknown),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type SkillFrontMatter = typeof SkillFrontMatter.Type;

const CharmNeeds = Schema.Struct({ hobbots: Schema.Struct({ charms: Schema.Array(Schema.String) }) });
const decodeCharmNeeds = Schema.decodeUnknownOption(CharmNeeds);

/** The Charms a skill says it needs, from `metadata.hobbots.charms`; none when it names none. */
export const skillCharmsOf = (frontMatter: SkillFrontMatter): ReadonlyArray<string> => {
  const needs = decodeCharmNeeds(frontMatter.metadata ?? {});
  return needs._tag === "Some" ? [...new Set(needs.value.hobbots.charms)].sort() : [];
};

/** One part of a skill file's path: any name but `.` and `..`, with no slash, backslash or control character. */
const SKILL_PATH_PART = String.raw`(?!\.{1,2}(?:/|$))[^/\\\u0000-\u001f\u007f]+`;

/**
 * A file's place inside its skill: a relative path of folders and a name. Each part is checked on
 * its own, so no part is empty, `.` or `..`, and none holds a backslash, a line break or another
 * control character; there is no leading slash.
 */
export const SkillFilePath = Schema.String.check(
  Schema.isPattern(new RegExp(`^${SKILL_PATH_PART}(?:/${SKILL_PATH_PART})*$`), {
    message: "A skill file's path is relative, inside the skill, with no '.' or '..' part.",
  }),
  Schema.isMaxLength(400),
);

/** Whether a file runs: the only part of a file's mode a revision keeps. */
export const SkillFileMode = Schema.Literals(["regular", "executable"]);
export type SkillFileMode = typeof SkillFileMode.Type;

/** One file of a revision. */
export const SkillFile = Schema.Struct({
  path: SkillFilePath,
  mode: SkillFileMode,
  /** In bytes. */
  size: Schema.Int,
  /** The SHA-256 of its contents, in lower-case hex. */
  sha256: Schema.String,
});
export type SkillFile = typeof SkillFile.Type;

/**
 * What deserves a careful look before a skill loads (ADR 029, Import): a script, a URL, or text hidden
 * from view, such as a zero-width character. Shown on an import and on every update.
 */
export const SkillFlag = Schema.Union([
  Schema.TaggedStruct("Script", { path: SkillFilePath }),
  Schema.TaggedStruct("Url", { path: SkillFilePath, url: Schema.String }),
  /** `codePoint` is the first hidden character found, such as `U+200B`. */
  Schema.TaggedStruct("HiddenText", { path: SkillFilePath, codePoint: Schema.String }),
]);
export type SkillFlag = typeof SkillFlag.Type;

/**
 * What import left out of a skill because it would add authority: a Claude Code plugin's hooks,
 * commands, agents and MCP servers, `allowed-tools` in the front matter, and the tool dependencies of
 * Codex's `agents/openai.yaml`.
 */
export const SkillDroppedKind = Schema.Literals([
  "hooks",
  "commands",
  "agents",
  "mcp-servers",
  "allowed-tools",
  "tool-dependencies",
]);
export type SkillDroppedKind = typeof SkillDroppedKind.Type;

/** A note on something import dropped, with where it was in what you imported. */
export const SkillDropped = Schema.Struct({ kind: SkillDroppedKind, path: Schema.String });
export type SkillDropped = typeof SkillDropped.Type;

/**
 * Where a skill comes from. A folder or an archive is copied once and never followed; a Git source
 * is followed at `ref` (the default branch when null), and each revision records the commit it was
 * read at; `~/.agents/skills` is watched.
 */
export const SkillOrigin = Schema.Union([
  /** Written in Hobbots. */
  Schema.TaggedStruct("Written", {}),
  Schema.TaggedStruct("Folder", { path: Schema.String }),
  Schema.TaggedStruct("Archive", { fileName: Schema.String }),
  Schema.TaggedStruct("Git", { url: Schema.String, ref: Schema.NullOr(Schema.String) }),
  /** The shared `~/.agents/skills` folder, which the hub reads itself (ADR 029). */
  Schema.TaggedStruct("AgentsFolder", { path: Schema.String }),
]);
export type SkillOrigin = typeof SkillOrigin.Type;

/** A source as the library records it. */
export class SkillSource extends Schema.Class<SkillSource>("SkillSource")({
  id: SkillSourceId,
  origin: SkillOrigin,
  addedAt: Schema.String,
}) {}

/** Who changed the library or a pin: you, a hob whose proposal you approved, or a followed source. */
export const SkillBy = Schema.Union([
  Schema.TaggedStruct("You", {}),
  Schema.TaggedStruct("Hob", { agentId: AgentId }),
  Schema.TaggedStruct("Source", { sourceId: SkillSourceId }),
]);
export type SkillBy = typeof SkillBy.Type;

/** One immutable revision of a skill. Its files live once per hash and never change. */
export class SkillRevision extends Schema.Class<SkillRevision>("SkillRevision")({
  skillId: SkillId,
  hash: SkillRevisionHash,
  /** Its place in the skill's history, from 1: what the screens show as r1, r2, r3. */
  number: Schema.Int,
  name: SkillName,
  description: SkillDescription,
  /** The Charm ids the skill says it needs, sorted (`skillCharmsOf`). A hint, never a dependency. */
  charms: Schema.Array(Schema.String),
  files: Schema.Array(SkillFile),
  flags: Schema.Array(SkillFlag),
  dropped: Schema.Array(SkillDropped),
  /** The source it was read from, or null when it was written in Hobbots. */
  sourceId: Schema.NullOr(SkillSourceId),
  /** For a Git source, the commit it was read at. */
  commit: Schema.NullOr(Schema.String),
  /** The skill's folder inside its source, such as `skills/release`, or null for the source's root. */
  path: Schema.NullOr(Schema.String),
  /** A version the source carries (a tag, `metadata.version`, a plugin's version), shown as a label only. */
  label: Schema.NullOr(Schema.String),
  addedBy: SkillBy,
  addedAt: Schema.String,
  /**
   * When it was rolled out to every assignment of its skill that is not held, or null while that has
   * not finished (ADR 029, Pins and rollout). Saving it again finishes an interrupted rollout, and a
   * source that still holds it never rolls it out a second time, so a rollback stays.
   */
  rolledOutAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

/** A skill in the library. */
export class Skill extends Schema.Class<Skill>("Skill")({
  id: SkillId,
  name: SkillName,
  /** The newest revision's description. */
  description: SkillDescription,
  /** The newest revision. */
  latest: SkillRevisionHash,
  /** How many revisions it has, which is the newest one's number. */
  revisions: Schema.Int,
  /** Where its revisions come from, or null when it is written in Hobbots. */
  sourceId: Schema.NullOr(SkillSourceId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Revision,
}) {}

/**
 * A skill assigned to a scope, pinned to one revision. A change to the library never moves a pin by
 * itself: a rollout does, and an assignment that is `held` (Keep on r4) is left out of rollouts.
 */
export class SkillAssignment extends Schema.Class<SkillAssignment>("SkillAssignment")({
  id: SkillAssignmentId,
  skillId: SkillId,
  scope: SkillScope,
  pin: SkillRevisionHash,
  held: Schema.Boolean,
  /** Only when asked: the hob uses it when you pick it, never on its own. */
  onlyWhenAsked: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  by: SkillBy,
  assignedAt: Schema.String,
  revision: Revision,
}) {}

/**
 * A skill a turn was given, as recorded with its message (ADR 029, Pins and rollout): the revision
 * its assignment pinned when your message was accepted, so a queued message keeps it, and on the
 * reply what its latest turn used, so History shows which revision each reply had.
 */
export const TurnSkill = Schema.Struct({
  skillId: SkillId,
  name: SkillName,
  pin: SkillRevisionHash,
  onlyWhenAsked: Schema.Boolean,
});
export type TurnSkill = typeof TurnSkill.Type;

/** A hob that turned off an Everyone or Project skill for itself. A hob setting, so it survives updates. */
export const SkillOptOut = Schema.Struct({ agentId: AgentId, skillId: SkillId, at: Schema.String });
export type SkillOptOut = typeof SkillOptOut.Type;

/** A check every skill passes before import writes anything (ADR 029, Import). */
export const SkillCheck = Schema.Literals([
  "front-matter",
  "outside-path",
  "symlink",
  "too-large",
  "too-many-files",
  "unreadable",
]);
export type SkillCheck = typeof SkillCheck.Type;

/** The most a skill may hold: 5 MB in 200 files. */
export const SKILL_LIMITS = { bytes: 5 * 1024 * 1024, files: 200 } as const;

/** A skill import refused, naming the file and the rule it broke. Nothing was written. */
export class SkillRefused extends Schema.TaggedError<SkillRefused>()("SkillRefused", {
  check: SkillCheck,
  /** The file it is about, relative to what was imported, or null for the whole skill. */
  path: Schema.NullOr(Schema.String),
  message: Schema.String,
}) {}

/** A source could not be read: a folder that is not there, an archive that is not one, a Git fetch that failed. */
export class SkillSourceUnreadable extends Schema.TaggedError<SkillSourceUnreadable>()("SkillSourceUnreadable", {
  message: Schema.String,
}) {}

/** No skill, source or assignment with that id. */
export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()("SkillNotFound", {
  id: Schema.String,
}) {}

/** A new skill names a skill the library already has; revise that one instead. */
export class SkillNameTaken extends Schema.TaggedError<SkillNameTaken>()("SkillNameTaken", {
  name: SkillName,
  skillId: SkillId,
}) {}

/** A revision of a skill names another skill; a skill keeps its name across revisions. */
export class SkillNameChanged extends Schema.TaggedError<SkillNameChanged>()("SkillNameChanged", {
  skillId: SkillId,
  name: SkillName,
  given: SkillName,
}) {}

/** A skill something still assigns cannot be removed; `assignments` says who uses it. */
export class SkillInUse extends Schema.TaggedError<SkillInUse>()("SkillInUse", {
  skillId: SkillId,
  assignments: Schema.Array(SkillAssignment),
}) {}

/** The number a revision shows as, such as `r4`. */
export const skillRevisionLabel = (revision: { readonly number: number }): string => `r${revision.number}`;
