import {
  MemoryProjectIdentity,
  SkillAssignment,
  SkillId,
  SkillName,
  SkillRepository,
  SkillRevisionHash,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ImportedSkill, importErrors, SkillMissing, SkillScan, SkillSourceNotRead } from "./skills.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * A repository's own skills (ADR 029, Scopes, #1098): the repositories hobs work in that hold skills in
 * `.claude/skills` or `.agents/skills`, offered once per project. An import reads them from the
 * repository's default branch, never from the clone, adds them to the library like any skill from Git,
 * and gives them to that project. Only a user session decides.
 */

/** Every repository hobs work in now that holds skills of its own, and whether each is still offered. */
export const SkillRepositoriesView = Schema.Struct({ repositories: Schema.Array(SkillRepository) });
export type SkillRepositoriesView = typeof SkillRepositoriesView.Type;

const projectPayload = Schema.Struct({ project: MemoryProjectIdentity });

/** What the repository's default branch holds in those folders, as a scan of it found. */
export const SkillRepositoryScan = Schema.Struct({ repository: SkillRepository, scan: SkillScan });
export type SkillRepositoryScan = typeof SkillRepositoryScan.Type;

/**
 * What importing a repository's skills added, and the project assignments it made or moved. `elsewhere`
 * names a skill whose content another source brought into the library while the import ran: it is
 * that source's skill, so the project was not given it.
 */
export const SkillRepositoryImported = Schema.Struct({
  imported: Schema.Array(ImportedSkill),
  assigned: Schema.Array(SkillAssignment),
  elsewhere: Schema.Array(Schema.Struct({ name: SkillName, skillId: SkillId })),
});
export type SkillRepositoryImported = typeof SkillRepositoryImported.Type;

export class SkillRepositoriesGroup extends HttpApiGroup.make("skillRepositories")
  .add(HttpApiEndpoint.get("list", "/skill-repositories", { success: SkillRepositoriesView }))
  .add(
    // Reads the project's repository at its default branch, writing nothing.
    HttpApiEndpoint.post("scan", "/skill-repositories/scan", {
      payload: projectPayload,
      success: SkillRepositoryScan,
      error: [SkillMissing, SkillSourceNotRead],
    }),
  )
  .add(
    // Imports the skills picked from a scan, bound to what it found, and gives each to the project.
    HttpApiEndpoint.post("import", "/skill-repositories/import", {
      payload: Schema.Struct({
        project: MemoryProjectIdentity,
        scanned: Schema.Array(Schema.Struct({ folder: Schema.String, hash: SkillRevisionHash })).check(
          Schema.isMinLength(1),
        ),
      }),
      success: SkillRepositoryImported,
      error: importErrors,
    }),
  )
  .add(
    // Not now: the offer goes until the repository holds a skill it does not hold now.
    HttpApiEndpoint.post("dismiss", "/skill-repositories/dismiss", {
      payload: projectPayload,
      success: SkillRepositoriesView,
      error: SkillMissing,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
