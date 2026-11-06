import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  announcer,
  EventPublisher,
  HobbotsRepository,
  hobSkills,
  MemoryProjects,
  PermissionSummary,
  rolloutTargets,
  SkillFiles,
  SkillLibrary,
  type SkillLibraryShape,
} from "@hobbots/agents";
import {
  HobbotsApi,
  SkillImportRefused,
  SkillMissing,
  SkillNameConflict,
  SkillSourceNotRead,
  type SkillSourcePayload,
  SkillStillAssigned,
} from "@hobbots/api";
import type { AgentId, Committed, SkillBy, SkillId, SkillNotFound, SkillRevisionHash } from "@hobbots/domain";
import {
  AgentsFolder,
  AgentsFolderLive,
  defaultAgentsFolder,
  type SkillImportError,
  SkillImporter,
  SkillImporterLive,
  type SkillImportSource,
  SkillObjectsLive,
} from "@hobbots/skills";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * The skills library's routes (ADR 029, Import). Every change here is yours: a device session
 * makes it, and no hob reaches these routes.
 */

const YOU: SkillBy = { _tag: "You" };

const sourceOf = (payload: SkillSourcePayload): SkillImportSource =>
  payload._tag === "Archive"
    ? { _tag: "Archive", fileName: payload.fileName, bytes: Buffer.from(payload.base64, "base64") }
    : payload;

/** The library's refusals, in the words of the HTTP contract. */
const importError = (error: SkillImportError) => {
  switch (error._tag) {
    case "SkillRefused":
      return new SkillImportRefused({ check: error.check, path: error.path, message: error.message });
    case "SkillSourceUnreadable":
      return new SkillSourceNotRead({ message: error.message });
    case "SkillNotFound":
      return new SkillMissing({ id: error.id });
    case "SkillNameTaken":
      return new SkillNameConflict({ name: error.name, skillId: error.skillId });
    case "SkillNameChanged":
      return new SkillNameConflict({ name: error.given, skillId: error.skillId });
  }
};

const NO_LIBRARY = "This hub has no skills library.";

/** A hub built without the library, as most of the server's tests are: no skills, and nothing to import into. */
const libraryOff = {
  list: () => Effect.succeed({ skills: [], sources: [], agentsFolder: { path: null, problems: [] } }),
  get: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  revision: ({ params }: { readonly params: { readonly hash: string } }) =>
    Effect.fail(new SkillMissing({ id: params.hash })),
  scan: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  import: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  revise: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  syncAgentsFolder: () => Effect.succeed({ skills: [], sources: [], agentsFolder: { path: null, problems: [] } }),
  remove: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  rollOut: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  assign: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  rollOutAssignment: ({ params }: { readonly params: { readonly assignmentId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.assignmentId })),
  hold: ({ params }: { readonly params: { readonly assignmentId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.assignmentId })),
  unassign: ({ params }: { readonly params: { readonly assignmentId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.assignmentId })),
  hob: ({ params }: { readonly params: { readonly agentId: AgentId } }) =>
    Effect.succeed({ agentId: params.agentId, skills: [], replaced: [], clashes: [], optedOut: [] }),
  optOut: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
};

/**
 * Rolls `pin` out to every assignment of the skill that is not held and not on it already (ADR 029,
 * Pins and rollout), each journaled and announced. Returns the assignments it moved.
 */
const rollOutAll = (
  library: SkillLibraryShape,
  announce: (entries: Committed<unknown>["entries"]) => Effect.Effect<void>,
  skillId: SkillId,
  pin: SkillRevisionHash,
) =>
  Effect.gen(function* () {
    const targets = rolloutTargets(yield* library.assignments(skillId), skillId, pin);
    return yield* Effect.forEach(targets, (target) =>
      library.rollOut(target.id, pin, YOU).pipe(
        Effect.tap((committed) => announce(committed.entries)),
        Effect.map((committed) => committed.value),
      ),
    );
  });

export const SkillsHandlers = HttpApiBuilder.group(HobbotsApi, "skills", (handlers) =>
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillLibrary),
      yield* Effect.serviceOption(SkillImporter),
      yield* Effect.serviceOption(SkillFiles),
    ]);
    if (Option.isNone(services)) return handlers.handleAll(libraryOff);
    const [library, importer, files] = services.value;
    const agentsFolder = yield* Effect.serviceOption(AgentsFolder);
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill change");

    const list = Effect.gen(function* () {
      const problems = Option.isSome(agentsFolder) ? yield* agentsFolder.value.problems : [];
      return {
        skills: yield* library.list,
        sources: yield* library.sources,
        agentsFolder: {
          path: Option.isSome(agentsFolder) ? agentsFolder.value.path : null,
          problems: problems.map((problem) => ({
            folder: problem.folder,
            check: problem.refusal?.check ?? null,
            message:
              problem.unreadable ??
              problem.refusal?.message ??
              `The library already has a skill named ${problem.takenBy ?? problem.folder}.`,
          })),
        },
      };
    });

    const repo = yield* Effect.serviceOption(HobbotsRepository);
    const permissions = yield* Effect.serviceOption(PermissionSummary);
    const projects = yield* Effect.serviceOption(MemoryProjects);
    const hobOf = (agentId: AgentId) =>
      Option.isNone(repo) ? Effect.succeed(Option.none()) : repo.value.findAgent(agentId);
    const missing = <A, R>(effect: Effect.Effect<A, SkillNotFound, R>) =>
      Effect.mapError(effect, (error) => new SkillMissing({ id: error.id }));
    const committedValue = <A>(change: Effect.Effect<Committed<A>, SkillNotFound>) =>
      missing(
        change.pipe(
          Effect.tap((committed) => announce(committed.entries)),
          Effect.map((committed) => committed.value),
        ),
      );
    // A hob's skills as its next turn would get them, in the folders it works in now.
    const hobView = (agentId: AgentId) =>
      Effect.gen(function* () {
        const found = yield* hobOf(agentId);
        if (Option.isNone(found)) return yield* new SkillMissing({ id: agentId });
        const agent = found.value;
        const folders = Option.isSome(permissions)
          ? (yield* permissions.value.of(agent)).folders
          : agent.policy.ownFolders;
        const resolved = yield* hobSkills(library, projects, { agentId, policy: agent.policy, folders });
        return {
          agentId,
          ...resolved,
          optedOut: (yield* library.optOuts(agentId)).map((one) => one.skillId),
        };
      });

    const skillOf = (skillId: Parameters<typeof library.get>[0]) =>
      Effect.flatMap(library.get(skillId), (skill) =>
        skill === null ? Effect.fail(new SkillMissing({ id: skillId })) : Effect.succeed(skill),
      );

    return handlers.handleAll({
      list: () => list,
      get: ({ params }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          return {
            skill,
            revisions: yield* library.revisions(skill.id),
            assignments: yield* library.assignments(skill.id),
          };
        }),
      revision: ({ params }) =>
        Effect.gen(function* () {
          const revision = yield* library.revision(params.skillId, params.hash);
          const folder = yield* files.folder(params.hash);
          if (revision === null || folder === null) return yield* new SkillMissing({ id: params.hash });
          const instructions = yield* Effect.promise(() =>
            readFile(join(folder, "SKILL.md"), "utf8").catch(() => null),
          );
          if (instructions === null) return yield* new SkillMissing({ id: params.hash });
          return { revision, instructions };
        }),
      scan: ({ payload }) =>
        importer
          .scan(sourceOf(payload.source))
          .pipe(Effect.mapError((error) => new SkillSourceNotRead({ message: error.message }))),
      import: ({ payload }) =>
        importer
          .add(sourceOf(payload.source), {
            by: YOU,
            ...(payload.folders === undefined ? {} : { folders: payload.folders }),
          })
          .pipe(
            Effect.map((imported) => ({ imported })),
            Effect.mapError(importError),
          ),
      revise: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          const added = yield* importer
            .add(sourceOf(payload.source), {
              by: YOU,
              skillId: skill.id,
              ...(payload.folder === undefined ? {} : { folders: [payload.folder] }),
            })
            .pipe(Effect.mapError(importError));
          const [one] = added;
          if (one === undefined) return yield* new SkillMissing({ id: skill.id });
          // Your edit rolls out to every assignment that is not held; content the skill had moves none.
          const rolledOut = one.added ? yield* missing(rollOutAll(library, announce, skill.id, one.revision.hash)) : [];
          return { ...one, rolledOut };
        }),
      rollOut: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          if ((yield* library.revision(skill.id, payload.pin)) === null)
            return yield* new SkillMissing({ id: payload.pin });
          return { rolledOut: yield* rollOutAll(library, announce, skill.id, payload.pin).pipe(missing) };
        }),
      assign: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          const [newest] = yield* library.revisions(skill.id);
          const pin = payload.pin ?? newest?.hash;
          if (pin === undefined) return yield* new SkillMissing({ id: skill.id });
          if (payload.scope._tag === "Hob" && Option.isNone(yield* hobOf(payload.scope.agentId)))
            return yield* new SkillMissing({ id: payload.scope.agentId });
          const before = (yield* library.assignments(skill.id)).find(
            (one) => JSON.stringify(one.scope) === JSON.stringify(payload.scope),
          );
          return yield* committedValue(
            library.assign({
              skillId: skill.id,
              scope: payload.scope,
              pin,
              held: payload.held ?? before?.held ?? false,
              onlyWhenAsked: payload.onlyWhenAsked ?? before?.onlyWhenAsked ?? false,
              by: YOU,
            }),
          );
        }),
      rollOutAssignment: ({ params, payload }) =>
        committedValue(library.rollOut(params.assignmentId, payload.pin, YOU)),
      hold: ({ params, payload }) => committedValue(library.hold(params.assignmentId, payload.held)),
      unassign: ({ params }) =>
        library
          .unassign(params.assignmentId)
          .pipe(
            Effect.flatMap((committed) =>
              committed === null
                ? Effect.fail(new SkillMissing({ id: params.assignmentId }))
                : Effect.as(announce(committed.entries), committed.value),
            ),
          ),
      hob: ({ params }) => hobView(params.agentId),
      optOut: ({ params, payload }) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* hobOf(params.agentId))) return yield* new SkillMissing({ id: params.agentId });
          const changed = yield* library.setOptOut(params.agentId, params.skillId, payload.optedOut).pipe(missing);
          if (changed !== null) yield* announce(changed.entries);
          return yield* hobView(params.agentId);
        }),
      syncAgentsFolder: () =>
        Effect.gen(function* () {
          if (Option.isSome(agentsFolder)) yield* agentsFolder.value.sync;
          return yield* list;
        }),
      remove: ({ params }) =>
        library.remove(params.skillId).pipe(
          Effect.tap((committed) => announce(committed.entries)),
          Effect.map((committed) => committed.value),
          Effect.catchTags({
            SkillNotFound: (error) => Effect.fail(new SkillMissing({ id: error.id })),
            SkillInUse: (error) =>
              Effect.fail(new SkillStillAssigned({ skillId: error.skillId, assignments: error.assignments })),
          }),
        ),
    });
  }),
);

/** The folder `~/.agents/skills` is read from, or null when the hub reads none (`HOBBOTS_AGENTS_SKILLS`). */
export const agentsSkillsFolder = (setting: Option.Option<string>, runtime: "claude" | "fake"): string | null => {
  if (Option.isSome(setting)) return setting.value === "off" ? null : setting.value;
  return runtime === "fake" ? null : defaultAgentsFolder();
};

/**
 * Skills on the hub (ADR 029): each revision's files under `skills/objects` in the data folder,
 * import into the library, and `~/.agents/skills` read into it when there is one to read.
 */
export const SkillsLive = (dataDir: string, agentsFolder: string | null) => {
  const services = SkillImporterLive.pipe(Layer.provideMerge(SkillObjectsLive(dataDir)));
  return agentsFolder === null ? services : AgentsFolderLive(agentsFolder).pipe(Layer.provideMerge(services));
};
