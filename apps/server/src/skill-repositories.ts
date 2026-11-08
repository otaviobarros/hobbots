import {
  announcer,
  EventPublisher,
  HobbotsRepository,
  MemoryProjects,
  PermissionSummary,
  SkillLibrary,
  SkillRepositoryOffers,
} from "@hobbots/agents";
import { HobbotsApi, SkillMissing, SkillSourceNotRead } from "@hobbots/api";
import {
  type Agent,
  isRepositorySkill,
  type MemoryProjectIdentity,
  repositoryOffered,
  type SkillBy,
  type SkillId,
  type SkillRepository,
  type SkillRevisionHash,
} from "@hobbots/domain";
import { repositorySkillFolders, SkillImporter, type SkillImportSource } from "@hobbots/skills";
import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { hobFolders, importError } from "./skills.ts";

/**
 * A repository's own skills over HTTP (ADR 029, Scopes, #1098). A repository a hob works in that holds
 * skills in `.claude/skills` or `.agents/skills` is offered once per project. No hob loads them from
 * the clone: an import reads them from the repository's default branch, through its `origin`, as a
 * Git source like any other, so a branch or a pull request never changes what a hob loads, and a
 * change on the default branch shows as an update with its review. Every decision here is yours: a
 * device session makes it, and no hob reaches these routes.
 */

const YOU: SkillBy = { _tag: "You" };

/** The repository's default branch: what the import reads, and what its update checks follow. */
const sourceOf = (repository: SkillRepository): SkillImportSource => ({ _tag: "Git", url: repository.url, ref: null });

export const SkillRepositoriesHandlers = HttpApiBuilder.group(HobbotsApi, "skillRepositories", (handlers) =>
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillLibrary),
      yield* Effect.serviceOption(SkillImporter),
      yield* Effect.serviceOption(SkillRepositoryOffers),
      yield* Effect.serviceOption(HobbotsRepository),
      yield* Effect.serviceOption(MemoryProjects),
    ]);
    if (Option.isNone(services)) {
      const none = ({ payload }: { readonly payload: { readonly project: string } }) =>
        Effect.fail(new SkillMissing({ id: payload.project }));
      return handlers.handleAll({
        list: () => Effect.succeed({ repositories: [] }),
        scan: none,
        import: none,
        dismiss: none,
      });
    }
    const [library, importer, offers, repo, projects] = services.value;
    const permissions = yield* Effect.serviceOption(PermissionSummary);
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a repository's skills");

    const foldersOf = (agent: Agent) => hobFolders(permissions, agent);

    /**
     * Every repository hobs that are not retired work in now with skills of its own, once per project:
     * the first clone that holds some, of the first hob by name. A folder with no `origin` is left out,
     * since there is no default branch to read.
     */
    const repositories = Effect.gen(function* () {
      const hobs = [...(yield* repo.listAgentsWithStatus(["active", "paused"]))].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const closed = yield* offers.closed;
      const found = new Map<MemoryProjectIdentity, SkillRepository>();
      for (const hob of hobs) {
        for (const folder of yield* foldersOf(hob)) {
          const project = yield* projects.of(folder);
          if (found.has(project)) continue;
          const url = yield* projects.origin(folder);
          if (url === null) continue;
          const skills = yield* repositorySkillFolders(folder);
          if (skills.length === 0) continue;
          const offered = repositoryOffered(skills, closed.get(project) ?? null);
          found.set(project, { project, folder, url, agentId: hob.id, skills, offered });
        }
      }
      return [...found.values()].sort((a, b) => a.project.localeCompare(b.project));
    });

    const view = Effect.map(repositories, (all) => ({ repositories: all }));

    const repositoryOf = (project: MemoryProjectIdentity) =>
      Effect.flatMap(repositories, (all) => {
        const one = all.find((repository) => repository.project === project);
        return one === undefined ? Effect.fail(new SkillMissing({ id: project })) : Effect.succeed(one);
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
        const committed = yield* library
          .assign({
            skillId,
            scope: { _tag: "Project", identity: project },
            pin,
            held: before?.held ?? false,
            onlyWhenAsked: before?.onlyWhenAsked ?? false,
            by: YOU,
          })
          .pipe(Effect.mapError((error) => new SkillMissing({ id: error.id })));
        yield* announce(committed.entries);
        return committed.value;
      });

    return handlers.handleAll({
      list: () => view,
      scan: ({ payload }) =>
        Effect.gen(function* () {
          const repository = yield* repositoryOf(payload.project);
          const scan = yield* importer
            .scan(sourceOf(repository))
            .pipe(Effect.mapError((error) => new SkillSourceNotRead({ message: error.message })));
          // Only the repository's own skills, and one skill kept in both folders once.
          const seen = new Set<string>();
          const candidates = scan.candidates.filter((one) => {
            if (!isRepositorySkill(one.folder)) return false;
            if (one.hash === null) return true;
            if (seen.has(one.hash)) return false;
            seen.add(one.hash);
            return true;
          });
          return { repository, scan: { ...scan, candidates } };
        }),
      import: ({ payload }) =>
        Effect.gen(function* () {
          const repository = yield* repositoryOf(payload.project);
          const outside = payload.scanned.find((one) => !isRepositorySkill(one.folder));
          if (outside !== undefined) return yield* new SkillMissing({ id: outside.folder });
          // Bound to what the scan found: a default branch that moved on since imports nothing.
          const imported = yield* importer
            .add(sourceOf(repository), {
              folders: payload.scanned.map((one) => one.folder),
              scanned: new Map(payload.scanned.map((one) => [one.folder, one.hash])),
              by: YOU,
            })
            .pipe(Effect.mapError(importError));
          const assigned = yield* Effect.forEach(imported, (one) =>
            giveToProject(repository.project, one.skill.id, one.revision.hash),
          );
          yield* close(repository);
          return { imported, assigned };
        }),
      dismiss: ({ payload }) =>
        Effect.gen(function* () {
          yield* close(yield* repositoryOf(payload.project));
          return yield* view;
        }),
    });
  }),
);
