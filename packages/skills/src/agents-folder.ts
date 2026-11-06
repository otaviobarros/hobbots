import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { announcer, EventPublisher, rolloutTargets, SkillLibrary } from "@hobbots/agents";
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

/** A skill in the folder that the hub did not take, and why. */
export interface AgentsFolderProblem {
  /** Its folder's name under `~/.agents/skills`. */
  readonly folder: string;
  readonly refusal: SkillRefused | null;
  /** Set when the library already has a skill of its name from somewhere else. */
  readonly takenBy: SkillName | null;
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

const readFolder = (path: string) =>
  Effect.promise(async () => {
    const tree = await folderTree(path).catch(() => null);
    if (tree === null) return [];
    const results = [];
    for (const folder of skillFoldersOf(tree))
      results.push(await checkSkill(tree, { folder, dropped: [], plugin: null }));
    return results;
  });

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
          for (const target of rolloutTargets(assignments, skill.id, checked.hash)) {
            yield* announce((yield* library.rollOut(target.id, checked.hash, by)).entries);
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

      const once = yield* Semaphore.make(1);
      const sync = Effect.gen(function* () {
        const found: Array<AgentsFolderProblem> = [];
        const present = new Set<SkillName>();
        for (const result of yield* readFolder(path)) {
          if (result._tag === "Refused") {
            found.push({ folder: result.folder, refusal: result.refusal, takenBy: null });
            continue;
          }
          const existing = yield* library.byName(result.skill.name);
          if (existing !== null && !(yield* fromFolder(existing))) {
            found.push({ folder: result.skill.folder, refusal: null, takenBy: existing.name });
            continue;
          }
          present.add(result.skill.name);
          yield* take(result.skill, existing).pipe(
            Effect.catchTags({
              SkillNameTaken: (error) =>
                Effect.sync(() => found.push({ folder: result.skill.folder, refusal: null, takenBy: error.name })),
              SkillNameChanged: () => Effect.void,
              SkillNotFound: () => Effect.void,
            }),
          );
        }
        for (const skill of yield* library.list) {
          if (!present.has(skill.name) && (yield* fromFolder(skill))) yield* letGo(skill);
        }
        yield* Ref.set(problems, found);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not read ~/.agents/skills", cause)),
        once.withPermits(1),
      );

      // A change in the folder asks for a sync; several in a row make one, a second later.
      const changes = yield* Queue.sliding<void>(1);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          try {
            return watch(path, { recursive: true }, () => Queue.offerUnsafe(changes, undefined));
          } catch {
            return null;
          }
        }),
        (watcher) => Effect.sync(() => watcher?.close()),
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
