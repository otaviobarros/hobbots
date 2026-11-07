import { announcer, EventPublisher, SkillLibrary, type SkillRevisionAdded } from "@hobbots/agents";
import {
  type SkillBy,
  type SkillDropped,
  type SkillFlag,
  type SkillId,
  type SkillMovedOn,
  type SkillName,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  type SkillOrigin,
  type SkillRefused,
  type SkillRevisionHash,
  SkillSourceChanged,
  SkillSourceUnreadable,
} from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import { type CheckedSkill, type CheckResult, checkSkill } from "./check.ts";
import { editedTree, type SkillEdit } from "./edit.ts";
import { findSkills } from "./find.ts";
import { type LockedSkill, readLock } from "./lock.ts";
import { archiveTree } from "./sources/archive.ts";
import { folderTree } from "./sources/folder.ts";
import { gitTree } from "./sources/git.ts";
import { SkillObjects } from "./store.ts";
import { parentOf, type SkillTree, type TreeEntry, TreeUnreadable } from "./tree.ts";

/** What a skill is imported from (ADR 029, Import). */
export type SkillImportSource =
  | { readonly _tag: "Folder"; readonly path: string }
  | { readonly _tag: "Archive"; readonly fileName: string; readonly bytes: Uint8Array }
  | { readonly _tag: "Git"; readonly url: string; readonly ref: string | null }
  /** Written in Hobbots: each file's path in the skill and its text. */
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }> }
  /** A revision's folder, edited in Hobbots: its other files are kept as they are. */
  | ({
      readonly _tag: "Edited";
      readonly folder: string;
      /**
       * What the base revision recorded that its stored files no longer show, such as a Charm named in
       * an `agents/openai.yaml` the import left out: the edit keeps it.
       */
      readonly carried: { readonly charms: ReadonlyArray<string>; readonly dropped: ReadonlyArray<SkillDropped> };
    } & SkillEdit);

/** One skill a source holds, as import would take it, or the rule it broke. */
export interface SkillCandidate {
  /** Its folder in the source, "" when the source is the skill. */
  readonly folder: string;
  readonly name: SkillName | null;
  readonly description: string | null;
  readonly hash: SkillRevisionHash | null;
  readonly flags: ReadonlyArray<SkillFlag>;
  readonly dropped: ReadonlyArray<SkillDropped>;
  readonly charms: ReadonlyArray<string>;
  readonly label: string | null;
  readonly refusal: SkillRefused | null;
  /** What the source's `skills-lock.json` says of it: whether this copy is the locked one, and its source. */
  readonly locked: { readonly matches: boolean; readonly url: string | null } | null;
  /**
   * The library's skill of that name: `number` is the revision this content already is, or null
   * when it would be a new revision of it.
   */
  readonly existing: { readonly skillId: SkillId; readonly number: number | null } | null;
}

/** What a source holds. */
export interface SkillScan {
  readonly commit: string | null;
  readonly candidates: ReadonlyArray<SkillCandidate>;
}

export interface SkillImportOptions {
  /** The folders to take, from a scan; all of them when absent. */
  readonly folders?: ReadonlyArray<string>;
  /**
   * What a scan found in each folder taken, by content hash: the import fails with `SkillSourceChanged`
   * when the source now holds anything else, so only what you looked at is added.
   */
  readonly scanned?: ReadonlyMap<string, SkillRevisionHash>;
  /** The skill the one folder taken is a new revision of; a new skill when absent. */
  readonly skillId?: SkillId;
  /** The revision of `skillId` the new one was made from; the import fails once the skill's newest is another. */
  readonly after?: SkillRevisionHash;
  readonly by: SkillBy;
}

export type SkillImportError =
  | SkillSourceUnreadable
  | SkillRefused
  | SkillNotFound
  | SkillNameTaken
  | SkillNameChanged
  | SkillMovedOn
  | SkillSourceChanged;

export interface SkillImporterShape {
  /** Lists the skills a source holds, checked, writing nothing. */
  readonly scan: (source: SkillImportSource) => Effect.Effect<SkillScan, SkillSourceUnreadable>;
  /**
   * Adds the skills a source holds to the library, each as a new skill or a new revision of
   * `skillId`. Every one is checked first, and a refusal writes nothing. Content the library has
   * answers its revision again, unchanged.
   */
  readonly add: (
    source: SkillImportSource,
    options: SkillImportOptions,
  ) => Effect.Effect<ReadonlyArray<SkillRevisionAdded>, SkillImportError>;
}

export class SkillImporter extends Context.Service<SkillImporter, SkillImporterShape>()(
  "@hobbots/skills/SkillImporter",
) {}

const encoder = new TextEncoder();

/** A skill written in Hobbots, as a source like any other. */
const writtenTree = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>): SkillTree => {
  const bytes = new Map(files.map((file) => [file.path, encoder.encode(file.text)]));
  const folders = new Set(files.flatMap((file) => (parentOf(file.path) === "" ? [] : [parentOf(file.path)])));
  const entries: Array<TreeEntry> = [
    ...[...folders].map((path): TreeEntry => ({ path, kind: "directory", executable: false, size: 0 })),
    ...[...bytes].map(
      ([path, content]): TreeEntry => ({ path, kind: "file", executable: false, size: content.length }),
    ),
  ];
  return { entries, commit: null, read: async (path) => bytes.get(path) ?? new Uint8Array() };
};

const unreadable = (error: unknown) =>
  error instanceof TreeUnreadable ? new SkillSourceUnreadable({ message: error.message }) : null;

/** Opens a source for the rest of the scope, and removes what fetching it left behind afterwards. */
const openTree = (source: SkillImportSource) => {
  const open = (): Promise<SkillTree & { readonly close?: () => Promise<void> }> => {
    switch (source._tag) {
      case "Folder":
        return folderTree(source.path);
      case "Archive":
        return archiveTree(source.bytes);
      case "Git":
        return gitTree(source.url, source.ref);
      case "Written":
        return Promise.resolve(writtenTree(source.files));
      case "Edited":
        return editedTree(source.folder, source);
    }
  };
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: open,
      catch: (error) => unreadable(error) ?? new SkillSourceUnreadable({ message: String(error) }),
    }),
    (tree) => Effect.promise(() => tree.close?.() ?? Promise.resolve()),
  );
};

/** Reads and checks every skill of a source; a read that fails partway is the source's failure. */
const checkAll = (tree: SkillTree) =>
  Effect.tryPromise({
    try: async () => {
      const found = findSkills(tree);
      const lock = await readLock(tree);
      const results: Array<{ readonly result: CheckResult; readonly locked: LockedSkill | null }> = [];
      for (const one of found) {
        const result = await checkSkill(tree, one);
        const name = result._tag === "Passed" ? result.skill.name : null;
        results.push({ result, locked: name === null ? null : (lock.get(name) ?? null) });
      }
      return results;
    },
    catch: (error) => unreadable(error) ?? new SkillSourceUnreadable({ message: String(error) }),
  });

const originOf = (source: SkillImportSource, locked: LockedSkill | null): SkillOrigin | null => {
  // A skill the `skills` CLI installed is followed at the source it came from.
  if (locked?.url != null) return { _tag: "Git", url: locked.url, ref: locked.ref };
  switch (source._tag) {
    case "Folder":
      return { _tag: "Folder", path: source.path };
    case "Archive":
      return { _tag: "Archive", fileName: source.fileName };
    case "Git":
      return { _tag: "Git", url: source.url, ref: source.ref };
    case "Written":
    case "Edited":
      return null;
  }
};

type Carried = Extract<SkillImportSource, { readonly _tag: "Edited" }>["carried"];

/** An edit's Charms: what its files name now, and what its base recorded from files it left out. */
const carriedCharms = (skill: CheckedSkill, carried: Carried) =>
  [...new Set([...skill.charms, ...carried.charms])].sort();

/** An edit's left-out content: its own, and its base's, once each. */
const carriedDropped = (skill: CheckedSkill, carried: Carried) => {
  const seen = new Set(skill.dropped.map((one) => `${one.kind}\u0000${one.path}`));
  return [...skill.dropped, ...carried.dropped.filter((one) => !seen.has(`${one.kind}\u0000${one.path}`))];
};

const lockedOf = (skill: CheckedSkill, locked: LockedSkill | null) =>
  locked === null ? null : { matches: locked.computedHash === skill.cliHash, url: locked.url };

export const SkillImporterLive = Layer.effect(
  SkillImporter,
  Effect.gen(function* () {
    const library = yield* SkillLibrary;
    const objects = yield* SkillObjects;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill import");

    const existingOf = (skill: CheckedSkill) =>
      Effect.gen(function* () {
        const named = yield* library.byName(skill.name);
        if (named === null) return null;
        const revision = yield* library.revision(named.id, skill.hash);
        return { skillId: named.id, number: revision?.number ?? null };
      });

    const candidateOf = ({ result, locked }: { readonly result: CheckResult; readonly locked: LockedSkill | null }) =>
      Effect.gen(function* () {
        if (result._tag === "Refused") {
          const none = { name: null, description: null, hash: null, label: null, locked: null, existing: null };
          return { folder: result.folder, ...none, flags: [], dropped: [], charms: [], refusal: result.refusal };
        }
        const { skill } = result;
        return {
          folder: skill.folder,
          name: skill.name,
          description: skill.description,
          hash: skill.hash,
          flags: skill.flags,
          dropped: skill.dropped,
          charms: skill.charms,
          label: skill.label,
          refusal: null,
          locked: lockedOf(skill, locked),
          existing: yield* existingOf(skill),
        } satisfies SkillCandidate;
      });

    const scan = (source: SkillImportSource) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* openTree(source);
          const checked = yield* checkAll(tree);
          return { commit: tree.commit, candidates: yield* Effect.forEach(checked, candidateOf) };
        }),
      );

    /** The checked skills to take, failing on the first refusal or a folder the source does not hold. */
    const picked = (
      checked: ReadonlyArray<{ readonly result: CheckResult; readonly locked: LockedSkill | null }>,
      options: SkillImportOptions,
    ) =>
      Effect.gen(function* () {
        const folders =
          options.folders ??
          checked.map((one) => (one.result._tag === "Passed" ? one.result.skill.folder : one.result.folder));
        const chosen = [];
        for (const folder of folders) {
          const one = checked.find(
            (each) => (each.result._tag === "Passed" ? each.result.skill.folder : each.result.folder) === folder,
          );
          if (one === undefined) return yield* new SkillNotFound({ id: folder });
          if (one.result._tag === "Refused") return yield* one.result.refusal;
          chosen.push({ skill: one.result.skill, locked: one.locked });
        }
        if (chosen.length === 0) return yield* new SkillSourceUnreadable({ message: "There is no SKILL.md in it." });
        if (options.skillId !== undefined && chosen.length > 1) {
          return yield* new SkillSourceUnreadable({ message: "Pick the one skill to take a new revision from." });
        }
        return chosen;
      });

    /** Fails on a name another skill has, before any file is written. */
    const checkName = (skill: CheckedSkill, skillId: SkillId | undefined) =>
      Effect.gen(function* () {
        if (skillId !== undefined) {
          const target = yield* library.get(skillId);
          if (target === null) return yield* new SkillNotFound({ id: skillId });
          if (target.name !== skill.name) {
            return yield* new SkillNameChanged({ skillId, name: target.name, given: skill.name });
          }
          return;
        }
        const existing = yield* existingOf(skill);
        if (existing !== null && existing.number === null) {
          return yield* new SkillNameTaken({ name: skill.name, skillId: existing.skillId });
        }
      });

    const add = (source: SkillImportSource, options: SkillImportOptions) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* openTree(source);
          const chosen = yield* picked(yield* checkAll(tree), options);
          if (options.scanned !== undefined) {
            const scanned = options.scanned;
            const moved = chosen.find(({ skill }) => scanned.get(skill.folder) !== skill.hash);
            if (moved !== undefined) return yield* new SkillSourceChanged({ folder: moved.skill.folder });
          }
          yield* Effect.forEach(chosen, ({ skill }) => checkName(skill, options.skillId), { discard: true });
          return yield* Effect.forEach(chosen, ({ skill, locked }) =>
            Effect.gen(function* () {
              yield* objects.put(skill.hash, skill.contents);
              const committed = yield* library.addRevision(options.skillId ?? null, {
                hash: skill.hash,
                name: skill.name,
                description: skill.description,
                charms: source._tag === "Edited" ? carriedCharms(skill, source.carried) : skill.charms,
                files: skill.files,
                flags: skill.flags,
                dropped: source._tag === "Edited" ? carriedDropped(skill, source.carried) : skill.dropped,
                origin: originOf(source, locked),
                commit: locked?.url != null ? null : tree.commit,
                path: locked?.url != null ? locked.path : skill.folder === "" ? null : skill.folder,
                label: skill.label,
                addedBy: options.by,
                ...(options.after === undefined ? {} : { after: options.after }),
              });
              yield* announce(committed.entries);
              return committed.value;
            }),
          );
        }),
      );

    return SkillImporter.of({ scan, add });
  }),
);
