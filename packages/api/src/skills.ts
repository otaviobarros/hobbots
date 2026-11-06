import {
  Skill,
  SkillAssignment,
  SkillCheck,
  SkillDropped,
  SkillFlag,
  SkillId,
  SkillName,
  SkillRevision,
  SkillRevisionHash,
  SkillSource,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * The skills library (ADR 029, Import): list and read skills, see what a source holds, import from
 * a folder on the hub's computer, an archive or a Git repository, add a revision, and remove a skill
 * nothing assigns. Assignments and rollouts have their own routes later (#1061, #1062).
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
});

export const ReviseSkillPayload = Schema.Struct({
  source: SkillSourcePayload,
  /** The folder in the source to take the revision from, when it holds more than one skill. */
  folder: Schema.optionalKey(Schema.String),
});

/** A revision import added, or found the library already had. */
export const ImportedSkill = Schema.Struct({ skill: Skill, revision: SkillRevision, added: Schema.Boolean });

export const ImportedSkills = Schema.Struct({ imported: Schema.Array(ImportedSkill) });

/** A skill in `~/.agents/skills` the hub did not take, and why. */
export const AgentsFolderProblem = Schema.Struct({
  folder: Schema.String,
  check: Schema.NullOr(SkillCheck),
  message: Schema.String,
});

export const SkillsList = Schema.Struct({
  skills: Schema.Array(Skill),
  sources: Schema.Array(SkillSource),
  agentsFolder: Schema.Struct({ path: Schema.NullOr(Schema.String), problems: Schema.Array(AgentsFolderProblem) }),
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

const skillParams = { skillId: SkillId };
const importErrors = [SkillImportRefused, SkillSourceNotRead, SkillMissing, SkillNameConflict];

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
      success: ImportedSkill,
      error: importErrors,
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
