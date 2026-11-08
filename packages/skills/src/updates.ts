import {
  announcer,
  EventPublisher,
  SkillFiles,
  type SkillImportError,
  SkillLibrary,
  type SkillRevisionAdded,
  SkillUpdateLog,
} from "@hobbots/agents";
import {
  type Skill,
  type SkillAssignment,
  type SkillBy,
  type SkillId,
  SkillNotFound,
  type SkillRevision,
  type SkillRevisionHash,
  type SkillSource,
  SkillUpdate,
  type SkillUpdateProblem,
  skillUpdateIsClean,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Result, Semaphore } from "effect";
import type { CheckedSkill } from "./check.ts";
import { SkillImporter, type SourceRead, type SourceSkill } from "./importer.ts";
import { fileChangesOf, isInstructions, keptInstructions, raisedFlags } from "./update-review.ts";

/**
 * Updates from a source (ADR 029, #1097): the hub checks each skill imported from Git once a day and
 * on Check now, without changing the library. An upstream change waits in Updates with its review until
 * you accept it, which adds it as a new revision and rolls it out like your own edit. On a skill set
 * to Update automatically a clean update is accepted by the check itself, by the source; one that
 * raises a flag waits for you whatever the setting.
 */

/** A Git source as the library records it. */
type GitSource = SkillSource & { readonly origin: Extract<SkillSource["origin"], { readonly _tag: "Git" }> };

const isGit = (source: SkillSource): source is GitSource => source.origin._tag === "Git";

/** What one check did: when it ran, the sources or skills it could not read, and the skills it updated by itself. */
export interface SkillUpdateCheckDone {
  readonly checkedAt: string;
  readonly problems: ReadonlyArray<SkillUpdateProblem>;
  readonly updated: ReadonlyArray<SkillId>;
}

/** An accepted update: the revision it added, and the assignments its rollout moved. */
export interface SkillUpdateAccepted extends SkillRevisionAdded {
  readonly rolledOut: ReadonlyArray<SkillAssignment>;
}

export interface SkillUpdatesShape {
  /** Checks every Git source the library follows, one check at a time, and records when it ran. */
  readonly check: Effect.Effect<SkillUpdateCheckDone>;
  /**
   * Accepts a skill's waiting update of `hash`: reads it from its source again, adds it as a new
   * revision only while the source still holds exactly that content and the skill's newest is still
   * the revision it was compared with, then rolls it out to every assignment that is not held.
   */
  readonly accept: (
    skillId: SkillId,
    hash: SkillRevisionHash,
    by: SkillBy,
  ) => Effect.Effect<SkillUpdateAccepted, SkillImportError>;
}

export class SkillUpdates extends Context.Service<SkillUpdates, SkillUpdatesShape>()("@hobbots/skills/SkillUpdates") {}

const decoder = new TextDecoder();

/** The upstream `SKILL.md` at `path`, as text. */
const upstreamText = (skill: CheckedSkill, path: string): string | null => {
  const file = skill.contents.find((one) => one.path === path);
  return file === undefined ? null : decoder.decode(file.bytes);
};

/** Why a skill of a source cannot be compared with what the source holds now, or null when it can. */
const mismatchOf = (skill: Skill, latest: SkillRevision, found: SourceSkill | undefined, url: string) => {
  if (found === undefined) return `${url} no longer holds ${skill.name}.`;
  if (found.refusal !== null) return `${skill.name} from ${url}: ${found.refusal.message}`;
  if (found.skill === null) return `${url} no longer holds ${skill.name}.`;
  if (found.skill.name !== skill.name) return `${skill.name} is named ${found.skill.name} in ${url} now.`;
  if ((found.skill.set === null) !== (latest.set === null))
    return found.skill.set === null
      ? `${skill.name} is no longer a set in ${url}.`
      : `${skill.name} is a set in ${url} now.`;
  return null;
};

export const SkillUpdatesLive = Layer.effect(
  SkillUpdates,
  Effect.gen(function* () {
    const library = yield* SkillLibrary;
    const importer = yield* SkillImporter;
    const files = yield* SkillFiles;
    const log = yield* SkillUpdateLog;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill update");
    const one = yield* Semaphore.make(1);

    /** A revision's `SKILL.md` at `path`, as text, or null when it has none. */
    const storedText = (hash: SkillRevisionHash, path: string) =>
      files.read(hash, path).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.orElseSucceed(() => null),
      );

    /** The update `upstream` is for `skill`, with its review against the skill's newest revision. */
    const updateOf = (
      skill: Skill,
      latest: SkillRevision,
      source: GitSource,
      upstream: CheckedSkill,
      read: { readonly commit: string | null; readonly at: string },
    ) =>
      Effect.gen(function* () {
        const changed = fileChangesOf(latest.files, upstream.files);
        const instructions = yield* Effect.forEach(
          changed.filter((file) => isInstructions(file.path)),
          (file) =>
            Effect.map(
              file.change === "added" ? Effect.succeed(null) : storedText(latest.hash, file.path),
              (before) => ({
                path: file.path,
                before: keptInstructions(before),
                after: keptInstructions(file.change === "removed" ? null : upstreamText(upstream, file.path)),
              }),
            ),
        );
        return new SkillUpdate({
          skillId: skill.id,
          name: skill.name,
          sourceId: source.id,
          base: latest.hash,
          baseNumber: latest.number,
          hash: upstream.hash,
          commit: read.commit,
          label: upstream.label,
          path: upstream.folder === "" ? null : upstream.folder,
          files: changed,
          instructions,
          flags: raisedFlags(latest.flags, changed, upstream.flags),
          state: "waiting",
          foundAt: read.at,
        });
      });

    const accept: SkillUpdatesShape["accept"] = (skillId, hash, by) =>
      Effect.gen(function* () {
        const update = yield* log.get(skillId);
        if (update === null || update.hash !== hash) return yield* new SkillNotFound({ id: hash });
        const source = (yield* library.sources).find((one) => one.id === update.sourceId);
        if (source === undefined || !isGit(source)) return yield* new SkillNotFound({ id: update.sourceId });
        const folder = update.path ?? "";
        const [added] = yield* importer.add(
          { _tag: "Git", url: source.origin.url, ref: source.origin.ref },
          { skillId, folders: [folder], scanned: new Map([[folder, hash]]), after: update.base, by },
        );
        if (added === undefined) return yield* new SkillNotFound({ id: hash });
        const rolledOut = yield* library.rollOutRevision(skillId, added.revision.hash, by, "pending");
        yield* announce(rolledOut.entries);
        const cleared = yield* log.clear(skillId, hash);
        if (cleared !== null) yield* announce(cleared.entries);
        return { ...added, rolledOut: rolledOut.value };
      });

    /** Compares one skill of `source` with what the source holds now; a problem when it cannot. */
    const checkSkill = (
      skill: Skill,
      source: GitSource,
      read: SourceRead,
      context: { readonly at: string; readonly automatic: ReadonlySet<SkillId> },
    ) =>
      Effect.gen(function* (): Effect.fn.Return<{ readonly problem: string | null; readonly updated: boolean }> {
        const revisions = yield* library.revisions(skill.id);
        const [latest] = revisions;
        const fromSource = revisions.find((revision) => revision.sourceId === source.id);
        if (latest === undefined || fromSource === undefined) return { problem: null, updated: false };
        const found = read.skills.find((candidate) => candidate.folder === (fromSource.path ?? ""));
        const problem = mismatchOf(skill, latest, found, source.origin.url);
        if (problem !== null) return { problem, updated: false };
        const upstream = found?.skill;
        if (upstream == null) return { problem: null, updated: false };
        // Content the library has already, upstream unchanged or back to an earlier revision, is no update.
        if (revisions.some((revision) => revision.hash === upstream.hash)) {
          const cleared = yield* log.clear(skill.id);
          if (cleared !== null) yield* announce(cleared.entries);
          return { problem: null, updated: false };
        }
        const update = yield* updateOf(skill, latest, source, upstream, { commit: read.commit, at: context.at });
        const recorded = yield* log.found(update);
        if (recorded !== null) yield* announce(recorded.entries);
        const current = yield* log.get(skill.id);
        const automatic =
          context.automatic.has(skill.id) &&
          current?.state === "waiting" &&
          current.hash === update.hash &&
          skillUpdateIsClean(current);
        if (!automatic) return { problem: null, updated: false };
        const applied = yield* Effect.result(accept(skill.id, update.hash, { _tag: "Source", sourceId: source.id }));
        return Result.isSuccess(applied)
          ? { problem: null, updated: true }
          : { problem: `${skill.name} could not update by itself: ${applied.failure._tag}.`, updated: false };
      });

    /** Reads one source and checks each of its skills. */
    const checkSource = (
      source: GitSource,
      skills: ReadonlyArray<Skill>,
      context: { readonly at: string; readonly automatic: ReadonlySet<SkillId> },
    ) =>
      Effect.gen(function* () {
        const read = yield* Effect.result(
          importer.read({ _tag: "Git", url: source.origin.url, ref: source.origin.ref }),
        );
        if (Result.isFailure(read))
          return { problems: [{ sourceId: source.id, message: read.failure.message }], updated: [] };
        const problems: Array<SkillUpdateProblem> = [];
        const updated: Array<SkillId> = [];
        for (const skill of skills) {
          const done = yield* checkSkill(skill, source, read.success, context);
          if (done.problem !== null) problems.push({ sourceId: source.id, message: done.problem });
          if (done.updated) updated.push(skill.id);
        }
        return { problems, updated };
      });

    const check = Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const sources = (yield* library.sources).filter(isGit);
      const skills = yield* library.list;
      const automatic = new Set(yield* log.automatic);
      const problems: Array<SkillUpdateProblem> = [];
      const updated: Array<SkillId> = [];
      for (const source of sources) {
        const followed = skills.filter((skill) => skill.sourceId === source.id);
        if (followed.length === 0) continue;
        const done = yield* checkSource(source, followed, { at, automatic });
        problems.push(...done.problems);
        updated.push(...done.updated);
      }
      yield* log.checked(at, problems);
      return { checkedAt: at, problems, updated };
    }).pipe(one.withPermits(1));

    return SkillUpdates.of({ check, accept });
  }),
);
