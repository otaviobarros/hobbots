import {
  AgentId,
  MemoryProjectIdentity,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillBy,
  SkillCheck,
  SkillDescription,
  SkillDropped,
  SkillFileMode,
  SkillFlag,
  SkillId,
  SkillName,
  SkillRevision,
  SkillRevisionHash,
  SkillScope,
  SkillSource,
  SkillUse,
  SkillUseCounts,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * The skills library (ADR 029, Import): list and read skills, see what a source holds, import from
 * a folder on the hub's computer, an archive or a Git repository, add a revision or edit one, read a
 * revision's files, and remove a skill nothing assigns. Then where each skill applies (#1061): assign
 * it to Everyone, a project or a hob, pinned to a revision; hold an assignment, roll one out or back;
 * and turn a skill off for one hob.
 */

/** There is no such skill, revision or folder in the source. */
export class SkillMissing extends Schema.TaggedError<SkillMissing>()(
  "SkillMissing",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** A skill broke an import check; nothing was written. */
export class SkillImportRefused extends Schema.TaggedError<SkillImportRefused>()(
  "SkillImportRefused",
  { check: SkillCheck, path: Schema.NullOr(Schema.String), message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The source could not be read: no such folder, not an archive, or a fetch that failed. */
export class SkillSourceNotRead extends Schema.TaggedError<SkillSourceNotRead>()(
  "SkillSourceNotRead",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** A new skill names one the library has, or a revision names another skill than its own. */
export class SkillNameConflict extends Schema.TaggedError<SkillNameConflict>()(
  "SkillNameConflict",
  { name: SkillName, skillId: SkillId },
  { httpApiStatus: 409 },
) {}

/** An edit made from a revision that is no longer the skill's newest; `latest` is. Nothing was saved. */
export class SkillEditStale extends Schema.TaggedError<SkillEditStale>()(
  "SkillEditStale",
  { skillId: SkillId, latest: SkillRevisionHash },
  { httpApiStatus: 409 },
) {}

/** The source changed since it was scanned; scan it again to see what it holds now. Nothing was written. */
export class SkillScanOutdated extends Schema.TaggedError<SkillScanOutdated>()(
  "SkillScanOutdated",
  { folder: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Something still assigns the skill, so it stays; `assignments` says who uses it. */
export class SkillStillAssigned extends Schema.TaggedError<SkillStillAssigned>()(
  "SkillStillAssigned",
  { skillId: SkillId, assignments: Schema.Array(SkillAssignment) },
  { httpApiStatus: 409 },
) {}

/** The most an archive may be, as base64 text: 50 MB of archive. */
const ARCHIVE_BASE64_MAX = Math.ceil((50 * 1024 * 1024) / 3) * 4;

/** What to import from. A folder is a path on the hub's computer; an archive comes in the request. */
export const SkillSourcePayload = Schema.Union([
  Schema.TaggedStruct("Folder", { path: Schema.String.check(Schema.isNonEmpty()) }),
  Schema.TaggedStruct("Archive", {
    fileName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
    base64: Schema.String.check(Schema.isBase64(), Schema.isMaxLength(ARCHIVE_BASE64_MAX)),
  }),
  Schema.TaggedStruct("Git", {
    url: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    ref: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255))),
  }),
  /** Written in Hobbots: each file's path in the skill and its text, `SKILL.md` among them. */
  Schema.TaggedStruct("Written", {
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
    ),
  }),
]);
export type SkillSourcePayload = typeof SkillSourcePayload.Type;

/** One skill a source holds, as import would take it, or the rule it broke. */
export const SkillCandidate = Schema.Struct({
  folder: Schema.String,
  name: Schema.NullOr(SkillName),
  description: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(SkillRevisionHash),
  flags: Schema.Array(SkillFlag),
  dropped: Schema.Array(SkillDropped),
  charms: Schema.Array(Schema.String),
  label: Schema.NullOr(Schema.String),
  refusal: Schema.NullOr(
    Schema.Struct({ check: SkillCheck, path: Schema.NullOr(Schema.String), message: Schema.String }),
  ),
  locked: Schema.NullOr(Schema.Struct({ matches: Schema.Boolean, url: Schema.NullOr(Schema.String) })),
  existing: Schema.NullOr(Schema.Struct({ skillId: SkillId, number: Schema.NullOr(Schema.Int) })),
});
export type SkillCandidate = typeof SkillCandidate.Type;

export const SkillScan = Schema.Struct({
  commit: Schema.NullOr(Schema.String),
  candidates: Schema.Array(SkillCandidate),
});
export type SkillScan = typeof SkillScan.Type;

export const ImportSkillsPayload = Schema.Struct({
  source: SkillSourcePayload,
  /** The folders to take, from a scan; every one when absent. */
  folders: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What the scan found in each folder taken: the import fails with `SkillScanOutdated` when the source
   * now holds anything else, such as a branch that moved on since you looked.
   */
  scanned: Schema.optionalKey(Schema.Array(Schema.Struct({ folder: Schema.String, hash: SkillRevisionHash }))),
});

export const ReviseSkillPayload = Schema.Struct({
  source: SkillSourcePayload,
  /** The folder in the source to take the revision from, when it holds more than one skill. */
  folder: Schema.optionalKey(Schema.String),
});

/** A revision import added, or found the library already had. */
export const ImportedSkill = Schema.Struct({ skill: Skill, revision: SkillRevision, added: Schema.Boolean });

/**
 * A revision you added, and the assignments it rolled out to: every one of the skill that is not held
 * (ADR 029, Pins and rollout). None when the skill already had that content.
 */
export const RevisedSkill = Schema.Struct({
  ...ImportedSkill.fields,
  rolledOut: Schema.Array(SkillAssignment),
});
export type RevisedSkill = typeof RevisedSkill.Type;

/** Assigns a skill to a scope, or changes its assignment there. The pin is the newest revision when absent. */
export const AssignSkillPayload = Schema.Struct({
  scope: SkillScope,
  pin: Schema.optionalKey(SkillRevisionHash),
  held: Schema.optionalKey(Schema.Boolean),
  onlyWhenAsked: Schema.optionalKey(Schema.Boolean),
});

/** Moves assignments to a revision of their skill: a rollout to a newer one, or a rollback to an older one. */
export const RollOutPayload = Schema.Struct({ pin: SkillRevisionHash });

/** What a rollout moved; an assignment already on the revision is left as it is. */
export const RolledOut = Schema.Struct({ rolledOut: Schema.Array(SkillAssignment) });

/** A skill a hob loads, as its profile shows it. */
export const HobSkill = Schema.Struct({
  skillId: SkillId,
  name: SkillName,
  pin: SkillRevisionHash,
  scope: SkillScope,
  onlyWhenAsked: Schema.Boolean,
  /** The Charms it names that the hob does not have: shown as "Needs the GitHub Charm". */
  missingCharms: Schema.Array(Schema.String),
});
export type HobSkill = typeof HobSkill.Type;

/**
 * A hob's skills as its next turn would get them, in the folders it works in now: the ones it loads,
 * the wider ones a narrower one replaced, names two projects both define (a warning, and neither
 * loads), and the skills it turned off.
 */
export const HobSkills = Schema.Struct({
  agentId: AgentId,
  skills: Schema.Array(HobSkill),
  replaced: Schema.Array(Schema.Struct({ assignment: SkillAssignment, by: SkillAssignment })),
  clashes: Schema.Array(Schema.Struct({ name: SkillName, assignments: Schema.Array(SkillAssignment) })),
  optedOut: Schema.Array(SkillId),
  /** The projects it works in now, whose skills it gets: an opted-out project skill shows under its project. */
  projects: Schema.Array(MemoryProjectIdentity),
  /** The skills it used last, each once, the most recent first (ADR 029, The use line). */
  lastUsed: Schema.Array(SkillUse),
});
export type HobSkills = typeof HobSkills.Type;

/** What a change in What changed was (ADR 029, The Skills page). */
export const SkillChangeKind = Schema.Literals([
  "saved",
  "rolledOut",
  "assigned",
  "unassigned",
  "held",
  "followed",
  "optedOut",
  "optedIn",
  "removed",
]);
export type SkillChangeKind = typeof SkillChangeKind.Type;

/**
 * One change to the library, as What changed lists it: a revision saved with the places its rollout
 * moved and held, a rollout or rollback, a skill given or taken away, a place held or let follow again,
 * a hob turning a shared skill off or on, or a skill removed.
 */
export const SkillChange = Schema.Struct({
  at: Schema.String,
  kind: SkillChangeKind,
  skillId: SkillId,
  name: SkillName,
  /** The revision it is about, which the line shows as r4, when the hub still knows it. */
  number: Schema.NullOr(Schema.Int),
  /** The places it moved, gave, took or held: for a save, the ones its rollout moved. */
  scopes: Schema.Array(SkillScope),
  /** The places a save kept on their revision. */
  held: Schema.Array(SkillScope),
  /** The assignments a save or rollout moved, each with the revision it was on, where Roll back takes it. */
  moved: Schema.Array(Schema.Struct({ assignmentId: SkillAssignmentId, from: SkillRevisionHash })),
  /** The revision every moved place was on, or null when they were on different ones or none moved. */
  previous: Schema.NullOr(SkillRevisionHash),
  previousNumber: Schema.NullOr(Schema.Int),
  /** The hob that turned a skill off or on for itself. */
  agentId: Schema.NullOr(AgentId),
  by: Schema.NullOr(SkillBy),
});
export type SkillChange = typeof SkillChange.Type;

export const SkillChanges = Schema.Struct({ changes: Schema.Array(SkillChange) });

export const ImportedSkills = Schema.Struct({ imported: Schema.Array(ImportedSkill) });

/** A skill in `~/.agents/skills` the hub did not take, and why; `folder` is "" when the folder itself could not be read. */
export const AgentsFolderProblem = Schema.Struct({
  folder: Schema.String,
  check: Schema.NullOr(SkillCheck),
  message: Schema.String,
});

export const SkillsList = Schema.Struct({
  skills: Schema.Array(Skill),
  sources: Schema.Array(SkillSource),
  /** Every assignment, of every skill: where each one applies, as the Skills page groups them. */
  assignments: Schema.Array(SkillAssignment),
  /** The projects a skill can be given to: those hobs work in now, and those the library already gives skills to. */
  projects: Schema.Array(MemoryProjectIdentity),
  agentsFolder: Schema.Struct({ path: Schema.NullOr(Schema.String), problems: Schema.Array(AgentsFolderProblem) }),
  /** How often hobs used each skill in the last seven days; a skill nobody used is left out. */
  usesThisWeek: Schema.Array(Schema.Struct({ skillId: SkillId, count: Schema.Int })),
});
export type SkillsList = typeof SkillsList.Type;

export const SkillDetail = Schema.Struct({
  skill: Skill,
  /** Newest first. */
  revisions: Schema.Array(SkillRevision),
  assignments: Schema.Array(SkillAssignment),
});
export type SkillDetail = typeof SkillDetail.Type;

/** A revision with its `SKILL.md`, as the skill's Instructions show it. */
export const SkillRevisionDetail = Schema.Struct({ revision: SkillRevision, instructions: Schema.String });

/** The most of a file the skill's page shows, in bytes; a longer one is listed without its text. */
export const SKILL_FILE_SHOWN_MAX = 512 * 1024;

/** One file of a revision, read-only: its text, or null when it is not text or is too long to show. */
export const SkillFileRead = Schema.Struct({
  path: Schema.String,
  mode: SkillFileMode,
  size: Schema.Int,
  text: Schema.NullOr(Schema.String),
});
export type SkillFileRead = typeof SkillFileRead.Type;

/**
 * An edit in Hobbots: a new revision from `base` with another description and instructions, its
 * name and every other file kept.
 */
export const EditSkillPayload = Schema.Struct({
  base: SkillRevisionHash,
  description: SkillDescription,
  /** The `SKILL.md` text after its front matter. */
  instructions: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
  /**
   * The holds you switched along with the edit. They are set by the edit's own rollout, in its
   * transaction: never by an edit that is refused, and never again by the same save sent after its
   * rollout ran, so a Keep on made since stays.
   */
  holds: Schema.optionalKey(Schema.Array(Schema.Struct({ assignmentId: SkillAssignmentId, held: Schema.Boolean }))),
});

const skillParams = { skillId: SkillId };
const assignmentParams = { assignmentId: SkillAssignmentId };
const hobParams = { agentId: AgentId };
const importErrors = [
  SkillImportRefused,
  SkillSourceNotRead,
  SkillMissing,
  SkillNameConflict,
  SkillEditStale,
  SkillScanOutdated,
];

export class SkillsGroup extends HttpApiGroup.make("skills")
  .add(HttpApiEndpoint.get("list", "/skills", { success: SkillsList }))
  .add(
    HttpApiEndpoint.get("get", "/skills/:skillId", { params: skillParams, success: SkillDetail, error: SkillMissing }),
  )
  .add(
    HttpApiEndpoint.get("revision", "/skills/:skillId/revisions/:hash", {
      params: { ...skillParams, hash: SkillRevisionHash },
      success: SkillRevisionDetail,
      error: SkillMissing,
    }),
  )
  .add(
    HttpApiEndpoint.get("file", "/skills/:skillId/revisions/:hash/file", {
      params: { ...skillParams, hash: SkillRevisionHash },
      query: { path: Schema.String },
      success: SkillFileRead,
      error: SkillMissing,
    }),
  )
  .add(
    // What a source holds, checked, writing nothing: a repository with many skills lists them to pick from.
    HttpApiEndpoint.post("scan", "/skills/scan", {
      payload: Schema.Struct({ source: SkillSourcePayload }),
      success: SkillScan,
      error: SkillSourceNotRead,
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/skills", {
      payload: ImportSkillsPayload,
      success: ImportedSkills,
      error: importErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("revise", "/skills/:skillId/revisions", {
      params: skillParams,
      payload: ReviseSkillPayload,
      success: RevisedSkill,
      error: importErrors,
    }),
  )
  .add(
    // Rolls a revision out to every assignment of the skill that is not held.
    HttpApiEndpoint.post("rollOut", "/skills/:skillId/roll-out", {
      params: skillParams,
      payload: RollOutPayload,
      success: RolledOut,
      error: SkillMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("assign", "/skills/:skillId/assignments", {
      params: skillParams,
      payload: AssignSkillPayload,
      success: SkillAssignment,
      error: SkillMissing,
    }),
  )
  .add(
    // Rolls one assignment to a revision, a held one included: Roll back, or moving a held one on.
    HttpApiEndpoint.post("rollOutAssignment", "/skills/assignments/:assignmentId/roll-out", {
      params: assignmentParams,
      payload: RollOutPayload,
      success: SkillAssignment,
      error: SkillMissing,
    }),
  )
  .add(
    // Keep on rN, or follow rollouts again.
    HttpApiEndpoint.post("hold", "/skills/assignments/:assignmentId/hold", {
      params: assignmentParams,
      payload: Schema.Struct({ held: Schema.Boolean }),
      success: SkillAssignment,
      error: SkillMissing,
    }),
  )
  .add(
    HttpApiEndpoint.delete("unassign", "/skills/assignments/:assignmentId", {
      params: assignmentParams,
      success: SkillAssignment,
      error: SkillMissing,
    }),
  )
  .add(
    HttpApiEndpoint.get("hob", "/skills/hobs/:agentId", {
      params: hobParams,
      success: HobSkills,
      error: SkillMissing,
    }),
  )
  .add(
    // Turns an Everyone or Project skill off for one hob, or on again.
    HttpApiEndpoint.put("optOut", "/skills/hobs/:agentId/opt-outs/:skillId", {
      params: { ...hobParams, ...skillParams },
      payload: Schema.Struct({ optedOut: Schema.Boolean }),
      success: HobSkills,
      error: SkillMissing,
    }),
  )
  .add(
    HttpApiEndpoint.post("edit", "/skills/:skillId/edits", {
      params: skillParams,
      payload: EditSkillPayload,
      success: RevisedSkill,
      error: importErrors,
    }),
  )
  .add(
    // What changed: the latest changes to the library, newest first, from the journal.
    HttpApiEndpoint.get("changes", "/skills/changes", { success: SkillChanges }),
  )
  .add(
    // How often hobs used a skill, per hob and per thread, as its Activity counts them.
    HttpApiEndpoint.get("uses", "/skills/:skillId/uses", {
      params: skillParams,
      success: SkillUseCounts,
      error: SkillMissing,
    }),
  )
  .add(
    // Re-reads `~/.agents/skills` now.
    HttpApiEndpoint.post("syncAgentsFolder", "/skills/agents-folder/sync", { success: SkillsList }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/skills/:skillId", {
      params: skillParams,
      success: Skill,
      error: [SkillMissing, SkillStillAssigned],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
