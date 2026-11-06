import { type FSWatcher, watch } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { announcer, EventPublisher, SkillLibrary } from "@hobbots/agents";
import type { Skill, SkillBy, SkillName, SkillRefused } from "@hobbots/domain";
import { Context, Duration, Effect, Layer, Queue, Ref, Schedule, Semaphore } from "effect";
import { type CheckedSkill, checkSkill } from "./check.ts";
import { folderTree } from "./sources/folder.ts";
import { SkillObjects } from "./store.ts";
import type { SkillTree } from "./tree.ts";

/**
 * `~/.agents/skills`, through Hobbots (ADR 029, The clean-runtime rule). The folder is yours, not a
 * runtime's, so no runtime reads it: the hub reads it itself, keeps each skill in it as a library
 * skill under Everyone, marked as from that folder, and turns each change there into a new revision
 * that rolls out like your own edit. A skill there that fails the import checks is listed with the
 * rule it broke and is not delivered.
 */

/** A skill in the folder that the hub did not take, and why; or the folder itself, when it could not be read. */
export interface AgentsFolderProblem {
  /** Its folder's name under `~/.agents/skills`; "" for the folder itself. */
  readonly folder: string;
  readonly refusal: SkillRefused | null;
  /** Set when the library already has a skill of its name from somewhere else. */
  readonly takenBy: SkillName | null;
  /** Set when the folder could not be read in full, so nothing was changed. */
  readonly unreadable: string | null;
}

export interface AgentsFolderShape {
  /** The folder it reads. */
  readonly path: string;
  /** Reads the folder now and brings the library in line with it. */
  readonly sync: Effect.Effect<void>;
  /** What the last read could not take. */
  readonly problems: Effect.Effect<ReadonlyArray<AgentsFolderProblem>>;
}

export class AgentsFolder extends Context.Service<AgentsFolder, AgentsFolderShape>()("@hobbots/skills/AgentsFolder") {}

/** The shared skills folder of the user the hub runs as. */
export const defaultAgentsFolder = () => join(homedir(), ".agents", "skills");

/** The skill folders directly in the folder: each `<name>/SKILL.md`. */
const skillFoldersOf = (tree: SkillTree): ReadonlyArray<string> =>
  tree.entries
    .filter((entry) => entry.kind === "file" && /^[^/]+\/SKILL\.md$/.test(entry.path))
    .map((entry) => entry.path.slice(0, -"/SKILL.md".length))
    .sort();

/** The folders under the folder, "" for the folder itself, as the read listed them. */
const foldersOf = (tree: SkillTree): ReadonlyArray<string> => [
  "",
  ...tree.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
];

/** Whether nothing is at `path`: the one case read as an empty folder. */
const isMissing = (path: string) =>
  lstat(path).then(
    () => false,
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );

/**
 * Reads every skill in the folder. A folder that is not there reads as empty; any other failure,
 * such as a folder it may not read or a file gone in the middle, fails the read, so the skills
 * already taken keep their assignments rather than being let go.
 */
const readFolder = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (await isMissing(path)) return { skills: [], folders: [] };
      const tree = await folderTree(path);
      const skills = [];
      for (const folder of skillFoldersOf(tree))
        skills.push(await checkSkill(tree, { folder, dropped: [], plugin: null }));
      return { skills, folders: foldersOf(tree) };
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

const problemOf = (folder: string, fields: Partial<AgentsFolderProblem>): AgentsFolderProblem => ({
  folder,
  refusal: null,
  takenBy: null,
  unreadable: null,
  ...fields,
});

/**
 * One plain watch on each folder under `path`, never a recursive one: on Linux, Node's recursive
 * watch reads the tree itself on each event and throws, out of reach, when a folder in it is
 * replaced by a file. A plain watch only reports, and its errors arrive as its `error` event. Each
 * read re-arms the watches from what it listed; a folder replaced since gets a new one.
 */
const folderWatches = (path: string, changed: () => void) => {
  const watches = new Map<string, { readonly watcher: FSWatcher; readonly ino: number }>();
  let armed = false;

  const drop = (folder: string) => {
    watches.get(folder)?.watcher.close();
    watches.delete(folder);
  };

  const arm = (folder: string, ino: number) => {
    try {
      const watcher = watch(join(path, folder), () => changed());
      // The folder went or changed under the watch: let it go, and read again to see what is there.
      watcher.on("error", () => {
        if (watches.get(folder)?.watcher === watcher) drop(folder);
        changed();
      });
      watches.set(folder, { watcher, ino });
      return true;
    } catch {
      // Gone since the read; the read it set off will see that.
      return false;
    }
  };

  /** Watches exactly `folders`; one new since the last read sets off another, for what it got before its watch. */
  const rewatch = async (folders: ReadonlyArray<string>) => {
    const wanted = new Set(folders);
    for (const folder of [...watches.keys()]) if (!wanted.has(folder)) drop(folder);
    let added = false;
    for (const folder of folders) {
      const stats = await stat(join(path, folder)).catch(() => null);
      const known = watches.get(folder);
      if (stats === null || !stats.isDirectory()) {
        drop(folder);
        continue;
      }
      if (known?.ino === Number(stats.ino)) continue;
      drop(folder);
      added = arm(folder, Number(stats.ino)) || added;
    }
    if (added && armed) changed();
    armed = true;
  };

  const close = () => {
    for (const folder of [...watches.keys()]) drop(folder);
  };

  return { rewatch, close };
};

/** Syncs `~/.agents/skills` at `path` now, then whenever it changes and every five minutes. */
export const AgentsFolderLive = (path: string = defaultAgentsFolder()) =>
  Layer.effect(
    AgentsFolder,
    Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const objects = yield* SkillObjects;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill from ~/.agents/skills");
      const problems = yield* Ref.make<ReadonlyArray<AgentsFolderProblem>>([]);
      const origin = { _tag: "AgentsFolder", path } as const;

      /** Whether a library skill is the one the folder keeps. */
      const fromFolder = (skill: Skill) =>
        Effect.map(library.sources, (sources) =>
          sources.some((source) => source.id === skill.sourceId && source.origin._tag === "AgentsFolder"),
        );

      /** Adds the folder's copy as a revision, assigns it to Everyone, and rolls it out to its assignments. */
      const take = (checked: CheckedSkill, existing: Skill | null) =>
        Effect.gen(function* () {
          yield* objects.put(checked.hash, checked.contents);
          const added = yield* library.addRevision(existing?.id ?? null, {
            hash: checked.hash,
            name: checked.name,
            description: checked.description,
            charms: checked.charms,
            files: checked.files,
            flags: checked.flags,
            dropped: checked.dropped,
            origin,
            commit: null,
            path: checked.folder,
            label: checked.label,
            addedBy: { _tag: "You" },
          });
          yield* announce(added.entries);
          const { skill } = added.value;
          const by: SkillBy = skill.sourceId === null ? { _tag: "You" } : { _tag: "Source", sourceId: skill.sourceId };
          const assignments = yield* library.assignments(skill.id);
          if (!assignments.some((one) => one.scope._tag === "Everyone")) {
            const assigned = yield* library.assign({
              skillId: skill.id,
              scope: { _tag: "Everyone" },
              pin: checked.hash,
              held: false,
              onlyWhenAsked: false,
              by,
            });
            yield* announce(assigned.entries);
          }
          // A changed copy rolls out like your own edit, once: an unchanged one leaves a rollback as it is.
          const { revision } = added.value;
          if (revision.rolledOutAt === null) {
            yield* announce((yield* library.rollOutRevision(skill.id, revision.hash, by, "pending")).entries);
          }
        });

      /** Takes the Everyone assignment off a folder skill whose folder is gone; the skill stays in the library. */
      const letGo = (skill: Skill) =>
        Effect.gen(function* () {
          for (const assignment of yield* library.assignments(skill.id)) {
            if (assignment.scope._tag !== "Everyone") continue;
            const removed = yield* library.unassign(assignment.id);
            if (removed !== null) yield* announce(removed.entries);
          }
        });

      /** Brings the library in line with a full read of the folder. */
      const reconcile = (results: Effect.Success<ReturnType<typeof readFolder>>["skills"]) =>
        Effect.gen(function* () {
          const found: Array<AgentsFolderProblem> = [];
          const present = new Set<SkillName>();
          for (const result of results) {
            if (result._tag === "Refused") {
              found.push(problemOf(result.folder, { refusal: result.refusal }));
              continue;
            }
            const existing = yield* library.byName(result.skill.name);
            if (existing !== null && !(yield* fromFolder(existing))) {
              found.push(problemOf(result.skill.folder, { takenBy: existing.name }));
              continue;
            }
            present.add(result.skill.name);
            yield* take(result.skill, existing).pipe(
              Effect.catchTags({
                SkillNameTaken: (error) =>
                  Effect.sync(() => found.push(problemOf(result.skill.folder, { takenBy: error.name }))),
                SkillNameChanged: () => Effect.void,
                SkillNotFound: () => Effect.void,
              }),
            );
          }
          for (const skill of yield* library.list) {
            if (!present.has(skill.name) && (yield* fromFolder(skill))) yield* letGo(skill);
          }
          return found;
        });

      // A change in the folder asks for a sync; several in a row make one, a second later.
      const changes = yield* Queue.sliding<void>(1);
      const watches = yield* Effect.acquireRelease(
        Effect.sync(() => folderWatches(path, () => Queue.offerUnsafe(changes, undefined))),
        (watching) => Effect.sync(watching.close),
      );

      const once = yield* Semaphore.make(1);
      const sync = readFolder(path).pipe(
        Effect.matchEffect({
          onSuccess: ({ skills, folders }) =>
            Effect.andThen(
              Effect.promise(() => watches.rewatch(folders)),
              reconcile(skills),
            ),
          onFailure: (message) =>
            Effect.as(Effect.logWarning("Could not read ~/.agents/skills", message), [
              problemOf("", { unreadable: message }),
            ]),
        }),
        Effect.flatMap((found) => Ref.set(problems, found)),
        Effect.catchCause((cause) => Effect.logWarning("Could not read ~/.agents/skills", cause)),
        once.withPermits(1),
      );

      yield* sync;
      yield* Queue.take(changes).pipe(
        Effect.andThen(Effect.sleep(Duration.seconds(1))),
        Effect.andThen(sync),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* sync.pipe(
        Effect.repeat(Schedule.spaced(Duration.minutes(5))),
        Effect.delay(Duration.minutes(5)),
        Effect.forkScoped,
      );

      return AgentsFolder.of({ path, sync, problems: Ref.get(problems) });
    }),
  );
