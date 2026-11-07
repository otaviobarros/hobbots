import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SkillLibrary } from "@hobbots/agents";
import {
  type AgentId,
  type SkillAssignment,
  SkillDropped,
  type SkillId,
  SkillName,
  SkillOrigin,
  type SkillRevision,
  SkillRevisionHash,
  SkillScope,
  type SkillSource,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import { SkillObjects } from "./store.ts";

/**
 * An export of skills (ADR 029, Backups, exports and Diagnostics): a folder with each skill's newest
 * revision in `<name>/`, any older revision an exported assignment pins in `.revisions/<name>/r<n>/`,
 * and `skills.lock.json`, which names each skill's source, revisions and assignments. Import on
 * another hub reads the lock, so it gets exactly the same revisions, and the same assignments where
 * it has those hobs and projects.
 */

/** The lock file at the top of an export. */
export const SKILLS_LOCK_FILE = "skills.lock.json";

/** Where an export keeps the older revisions an assignment pins, beside each skill's newest one. */
export const OLDER_REVISIONS = ".revisions";

/** One revision an export holds, in `folder`. */
const LockedRevision = Schema.Struct({
  hash: SkillRevisionHash,
  /** Its number on the hub that exported it, which import keeps in order, not as is. */
  number: Schema.Int,
  folder: Schema.String,
  commit: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  /** What the revision records that its files no longer show, kept as an edit keeps it. */
  charms: Schema.Array(Schema.String),
  dropped: Schema.Array(SkillDropped),
});
export type LockedRevision = typeof LockedRevision.Type;

/** An assignment as exported. A hob's carries the hob's name, so a hub that knows it by name finds it. */
const LockedAssignment = Schema.Struct({
  scope: SkillScope,
  hob: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  pin: SkillRevisionHash,
  held: Schema.Boolean,
  onlyWhenAsked: Schema.Boolean,
});
export type LockedAssignment = typeof LockedAssignment.Type;

const LockedSkill = Schema.Struct({
  name: SkillName,
  /** Where its revisions came from; null for a skill written in Hobbots. */
  source: Schema.NullOr(SkillOrigin),
  /** The newest revision, whose files are in `<name>/`. */
  revision: SkillRevisionHash,
  /** Every revision the export holds, the newest among them, oldest first. */
  revisions: Schema.Array(LockedRevision),
  /** Empty when the export left out who gets each skill. */
  assignments: Schema.Array(LockedAssignment),
});
export type LockedSkill = typeof LockedSkill.Type;

export const SkillsLock = Schema.Struct({
  format: Schema.Literal("hobbots.skills"),
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  skills: Schema.Array(LockedSkill),
});
export type SkillsLock = typeof SkillsLock.Type;

const encodeLock = Schema.encodeSync(SkillsLock);
export const decodeSkillsLock = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsLock));

/** What to export. */
export interface SkillExportOptions {
  /** The skills to export; every skill in the library when absent. */
  readonly skillIds?: ReadonlyArray<SkillId>;
  /** Whether to keep who gets each skill: Everyone, project and hob assignments, held ones included. */
  readonly assignments: boolean;
  /** A hob's name, for its assignments; null for a hob the hub no longer has. */
  readonly hobName: (agentId: AgentId) => string | null;
  readonly exportedAt: string;
}

/** A skill's source, as the library records it. */
const sourceOf = (sourceId: SkillSource["id"] | null, sources: ReadonlyArray<SkillSource>): SkillOrigin | null =>
  sources.find((source) => source.id === sourceId)?.origin ?? null;

/** The hob an assignment names, by name, so another hub can find it; null for any other scope, or a hob that is gone. */
const hobOf = (assignment: SkillAssignment, hobName: SkillExportOptions["hobName"]) => {
  if (assignment.scope._tag !== "Hob") return null;
  const name = hobName(assignment.scope.agentId);
  return name === null ? null : { name };
};

/** The revisions an export of a skill holds: its newest, and any other one an exported assignment pins. */
const revisionsToExport = (
  revisions: ReadonlyArray<SkillRevision>,
  assignments: ReadonlyArray<SkillAssignment>,
): ReadonlyArray<SkillRevision> => {
  const pins = new Set(assignments.map((one) => one.pin));
  const [newest] = revisions;
  return revisions.filter((revision) => revision === newest || pins.has(revision.hash)).reverse();
};

/** Copies a revision's files into `target`, owner-only; a file that runs stays one, since its hash covers that. */
const copyRevision = async (from: string, target: string, revision: SkillRevision) => {
  for (const file of revision.files) {
    const into = join(target, ...file.path.split("/"));
    await mkdir(dirname(into), { recursive: true, mode: 0o700 });
    await writeFile(into, await readFile(join(from, ...file.path.split("/"))), { flag: "wx" });
    await chmod(into, file.mode === "executable" ? 0o700 : 0o600);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
};

/**
 * Writes an export into `folder`, which must be new and empty: each skill's revisions and the lock.
 * Answers how many skills it holds. A skill whose files the hub no longer has is left out, and so is
 * a skill that is not in the library.
 */
export const writeSkillExport = (folder: string, options: SkillExportOptions) =>
  Effect.gen(function* () {
    const library = yield* SkillLibrary;
    const objects = yield* SkillObjects;
    const sources = yield* library.sources;
    const wanted = options.skillIds === undefined ? null : new Set(options.skillIds);
    const skills = (yield* library.list).filter((skill) => wanted === null || wanted.has(skill.id));
    const locked: Array<LockedSkill> = [];
    for (const skill of skills) {
      const assignments = options.assignments ? yield* library.assignments(skill.id) : [];
      const exported: Array<LockedRevision> = [];
      for (const revision of revisionsToExport(yield* library.revisions(skill.id), assignments)) {
        const from = yield* objects.folder(revision.hash);
        if (from === null) continue;
        const relative =
          revision.hash === skill.latest ? skill.name : `${OLDER_REVISIONS}/${skill.name}/r${revision.number}`;
        yield* Effect.promise(() => copyRevision(from, join(folder, ...relative.split("/")), revision));
        exported.push({
          hash: revision.hash,
          number: revision.number,
          folder: relative,
          commit: revision.commit,
          path: revision.path,
          label: revision.label,
          charms: revision.charms,
          dropped: revision.dropped,
        });
      }
      if (!exported.some((revision) => revision.hash === skill.latest)) continue;
      const kept = new Set(exported.map((revision) => revision.hash));
      locked.push({
        name: skill.name,
        source: sourceOf(skill.sourceId, sources),
        revision: skill.latest,
        revisions: exported,
        assignments: assignments
          .filter((one) => kept.has(one.pin))
          .map((one) => ({
            scope: one.scope,
            hob: hobOf(one, options.hobName),
            pin: one.pin,
            held: one.held,
            onlyWhenAsked: one.onlyWhenAsked,
          })),
      });
    }
    const lock: SkillsLock = { format: "hobbots.skills", version: 1, exportedAt: options.exportedAt, skills: locked };
    yield* Effect.promise(() =>
      writeFile(join(folder, SKILLS_LOCK_FILE), `${JSON.stringify(encodeLock(lock), null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      }),
    );
    return { skills: locked.length };
  });
