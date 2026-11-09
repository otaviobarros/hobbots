import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  announcer,
  EventPublisher,
  ExportFolders,
  HobbotsRepository,
  hobSkills,
  MemoryProjects,
  memoryActorFor,
  PermissionSummary,
  SaveDestinations,
  SkillFiles,
  type SkillHoldChange,
  SkillLibrary,
  type SkillLibraryShape,
} from "@hobbots/agents";
import {
  ExportFailed,
  HobbotsApi,
  SKILL_FILE_SHOWN_MAX,
  SkillEditStale,
  SkillImportRefused,
  SkillIsReadOnly,
  SkillMissing,
  SkillNameConflict,
  SkillScanOutdated,
  SkillSourceNotRead,
  type SkillSourcePayload,
  SkillStillAssigned,
} from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type Committed,
  type MemoryProjectIdentity,
  type Skill,
  type SkillAssignment,
  type SkillBy,
  type SkillId,
  type SkillName,
  type SkillNotFound,
  type SkillRevision,
  type SkillRevisionHash,
  skillUseWeekStart,
} from "@hobbots/domain";
import { EventJournal, RestoreRepository, SkillRepositoryOffersLive, SkillUpdateLogLive } from "@hobbots/persistence";
import {
  AgentsFolder,
  AgentsFolderLive,
  AgentsFolderMoves,
  defaultAgentsFolder,
  type ExportedHob,
  type SkillImportError,
  SkillImporter,
  SkillImporterLive,
  type SkillImportSource,
  SkillObjects,
  SkillObjectsLive,
  SkillUpdatesLive,
  SkillWriterLive,
  setLinksOf,
  writeSkillExport,
} from "@hobbots/skills";
import { DateTime, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { fileStamp } from "./backup-files.ts";
import { defaultSaveFolder } from "./destination.ts";
import { SKILL_CHANGE_TYPES, skillChangesOf, skillIdOfChange } from "./skill-changes.ts";

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
export const importError = (error: SkillImportError) => {
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
    case "SkillMovedOn":
      return new SkillEditStale({ skillId: error.skillId, latest: error.latest });
    case "SkillSourceChanged":
      return new SkillScanOutdated({ folder: error.folder });
    case "SkillReadOnly":
      return new SkillIsReadOnly({ skillId: error.skillId, name: error.name, folder: error.folder });
  }
};

const NO_LIBRARY = "This hub has no skills library.";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** A file's bytes as text, or null when they are not UTF-8 or hold a NUL, as a binary file does. */
const textOf = (bytes: Uint8Array): string | null => {
  try {
    const text = textDecoder.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

/** How many journal entries What changed reads, and how many changes it shows. */
const CHANGES_READ = 500;
const CHANGES_SHOWN = 60;

/** How many skills a hob's view lists as last used. */
const LAST_USED = 20;

const NO_SKILLS = {
  skills: [],
  sources: [],
  assignments: [],
  projects: [],
  agentsFolder: { path: null, home: null, problems: [] },
  usesThisWeek: [],
  sets: [],
};

/**
 * What Make a copy imports (ADR 029): the revision's files under the new name, or for a set, the one
 * of its skills named, with the set's files it links to. A set is never copied whole.
 */
const copiedSource = (
  setName: string,
  base: SkillRevision,
  folder: string,
  payload: { readonly name: SkillName; readonly member?: SkillName | undefined },
) => {
  const member = base.set?.skills.find((one) => one.name === payload.member);
  if (base.set !== null && member === undefined)
    return Effect.fail(
      new SkillImportRefused({
        check: "set",
        path: null,
        message: `Pick one skill of ${setName} to copy; a set is copied one skill at a time.`,
      }),
    );
  const carried = { charms: member?.charms ?? base.charms, dropped: base.dropped };
  return Effect.succeed({
    _tag: "Copied",
    folder,
    name: payload.name,
    carried,
    ...(member === undefined ? {} : { member }),
  } satisfies SkillImportSource);
};

/** A hub built without the library, as most of the server's tests are: no skills, and nothing to import into. */
const libraryOff = {
  list: () => Effect.succeed(NO_SKILLS),
  get: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  revision: ({ params }: { readonly params: { readonly hash: string } }) =>
    Effect.fail(new SkillMissing({ id: params.hash })),
  file: ({ params }: { readonly params: { readonly hash: string } }) =>
    Effect.fail(new SkillMissing({ id: params.hash })),
  scan: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  import: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  export: () => Effect.fail(new ExportFailed({ message: NO_LIBRARY })),
  revise: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  edit: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  copy: () => Effect.fail(new SkillSourceNotRead({ message: NO_LIBRARY })),
  syncAgentsFolder: () => Effect.succeed(NO_SKILLS),
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
    Effect.succeed({
      agentId: params.agentId,
      skills: [],
      replaced: [],
      clashes: [],
      optedOut: [],
      optedOutOfSets: [],
      projects: [],
      lastUsed: [],
    }),
  uses: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
  changes: () => Effect.succeed({ changes: [] }),
  optOut: ({ params }: { readonly params: { readonly skillId: string } }) =>
    Effect.fail(new SkillMissing({ id: params.skillId })),
};

/**
 * Rolls `pin` out to every assignment of the skill that is not held and not on it already (ADR 029,
 * Pins and rollout), in one transaction, journaled and announced. Returns the assignments it moved.
 */
const rollOutAll = (
  library: SkillLibraryShape,
  announce: (entries: Committed<unknown>["entries"]) => Effect.Effect<void>,
  skillId: SkillId,
  pin: SkillRevisionHash,
  when: "pending" | "always",
  holds: ReadonlyArray<SkillHoldChange> = [],
) =>
  library.rollOutRevision(skillId, pin, YOU, when, holds).pipe(
    Effect.tap((committed) => announce(committed.entries)),
    Effect.map((committed) => committed.value),
  );

/** The folders a hob works in now, as its permissions give them, or its own folders on a hub without them. */
const hobFolders = (permissions: Option.Option<PermissionSummary["Service"]>, agent: Agent) =>
  Option.isSome(permissions)
    ? Effect.map(permissions.value.of(agent), (summary) => summary.folders)
    : Effect.succeed(agent.policy.ownFolders);

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
    const journal = yield* Effect.serviceOption(EventJournal);
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill change");

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
    const foldersOf = (agent: Agent) => hobFolders(permissions, agent);
    // A hob's skills as its next turn would get them, in the folders it works in now.
    const hobView = (agentId: AgentId) =>
      Effect.gen(function* () {
        const found = yield* hobOf(agentId);
        if (Option.isNone(found)) return yield* new SkillMissing({ id: agentId });
        const agent = found.value;
        const folders = yield* foldersOf(agent);
        const resolved = yield* hobSkills(library, projects, { agentId, policy: agent.policy, folders });
        const optOuts = yield* library.optOuts(agentId);
        return {
          agentId,
          ...resolved,
          optedOut: optOuts.filter((one) => one.member === null).map((one) => one.skillId),
          optedOutOfSets: optOuts.flatMap((one) =>
            one.member === null ? [] : [{ skillId: one.skillId, name: one.member }],
          ),
          projects: (yield* memoryActorFor(projects, agentId, folders)).projects,
          lastUsed: yield* library.lastUses(agentId, LAST_USED),
        };
      });

    /** The projects hobs that are not retired work in now, as their turns resolve them, and those `assignments` reach. */
    const projectsNow = (assignments: ReadonlyArray<SkillAssignment>) =>
      Effect.gen(function* () {
        const hobs = Option.isSome(repo) ? yield* repo.value.listAgentsWithStatus(["active", "paused"]) : [];
        const reached = yield* Effect.forEach(hobs, (agent) =>
          Effect.gen(function* () {
            return (yield* memoryActorFor(projects, agent.id, yield* foldersOf(agent))).projects;
          }),
        );
        const given = assignments.flatMap((one) => (one.scope._tag === "Project" ? [one.scope.identity] : []));
        return [...new Set([...reached.flat(), ...given])].sort();
      });

    // Each set's skills, from its newest revision, so the library can say "Set of 9 skills".
    const setsOf = (skills: ReadonlyArray<Skill>) =>
      Effect.map(
        Effect.forEach(skills, (skill) => library.revision(skill.id, skill.latest)),
        (latest) =>
          latest.flatMap((revision) =>
            revision?.set == null ? [] : [{ skillId: revision.skillId, skills: revision.set.skills }],
          ),
      );

    // A set's files outside its skills' folders, with the skills whose SKILL.md links to each one.
    const sharedOf = (revision: SkillRevision | undefined) =>
      Effect.gen(function* () {
        if (revision?.set == null) return null;
        const members = revision.set.skills;
        const folder = yield* files.folder(revision.hash);
        const links = yield* Effect.forEach(members, (member) =>
          Effect.promise(async () => {
            const path = `${member.path}/SKILL.md`;
            const text = folder === null ? null : await readFile(join(folder, path), "utf8").catch(() => null);
            return { name: member.name, links: text === null ? [] : setLinksOf(path, text) };
          }),
        );
        const inMember = (path: string) => members.some((member) => path.startsWith(`${member.path}/`));
        const linksTo = (links: ReadonlyArray<string>, path: string) =>
          links.some((link) => path === link || path.startsWith(`${link}/`));
        return revision.files
          .filter((file) => !inMember(file.path))
          .map((file) => ({
            path: file.path,
            linkedBy: links.filter((one) => linksTo(one.links, file.path)).map((one) => one.name),
          }));
      });

    const list = Effect.gen(function* () {
      const problems = Option.isSome(agentsFolder) ? yield* agentsFolder.value.problems : [];
      const assignments = yield* library.assignments();
      const skills = yield* library.list;
      return {
        skills,
        sources: yield* library.sources,
        assignments,
        projects: yield* projectsNow(assignments),
        agentsFolder: {
          path: Option.isSome(agentsFolder) ? agentsFolder.value.path : null,
          home: homedir(),
          problems: problems.map((problem) => ({
            folder: problem.folder,
            check: problem.refusal?.check ?? null,
            message:
              problem.unreadable ??
              problem.refusal?.message ??
              `The library already has a skill named ${problem.takenBy ?? problem.folder}.`,
          })),
        },
        usesThisWeek: yield* library.usesSince(skillUseWeekStart(DateTime.formatIso(yield* DateTime.now))),
        sets: yield* setsOf(skills),
      };
    });

    /** What changed (ADR 029, The Skills page): the journal's latest skill changes, with names and revision numbers. */
    const changes = Effect.gen(function* () {
      if (Option.isNone(journal)) return { changes: [] };
      const envelopes = yield* journal.value.latestOf(SKILL_CHANGE_TYPES, CHANGES_READ);
      const names = new Map((yield* library.list).map((skill) => [skill.id, skill.name]));
      const ids = [...new Set(envelopes.flatMap((one) => skillIdOfChange(one.payload) ?? []))];
      const revisions = new Map(
        yield* Effect.forEach(ids, (id) => Effect.map(library.revisions(id), (all) => [id, all] as const)),
      );
      const pins = new Map((yield* library.assignments()).map((one) => [one.id, one.pin]));
      return {
        changes: skillChangesOf(
          envelopes,
          {
            name: (skillId) => names.get(skillId) ?? null,
            number: (skillId, hash) => revisions.get(skillId)?.find((one) => one.hash === hash)?.number ?? null,
            pin: (assignmentId) => pins.get(assignmentId) ?? null,
          },
          CHANGES_SHOWN,
        ),
      };
    });

    const skillOf = (skillId: Parameters<typeof library.get>[0]) =>
      Effect.flatMap(library.get(skillId), (skill) =>
        skill === null ? Effect.fail(new SkillMissing({ id: skillId })) : Effect.succeed(skill),
      );

    /**
     * Adds a revision you made, and rolls it out to every assignment that is not held. Whether it still
     * may is decided inside the rollout's transaction: saving it again finishes a rollout the hub stopped
     * in the middle of, and content already rolled out, or no longer the newest, moves none, so a
     * rollback stays.
     */
    const revised = (
      skillId: SkillId,
      source: SkillImportSource,
      options: { readonly folders?: Array<string>; readonly after?: SkillRevisionHash },
      // The holds the save changes, set by its own rollout (`rollOutRevision`).
      holds: ReadonlyArray<SkillHoldChange> = [],
    ) =>
      Effect.gen(function* () {
        const [one] = yield* importer.add(source, { by: YOU, skillId, ...options }).pipe(Effect.mapError(importError));
        if (one === undefined) return yield* new SkillMissing({ id: skillId });
        const rolledOut = yield* missing(rollOutAll(library, announce, skillId, one.revision.hash, "pending", holds));
        return { ...one, rolledOut };
      });

    /**
     * The hob an exported assignment names, on this hub: the same hob when it is here and not retired,
     * or else the one hob of that name. Null when there is none, or more than one.
     */
    const placeHob = (hob: ExportedHob) =>
      Effect.gen(function* () {
        if (Option.isNone(repo)) return null;
        const hobs = yield* repo.value.listAgentsWithStatus(["active", "paused"]);
        if (hobs.some((one) => one.id === hob.agentId)) return hob.agentId;
        const named = hobs.filter((one) => hob.name !== null && one.name === hob.name);
        return named.length === 1 ? (named[0]?.id ?? null) : null;
      });

    /**
     * Whether this hub knows a project an exported assignment names: one its hobs work in now, or one
     * the library already gives a skill to, as the Skills page lists them.
     */
    const hasProject = (identity: MemoryProjectIdentity) =>
      Effect.map(Effect.flatMap(library.assignments(), projectsNow), (known) => known.includes(identity));

    const objects = yield* Effect.serviceOption(SkillObjects);
    const folders = yield* Effect.serviceOption(ExportFolders);
    const destinations = yield* Effect.serviceOption(SaveDestinations);

    /**
     * Export skills (ADR 029): a new folder `hobbots-skills-<date>` in the hub user's Downloads folder,
     * never inside a folder hobs work in, with each skill and `skills.lock.json`. A failure deletes it.
     */
    const exportSkills = (payload: { readonly skillIds?: ReadonlyArray<SkillId>; readonly assignments: boolean }) =>
      Effect.gen(function* () {
        if (Option.isNone(objects) || Option.isNone(folders))
          return yield* new ExportFailed({ message: "This hub does not make exports" });
        const typed = defaultSaveFolder();
        const parent = Option.isSome(destinations) ? yield* destinations.value.check(typed) : typed;
        const now = yield* DateTime.now;
        // The date where you are, as the folder's name says it.
        const day = fileStamp(new Date(DateTime.toEpochMillis(now))).slice(0, 10);
        const folder = yield* folders.value.create(parent, `hobbots-skills-${day}`);
        const names = new Map(
          (Option.isSome(repo) ? yield* repo.value.listAgents : []).map((one) => [one.id, one.name]),
        );
        const written = yield* writeSkillExport(folder, {
          ...(payload.skillIds === undefined ? {} : { skillIds: payload.skillIds }),
          assignments: payload.assignments,
          hobName: (agentId) => names.get(agentId) ?? null,
          exportedAt: DateTime.formatIso(now),
        }).pipe(
          Effect.provideService(SkillLibrary, library),
          Effect.provideService(SkillObjects, objects.value),
          Effect.catchDefect(() => Effect.fail(new ExportFailed({ message: `Hobbots could not write ${folder}` }))),
          Effect.tapError(() => folders.value.remove(folder)),
        );
        return { folder, name: basename(folder), skills: written.skills, leftOut: written.leftOut };
      });

    return handlers.handleAll({
      list: () => list,
      get: ({ params }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          const revisions = yield* library.revisions(skill.id);
          return {
            skill,
            revisions,
            assignments: yield* library.assignments(skill.id),
            shared: yield* sharedOf(revisions[0]),
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
      // Only a path the revision lists is read, so nothing outside its folder can be named.
      file: ({ params, query }) =>
        Effect.gen(function* () {
          const revision = yield* library.revision(params.skillId, params.hash);
          const file = revision?.files.find((one) => one.path === query.path);
          const folder = yield* files.folder(params.hash);
          if (file === undefined || folder === null) return yield* new SkillMissing({ id: query.path });
          const bytes =
            file.size > SKILL_FILE_SHOWN_MAX
              ? null
              : yield* Effect.promise(() => readFile(join(folder, file.path)).catch(() => null));
          return { path: file.path, mode: file.mode, size: file.size, text: bytes === null ? null : textOf(bytes) };
        }),
      scan: ({ payload }) =>
        importer
          .scan(sourceOf(payload.source))
          .pipe(Effect.mapError((error) => new SkillSourceNotRead({ message: error.message }))),
      // A Hobbots export gives out the assignments it kept too, each hob found here (ADR 029).
      import: ({ payload }) =>
        importer
          .addSet(sourceOf(payload.source), {
            by: YOU,
            placeHob,
            ...(payload.folders === undefined ? {} : { folders: payload.folders }),
            hasProject,
            ...(payload.scanned === undefined
              ? {}
              : {
                  scanned: new Map(payload.scanned.map((one) => [one.folder, one.hash])),
                  scannedLock: payload.scannedLock ?? null,
                }),
          })
          .pipe(Effect.mapError(importError)),
      export: ({ payload }) => exportSkills(payload),
      revise: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          const folders = payload.folder === undefined ? {} : { folders: [payload.folder] };
          return yield* revised(skill.id, sourceOf(payload.source), folders);
        }),
      rollOut: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          if ((yield* library.revision(skill.id, payload.pin)) === null)
            return yield* new SkillMissing({ id: payload.pin });
          return { rolledOut: yield* rollOutAll(library, announce, skill.id, payload.pin, "always").pipe(missing) };
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
      changes: () => changes,
      uses: ({ params }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          return yield* library.useCounts(skill.id, skillUseWeekStart(DateTime.formatIso(yield* DateTime.now)));
        }),
      optOut: ({ params, payload }) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* hobOf(params.agentId))) return yield* new SkillMissing({ id: params.agentId });
          const changed = yield* library
            .setOptOut(params.agentId, params.skillId, payload.optedOut, payload.member ?? null)
            .pipe(missing);
          if (changed !== null) yield* announce(changed.entries);
          return yield* hobView(params.agentId);
        }),
      // An edit in Hobbots: `base`'s files with another description and instructions, rolled out like any
      // revision. It is saved only while `base` is still the newest, checked as the revision is written.
      edit: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          const base = yield* library.revision(skill.id, payload.base);
          const folder = yield* files.folder(payload.base);
          if (base === null || folder === null) return yield* new SkillMissing({ id: payload.base });
          const { description, instructions } = payload;
          const carried = { charms: base.charms, dropped: base.dropped };
          const source = { _tag: "Edited", folder, description, instructions, carried } as const;
          return yield* revised(skill.id, source, { after: payload.base }, payload.holds);
        }),
      // Make a copy (ADR 029): a skill written in Hobbots with the files of `base`, under a new name,
      // at r1 and with no source. It goes to `scope` only when you picked one; the original stays as it is.
      copy: ({ params, payload }) =>
        Effect.gen(function* () {
          const skill = yield* skillOf(params.skillId);
          // A skill from ~/.agents/skills is copied as the folder holds it now, which may be an earlier revision.
          const inFolder = Option.isSome(agentsFolder)
            ? (yield* agentsFolder.value.current)?.get(skill.name)
            : undefined;
          const hash = payload.base ?? inFolder ?? skill.latest;
          const base = yield* library.revision(skill.id, hash);
          const folder = yield* files.folder(hash);
          if (base === null || folder === null) return yield* new SkillMissing({ id: hash });
          if (payload.scope?._tag === "Hob" && Option.isNone(yield* hobOf(payload.scope.agentId)))
            return yield* new SkillMissing({ id: payload.scope.agentId });
          const source = yield* copiedSource(skill.name, base, folder, payload);
          const [copied] = yield* importer.add(source, { by: YOU }).pipe(Effect.mapError(importError));
          if (copied === undefined) return yield* new SkillMissing({ id: skill.id });
          // Content a skill of that name already has is that skill, not a new copy.
          if (!copied.added) return yield* new SkillNameConflict({ name: payload.name, skillId: copied.skill.id });
          const assignment =
            payload.scope === undefined
              ? null
              : yield* committedValue(
                  library.assign({
                    skillId: copied.skill.id,
                    scope: payload.scope,
                    pin: copied.revision.hash,
                    held: false,
                    onlyWhenAsked: false,
                    by: YOU,
                  }),
                );
          return { ...copied, assignment };
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

/**
 * Each hob that works, active or paused, with its skills as its next turn would get them in the
 * folders it works in now: what Diagnostics and the Overview's health checks read (ADR 029). Empty on
 * a hub without skills.
 */
export const workingHobSkills = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary);
  const repo = yield* Effect.serviceOption(HobbotsRepository);
  const permissions = yield* Effect.serviceOption(PermissionSummary);
  const projects = yield* Effect.serviceOption(MemoryProjects);
  return Effect.gen(function* () {
    if (Option.isNone(library) || Option.isNone(repo)) return [];
    const hobs = yield* repo.value.listAgentsWithStatus(["active", "paused"]);
    return yield* Effect.forEach(hobs, (agent) =>
      Effect.gen(function* () {
        const folders = Option.isSome(permissions)
          ? (yield* permissions.value.of(agent)).folders
          : agent.policy.ownFolders;
        const resolved = yield* hobSkills(library.value, projects, {
          agentId: agent.id,
          policy: agent.policy,
          folders,
        });
        return { agent, resolved };
      }),
    );
  });
});

/**
 * Each hob's skills as its next turn would get them, in the folders it works in now, by name and
 * revision only, for Diagnostics (ADR 029): the same on every runtime. Empty on a hub without skills.
 */
export const hobSkillLines = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary);
  const working = yield* workingHobSkills;
  return Effect.gen(function* () {
    if (Option.isNone(library)) return [];
    const skills = library.value;
    return yield* Effect.forEach(yield* working, ({ agent, resolved }) =>
      Effect.gen(function* () {
        return {
          agentId: agent.id,
          runtime: agent.runtime,
          skills: yield* Effect.forEach(resolved.skills, (skill) =>
            Effect.map(skills.revision(skill.skillId, skill.pin), (revision) => ({
              name: skill.name,
              number: revision?.number ?? null,
              revision: skill.pin,
              scope: skill.scope._tag,
              set: skill.set,
            })),
          ),
          clashes: resolved.clashes.map((clash) => clash.name),
        };
      }),
    );
  });
});

/** The folder `~/.agents/skills` is read from, or null when the hub reads none (`HOBBOTS_AGENTS_SKILLS`). */
export const agentsSkillsFolder = (setting: Option.Option<string>, runtime: "claude" | "fake"): string | null => {
  if (Option.isSome(setting)) return setting.value === "off" ? null : setting.value;
  return runtime === "fake" ? null : defaultAgentsFolder();
};

/**
 * Skills on the hub (ADR 029): each revision's files under `skills/objects` in the data folder,
 * import into the library, updates from Git sources, the offers of repositories' own skills, and
 * `~/.agents/skills` read into it when there is one to read.
 */
export const SkillsLive = (dataDir: string, agentsFolder: string | null) => {
  const services = Layer.mergeAll(SkillWriterLive, SkillUpdatesLive).pipe(
    Layer.provideMerge(SkillImporterLive),
    Layer.provideMerge(Layer.mergeAll(SkillObjectsLive(dataDir), SkillUpdateLogLive, SkillRepositoryOffersLive)),
  );
  return agentsFolder === null
    ? services
    : AgentsFolderLive(agentsFolder).pipe(Layer.provide(RestoreMovesLive), Layer.provideMerge(services));
};

/** What reading `~/.agents/skills` moved goes in the latest restore's summary (ADR 026, ADR 029). */
const RestoreMovesLive = Layer.effect(
  AgentsFolderMoves,
  Effect.gen(function* () {
    const restores = yield* Effect.serviceOption(RestoreRepository);
    return AgentsFolderMoves.of({
      moved: (moves) => (Option.isSome(restores) ? restores.value.noteSkillMoves(moves) : Effect.void),
    });
  }),
);
