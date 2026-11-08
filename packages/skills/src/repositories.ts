import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  announcer,
  EventPublisher,
  HobbotsRepository,
  MemoryProjects,
  PermissionSummary,
  RepositorySkillFinder,
  type SkillImportError,
  SkillLibrary,
  SkillRepositoryOffers,
  type SkillRevisionAdded,
} from "@hobbots/agents";
import {
  isRepositorySkill,
  type MemoryProjectIdentity,
  REPOSITORY_SKILL_ROOTS,
  repositoryOffered,
  type Skill,
  type SkillAssignment,
  type SkillBy,
  type SkillId,
  SkillNameTaken,
  SkillNotFound,
  type SkillRepository,
  type SkillRevisionHash,
  type SkillSourceUnreadable,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer } from "effect";
import { SkillImporter, type SkillImportSource, type SkillScan } from "./importer.ts";

/**
 * A repository's own skills (ADR 029, Scopes, #1098). A repository a hob works in that holds skills in
 * `.claude/skills` or `.agents/skills` is offered once per project. No hob loads them from the clone:
 * an import reads them from the repository's default branch, through its `origin`, as a Git source
 * like any other, so a branch or a pull request never changes what a hob loads, and a change on the
 * default branch shows as an update with its review. Each import is given to the project.
 */

/** A skill folder in a clone, listed with no link followed: not the root, its parent, nor the folder or its `SKILL.md`. */
const listed = async (checkout: string, root: string) => {
  for (const part of [root.split("/")[0] ?? root, root]) {
    const stat = await lstat(join(checkout, part)).catch(() => null);
    if (stat?.isDirectory() !== true) return [];
  }
  const found: Array<string> = [];
  const entries = await readdir(join(checkout, root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = await lstat(join(checkout, root, entry.name, "SKILL.md")).catch(() => null);
    if (file?.isFile() === true) found.push(`${root}/${entry.name}`);
  }
  return found;
};

/** Lists a clone's skill folders from its files; a symlink anywhere on the way is not followed. */
export const RepositorySkillFinderLive = Layer.succeed(RepositorySkillFinder, {
  folders: (checkout) =>
    Effect.promise(async () => {
      const found: Array<string> = [];
      for (const root of REPOSITORY_SKILL_ROOTS) found.push(...(await listed(checkout, root)));
      return found.sort();
    }),
});

/** What an import did: the skills it added and their assignments to the project. */
export interface SkillRepositoryImported {
  readonly imported: ReadonlyArray<SkillRevisionAdded>;
  readonly assigned: ReadonlyArray<SkillAssignment>;
}

export interface SkillRepositoriesShape {
  /** Every repository hobs that are not retired work in now with skills of its own, once per project. */
  readonly list: Effect.Effect<ReadonlyArray<SkillRepository>>;
  /** What the project's default branch holds: only its own skills, and a skill kept in both folders once. */
  readonly scan: (
    project: MemoryProjectIdentity,
  ) => Effect.Effect<
    { readonly repository: SkillRepository; readonly scan: SkillScan },
    SkillSourceUnreadable | SkillNotFound
  >;
  /**
   * Imports what a scan found, bound to its hashes, from the default branch, gives each skill to the
   * project and closes the offer. A skill is followed on the default branch even when the repository's
   * `skills-lock.json` says the `skills` CLI installed it from elsewhere. Content the library already
   * follows at another source is refused with `SkillNameTaken`, and nothing is given to the project.
   */
  readonly import: (
    project: MemoryProjectIdentity,
    scanned: ReadonlyArray<{ readonly folder: string; readonly hash: SkillRevisionHash }>,
  ) => Effect.Effect<SkillRepositoryImported, SkillImportError>;
  /** Not now: closes the offer until the repository holds a skill folder it does not hold now. */
  readonly dismiss: (project: MemoryProjectIdentity) => Effect.Effect<void, SkillNotFound>;
}

export class SkillRepositories extends Context.Service<SkillRepositories, SkillRepositoriesShape>()(
  "@hobbots/skills/SkillRepositories",
) {}

const YOU: SkillBy = { _tag: "You" };

/** The repository's default branch: what the import reads, and what its update checks follow. */
const sourceOf = (repository: SkillRepository): SkillImportSource => ({ _tag: "Git", url: repository.url, ref: null });

/** Only the repository's own skills, and one skill kept in both folders once. */
const ownCandidates = (scan: SkillScan): SkillScan => {
  const seen = new Set<string>();
  const candidates = scan.candidates.filter((one) => {
    if (!isRepositorySkill(one.folder)) return false;
    if (one.hash === null) return true;
    if (seen.has(one.hash)) return false;
    seen.add(one.hash);
    return true;
  });
  return { ...scan, candidates };
};

export const SkillRepositoriesLive = Layer.effect(
  SkillRepositories,
  Effect.gen(function* () {
    const library = yield* SkillLibrary;
    const importer = yield* SkillImporter;
    const offers = yield* SkillRepositoryOffers;
    const finder = yield* RepositorySkillFinder;
    const repo = yield* HobbotsRepository;
    const projects = yield* MemoryProjects;
    const permissions = yield* PermissionSummary;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a repository's skills");

    /**
     * The first clone that holds skills, of the first hob by name, for each project. A folder with no
     * `origin` is left out, since there is no default branch to read.
     */
    const list = Effect.gen(function* () {
      const hobs = [...(yield* repo.listAgentsWithStatus(["active", "paused"]))].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const closed = yield* offers.closed;
      const found = new Map<MemoryProjectIdentity, SkillRepository>();
      for (const hob of hobs) {
        for (const folder of (yield* permissions.of(hob)).folders) {
          const project = yield* projects.of(folder);
          if (found.has(project)) continue;
          const url = yield* projects.origin(folder);
          if (url === null) continue;
          const skills = yield* finder.folders(folder);
          if (skills.length === 0) continue;
          const offered = repositoryOffered(skills, closed.get(project) ?? null);
          found.set(project, { project, folder, url, agentId: hob.id, skills, offered });
        }
      }
      return [...found.values()].sort((a, b) => a.project.localeCompare(b.project));
    });

    const repositoryOf = (project: MemoryProjectIdentity) =>
      Effect.flatMap(list, (all) => {
        const one = all.find((repository) => repository.project === project);
        return one === undefined ? Effect.fail(new SkillNotFound({ id: project })) : Effect.succeed(one);
      });

    /** Closes the project's offer at the skill folders its repository holds now. */
    const close = (repository: SkillRepository) =>
      Effect.flatMap(DateTime.now, (now) =>
        offers.close(repository.project, repository.skills, DateTime.formatIso(now)),
      );

    /** Gives an imported skill to the project at the revision imported, keeping how it was given there before. */
    const giveToProject = (project: MemoryProjectIdentity, skillId: SkillId, pin: SkillRevisionHash) =>
      Effect.gen(function* () {
        const before = (yield* library.assignments(skillId)).find(
          (one) => one.scope._tag === "Project" && one.scope.identity === project,
        );
        if (before?.pin === pin) return before;
        const committed = yield* library.assign({
          skillId,
          scope: { _tag: "Project", identity: project },
          pin,
          held: before?.held ?? false,
          onlyWhenAsked: before?.onlyWhenAsked ?? false,
          by: YOU,
        });
        yield* announce(committed.entries);
        return committed.value;
      });

    /** The skills that are not followed on this repository's default branch: from another source, or none. */
    const followedElsewhere = (repository: SkillRepository, skills: ReadonlyArray<Skill>) =>
      Effect.map(library.sources, (sources) => {
        const ours = new Set(
          sources
            .filter(({ origin }) => origin._tag === "Git" && origin.url === repository.url && origin.ref === null)
            .map((source) => source.id),
        );
        return skills.filter((skill) => skill.sourceId === null || !ours.has(skill.sourceId));
      });

    /**
     * Refuses content the library already holds as a skill followed elsewhere: importing it would only
     * give the project that skill, whose updates come from its own source, not this default branch.
     */
    const refuseFollowedElsewhere = (
      repository: SkillRepository,
      scanned: ReadonlyArray<{ readonly hash: SkillRevisionHash }>,
    ) =>
      Effect.gen(function* () {
        const hashes = new Set(scanned.map((one) => one.hash));
        for (const skill of yield* followedElsewhere(repository, yield* library.list)) {
          const revisions = yield* library.revisions(skill.id);
          if (revisions.some((revision) => hashes.has(revision.hash))) {
            return yield* new SkillNameTaken({ name: skill.name, skillId: skill.id });
          }
        }
      });

    return SkillRepositories.of({
      list,
      scan: (project) =>
        Effect.gen(function* () {
          const repository = yield* repositoryOf(project);
          const scan = yield* importer.scan(sourceOf(repository));
          return { repository, scan: ownCandidates(scan) };
        }),
      import: (project, scanned) =>
        Effect.gen(function* () {
          const repository = yield* repositoryOf(project);
          const outside = scanned.find((one) => !isRepositorySkill(one.folder));
          if (outside !== undefined) return yield* new SkillNotFound({ id: outside.folder });
          yield* refuseFollowedElsewhere(repository, scanned);
          // Bound to what the scan found: a default branch that moved on since imports nothing.
          const imported = yield* importer.add(sourceOf(repository), {
            folders: scanned.map((one) => one.folder),
            scanned: new Map(scanned.map((one) => [one.folder, one.hash])),
            followSource: true,
            by: YOU,
          });
          // Content another source added since the check above is that source's skill: it stays unassigned here.
          const kept = imported.filter((one) => !one.added).map((one) => one.skill);
          const elsewhere = (yield* followedElsewhere(repository, kept))[0];
          if (elsewhere !== undefined) {
            return yield* new SkillNameTaken({ name: elsewhere.name, skillId: elsewhere.id });
          }
          const assigned = yield* Effect.forEach(imported, (one) =>
            giveToProject(repository.project, one.skill.id, one.revision.hash),
          );
          yield* close(repository);
          return { imported, assigned };
        }),
      dismiss: (project) => Effect.flatMap(repositoryOf(project), close),
    });
  }),
);
