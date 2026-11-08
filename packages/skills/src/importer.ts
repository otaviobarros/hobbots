import { createHash } from "node:crypto";
import {
  announcer,
  EventPublisher,
  type SkillImportError,
  SkillLibrary,
  type SkillRevisionAdded,
  type SkillRevisionInput,
  type WrittenFile,
} from "@hobbots/agents";
import {
  type AgentId,
  type MemoryProjectIdentity,
  type SkillAssignment,
  type SkillBy,
  type SkillDropped,
  type SkillFlag,
  type SkillId,
  type SkillName,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  type SkillOrigin,
  SkillRefused,
  type SkillRevisionHash,
  type SkillSetContent,
  type SkillSetSkill,
  SkillSourceChanged,
  SkillSourceUnreadable,
} from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import { type CheckedSkill, type CheckResult, checkSet, checkSkill } from "./check.ts";
import { copiedTree, editedTree, memberCopyTree, type SkillEdit } from "./edit.ts";
import {
  decodeSkillsLock,
  type LockedSkill as ExportedSkill,
  type LockedAssignment,
  type LockedRevision,
  OLDER_REVISIONS,
  SKILLS_LOCK_FILE,
  type SkillsLock,
} from "./exports.ts";
import { type FoundSet, findSkills, pluginSets, repositorySetFolder, siblingsOf } from "./find.ts";
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
  | { readonly _tag: "Written"; readonly files: ReadonlyArray<WrittenFile> }
  /** A revision's folder, edited in Hobbots: its other files are kept as they are. */
  | ({
      readonly _tag: "Edited";
      readonly folder: string;
      /**
       * What the base revision recorded that its stored files no longer show, such as a Charm named in
       * an `agents/openai.yaml` the import left out: the edit keeps it.
       */
      readonly carried: { readonly charms: ReadonlyArray<string>; readonly dropped: ReadonlyArray<SkillDropped> };
    } & SkillEdit)
  /**
   * A copy of a revision under a new name (ADR 029, Make a copy): its files as they are, its
   * `SKILL.md` renamed, written in Hobbots with no source.
   */
  | {
      readonly _tag: "Copied";
      readonly folder: string;
      readonly name: SkillName;
      readonly carried: { readonly charms: ReadonlyArray<string>; readonly dropped: ReadonlyArray<SkillDropped> };
      /**
       * For a set's revision (ADR 029, Skill sets), the one of its skills copied: its folder, and the
       * set's files it links to under `linked/`, with those links pointed at them.
       */
      readonly member?: SkillSetSkill;
    };

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
  /** For a set (ADR 029, Skill sets), the skills it holds; null for a skill. */
  readonly set: SkillSetContent | null;
  /** For a set, the files it keeps outside its skills' folders, which they share; empty for a skill. */
  readonly shared: ReadonlyArray<string>;
  readonly refusal: SkillRefused | null;
  /**
   * What the source's lock says of it, the `skills` CLI's `skills-lock.json` or a Hobbots export's
   * `skills.lock.json`: whether this copy is the locked one, and its Git source.
   */
  readonly locked: { readonly matches: boolean; readonly url: string | null } | null;
  /**
   * What a Hobbots export's `skills.lock.json` says of it: whether this copy is still exactly the
   * exported revision, and how many older revisions and assignments come with it. Null outside an export.
   */
  readonly exported: {
    readonly matches: boolean;
    /** The older revisions import adds with it, oldest first: only for a skill new to this library. */
    readonly older: ReadonlyArray<OlderRevisionCheck>;
    readonly assignments: number;
  } | null;
  /**
   * The library's skill of that name: `number` is the revision this content already is, or null
   * when it would be a new revision of it.
   */
  readonly existing: { readonly skillId: SkillId; readonly number: number | null } | null;
}

/**
 * An older revision an export brings with a skill, as import checks it: its number on the hub that
 * exported it, what import notes of it, and whether its files are still that revision.
 */
export interface OlderRevisionCheck {
  readonly number: number;
  readonly hash: SkillRevisionHash;
  readonly matches: boolean;
  readonly flags: ReadonlyArray<SkillFlag>;
  readonly dropped: ReadonlyArray<SkillDropped>;
  readonly refusal: SkillRefused | null;
}

/** What a Hobbots export says of itself (ADR 029, Backups, exports and Diagnostics). */
export interface SkillScanExport {
  readonly exportedAt: string;
  readonly skills: number;
  /** The assignments it keeps, in all: who gets each skill on the hub that exported it. */
  readonly assignments: number;
  /** The SHA-256 of its `skills.lock.json`, which says who gets each skill: an import checks it is unchanged. */
  readonly lock: string;
}

/** What a source holds. */
export interface SkillScan {
  readonly commit: string | null;
  readonly candidates: ReadonlyArray<SkillCandidate>;
  /** Set when the source is a Hobbots export with its `skills.lock.json`. */
  readonly exported: SkillScanExport | null;
}

export interface SkillImportOptions {
  /** The folders to take, from a scan; all of them when absent. */
  readonly folders?: ReadonlyArray<string>;
  /**
   * What a scan found in each folder taken, by content hash: the import fails with `SkillSourceChanged`
   * when the source now holds anything else, so only what you looked at is added.
   */
  readonly scanned?: ReadonlyMap<string, SkillRevisionHash>;
  /**
   * With `scanned`: the scan's export lock (`SkillScanExport.lock`), or null when it found none. The
   * import fails with `SkillSourceChanged` when the source's export lock is now another, or gone.
   */
  readonly scannedLock?: string | null;
  /** The skill the one folder taken is a new revision of; a new skill when absent. */
  readonly skillId?: SkillId;
  /** The revision of `skillId` the new one was made from; the import fails once the skill's newest is another. */
  readonly after?: SkillRevisionHash;
  readonly by: SkillBy;
}

export type { SkillImportError, WrittenFile } from "@hobbots/agents";

/** A hob an exported assignment names: its id on the hub that exported it, and its name there. */
export interface ExportedHob {
  readonly agentId: AgentId;
  readonly name: string | null;
}

/** What importing a set added: the revisions, the assignments the export kept, and how many found no hob. */
export interface SkillSetAdded {
  readonly imported: ReadonlyArray<SkillRevisionAdded>;
  readonly assigned: ReadonlyArray<SkillAssignment>;
  /**
   * Exported assignments this hub could not give: a hob or a project it does not have, or a revision
   * it did not take.
   */
  readonly leftOut: number;
}

/** A skill or set a source holds, checked with its files, or the rule it broke. */
export interface SourceSkill {
  /** Its folder in the source, "" when the source is the skill. */
  readonly folder: string;
  readonly skill: CheckedSkill | null;
  readonly refusal: SkillRefused | null;
}

/** What a source holds now: the commit it was read at, for Git, and each skill and set, checked. */
export interface SourceRead {
  readonly commit: string | null;
  readonly skills: ReadonlyArray<SourceSkill>;
}

export interface SkillImporterShape {
  /** Lists the skills a source holds, checked, writing nothing. */
  readonly scan: (source: SkillImportSource) => Effect.Effect<SkillScan, SkillSourceUnreadable>;
  /**
   * Reads and checks every skill and set a source holds, with their files, writing nothing: what an
   * update check compares with the library (ADR 029, Updates from a source).
   */
  readonly read: (source: SkillImportSource) => Effect.Effect<SourceRead, SkillSourceUnreadable>;
  /**
   * Adds the skills a source holds to the library, each as a new skill or a new revision of
   * `skillId`. Every one is checked first, and a refusal writes nothing. Content the library has
   * answers its revision again, unchanged.
   */
  readonly add: (
    source: SkillImportSource,
    options: SkillImportOptions,
  ) => Effect.Effect<ReadonlyArray<SkillRevisionAdded>, SkillImportError>;
  /**
   * `add` for a set you picked, which may be a Hobbots export: each exported skill gets exactly the
   * revisions its lock names, oldest first, and the assignments it kept, each to the hob `placeHob`
   * finds on this hub. An assignment whose hob or project is not here, or whose revision was not taken,
   * is left out and counted.
   */
  readonly addSet: (
    source: SkillImportSource,
    options: SkillImportOptions & {
      readonly placeHob: (hob: ExportedHob) => Effect.Effect<AgentId | null>;
      /** Whether this hub knows the project; an assignment to one it does not know is left out. */
      readonly hasProject: (identity: MemoryProjectIdentity) => Effect.Effect<boolean>;
    },
  ) => Effect.Effect<SkillSetAdded, SkillImportError>;
}

export class SkillImporter extends Context.Service<SkillImporter, SkillImporterShape>()(
  "@hobbots/skills/SkillImporter",
) {}

const encoder = new TextEncoder();

/** A skill written in Hobbots, as a source like any other. */
const writtenTree = (files: ReadonlyArray<WrittenFile>): SkillTree => {
  const bytes = new Map(files.map((file) => [file.path, "bytes" in file ? file.bytes : encoder.encode(file.text)]));
  const runs = new Set(files.flatMap((file) => (file.executable === true ? [file.path] : [])));
  const folders = new Set(files.flatMap((file) => (parentOf(file.path) === "" ? [] : [parentOf(file.path)])));
  const entries: Array<TreeEntry> = [
    ...[...folders].map((path): TreeEntry => ({ path, kind: "directory", executable: false, size: 0 })),
    ...[...bytes].map(
      ([path, content]): TreeEntry => ({ path, kind: "file", executable: runs.has(path), size: content.length }),
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
      case "Copied":
        return source.member === undefined
          ? copiedTree(source.folder, source.name)
          : memberCopyTree(source.folder, source.member, source.name);
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

/** A Hobbots export a source holds: its lock, the SHA-256 of the lock's file, and the folder it is in, "" at the top. */
interface ExportedSet {
  readonly base: string;
  readonly lock: SkillsLock;
  readonly digest: string;
}

/** `path` inside the export's folder. */
/** A set's files outside its skills' folders, which they share (ADR 029, Skill sets). */
const sharedOf = (skill: CheckedSkill): ReadonlyArray<string> => {
  const members = skill.set?.skills ?? [];
  if (members.length === 0) return [];
  return skill.files
    .map((file) => file.path)
    .filter((path) => !members.some((member) => path.startsWith(`${member.path}/`)))
    .sort();
};

const inExport = (set: ExportedSet, path: string) => (set.base === "" ? path : `${set.base}/${path}`);

/**
 * The export a source is: a `skills.lock.json` at its top, or in the one folder at its top, as when
 * the export's folder was zipped. Null when there is none, or it is not a Hobbots export's lock.
 */
const readExport = async (tree: SkillTree): Promise<ExportedSet | null> => {
  const locks = tree.entries
    .filter((entry) => entry.kind === "file")
    .filter((entry) => entry.path === SKILLS_LOCK_FILE || /^[^/]+\/skills\.lock\.json$/.test(entry.path))
    .sort((a, b) => a.path.length - b.path.length);
  const [at] = locks;
  if (at === undefined || (at.path !== SKILLS_LOCK_FILE && locks.length > 1)) return null;
  const bytes = await tree.read(at.path);
  const lock = decodeSkillsLock(new TextDecoder().decode(bytes));
  if (lock._tag === "None") return null;
  return { base: parentOf(at.path), lock: lock.value, digest: createHash("sha256").update(bytes).digest("hex") };
};

/** What an export's lock says of one skill folder. */
interface FromExport {
  /** The exported skill whose newest revision the folder holds, or null for a folder the lock does not name. */
  readonly skill: ExportedSkill | null;
  /** Whether the folder still holds exactly that revision; an edited one imports as a plain folder. */
  readonly matches: boolean;
  /** An older revision an export keeps for an assignment: imported with its skill, never on its own. */
  readonly older: boolean;
}

/** One skill of a source, checked, with what a lock says of it. */
interface Checked {
  readonly result: CheckResult;
  readonly locked: LockedSkill | null;
  readonly fromExport: FromExport;
}

const folderOf = (one: Checked) => (one.result._tag === "Passed" ? one.result.skill.folder : one.result.folder);

const NOT_EXPORTED: FromExport = { skill: null, matches: false, older: false };

/** What a Hobbots export's lock says of the skill in `folder`. */
const fromExportOf = (set: ExportedSet | null, folder: string, result: CheckResult): FromExport => {
  if (set === null) return NOT_EXPORTED;
  const older = inExport(set, OLDER_REVISIONS);
  if (folder === older || folder.startsWith(`${older}/`)) return { ...NOT_EXPORTED, older: true };
  const skill = set.lock.skills.find((one) =>
    one.revisions.some((revision) => revision.hash === one.revision && inExport(set, revision.folder) === folder),
  );
  if (skill === undefined) return NOT_EXPORTED;
  const matches = result._tag === "Passed" && result.skill.hash === skill.revision;
  return { skill, matches, older: false };
};

/** Whether a refusal is of a link that leaves the skill's folder, which a set of the skill may hold. */
const linksOut = (result: CheckResult) =>
  result._tag === "Refused" && result.refusal.check === "outside-path" && result.refusal.message.includes(" links to ");

/** The last part of a folder's path, which names a set of a repository that has no manifest. */
const lastPart = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The sets of a source (ADR 029, Skill sets): each plugin's skills, and the skills side by side in a
 * repository's folder of which one links outside its own folder. Answers them with the skills that
 * stay loose, each checked.
 */
const setsOf = async (tree: SkillTree) => {
  const found = findSkills(tree);
  const sets: Array<FoundSet> = [...pluginSets(found)];
  const inSet = new Set(sets.flatMap((set) => set.skills));
  const loose: Array<{ readonly folder: string; readonly result: CheckResult }> = [];
  for (const one of found)
    if (!inSet.has(one.folder)) loose.push({ folder: one.folder, result: await checkSkill(tree, one) });
  for (const one of loose) {
    if (inSet.has(one.folder) || !linksOut(one.result)) continue;
    const folder = repositorySetFolder(one.folder);
    if (folder === null) continue;
    const skills = siblingsOf(found, one.folder).filter((skill) => !inSet.has(skill));
    for (const skill of skills) inSet.add(skill);
    sets.push({ folder, skills, manifest: null, dropped: [] });
  }
  return { sets, loose: loose.filter((one) => !inSet.has(one.folder)) };
};

/** Reads and checks every skill and set of a source; a read that fails partway is the source's failure. */
const checkAll = (tree: SkillTree, topName: string | null) =>
  Effect.tryPromise({
    try: async () => {
      const { sets, loose } = await setsOf(tree);
      const lock = await readLock(tree);
      const set = await readExport(tree);
      const results: Array<Checked> = [];
      for (const { folder, result } of loose) {
        const name = result._tag === "Passed" ? result.skill.name : null;
        const locked = name === null ? null : (lock.get(name) ?? null);
        results.push({ result, locked, fromExport: fromExportOf(set, folder, result) });
      }
      for (const one of sets) {
        const result = await checkSet(tree, one, one.folder === "" ? topName : lastPart(one.folder));
        results.push({ result, locked: null, fromExport: fromExportOf(set, one.folder, result) });
      }
      results.sort((a, b) => (folderOf(a) < folderOf(b) ? -1 : folderOf(a) > folderOf(b) ? 1 : 0));
      return { results, set };
    },
    catch: (error) => unreadable(error) ?? new SkillSourceUnreadable({ message: String(error) }),
  });

/** What names a source that is itself a set of a repository: its folder's, its archive's or its repository's name. */
const setRefusal = (name: SkillName, toSet: boolean) =>
  new SkillRefused({
    check: "set",
    path: null,
    message: toSet
      ? `${name} is one skill, and this source holds a set. Import the set as a skill of its own.`
      : `${name} is a set; its skills change only with a new version of the set. Make a copy to change one.`,
  });

const topNameOf = (source: SkillImportSource): string | null => {
  switch (source._tag) {
    case "Folder":
      return lastPart(source.path.replace(/[\\/]+$/, "").replaceAll("\\", "/"));
    case "Archive":
      return source.fileName.replace(/\.(?:zip|skill)$/i, "");
    case "Git":
      return lastPart(source.url.replace(/\/+$/, "").replace(/\.git$/, ""));
    case "Written":
    case "Edited":
    case "Copied":
      return null;
  }
};

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
    case "Copied":
      return null;
  }
};

type Carried = Extract<SkillImportSource, { readonly _tag: "Edited" | "Copied" }>["carried"];

/** What the source carries over from the revision it was made from, when it was made from one. */
const carriedOf = (source: SkillImportSource): Carried | null =>
  source._tag === "Edited" || source._tag === "Copied" ? source.carried : null;

/** An edit's Charms: what its files name now, and what its base recorded from files it left out. */
const carriedCharms = (skill: CheckedSkill, carried: Carried) =>
  [...new Set([...skill.charms, ...carried.charms])].sort();

/** An edit's left-out content: its own, and its base's, once each. */
const carriedDropped = (skill: CheckedSkill, carried: Pick<Carried, "dropped">) => {
  const seen = new Set(skill.dropped.map((one) => `${one.kind}\u0000${one.path}`));
  return [...skill.dropped, ...carried.dropped.filter((one) => !seen.has(`${one.kind}\u0000${one.path}`))];
};

const lockedOf = (skill: CheckedSkill, locked: LockedSkill | null) =>
  locked === null ? null : { matches: locked.computedHash === skill.cliHash, url: locked.url };

/**
 * An exported skill's source on this hub: the same one, except the shared `~/.agents/skills` of the
 * hub that exported it, which this hub does not watch, so it is recorded as the folder it was.
 */
const exportedOrigin = (origin: SkillOrigin | null): SkillOrigin | null => {
  if (origin === null || origin._tag === "Written") return null;
  return origin._tag === "AgentsFolder" ? { _tag: "Folder", path: origin.path } : origin;
};

/** The checked folder of an older revision an export keeps, if the source still has it. */
const olderFolder = (checked: ReadonlyArray<Checked>, set: ExportedSet, revision: LockedRevision) =>
  checked.find((one) => one.fromExport.older && folderOf(one) === inExport(set, revision.folder));

/** The older revisions of an exported skill: every one it holds but its newest, oldest first. */
const olderOf = (exported: ExportedSkill) => exported.revisions.filter((one) => one.hash !== exported.revision);

/** An older revision as import checks it; one whose folder is gone or holds other files does not match. */
const olderCheck = (
  checked: ReadonlyArray<Checked>,
  set: ExportedSet,
  revision: LockedRevision,
): OlderRevisionCheck => {
  const found = olderFolder(checked, set, revision);
  const base = { number: revision.number, hash: revision.hash };
  if (found === undefined) return { ...base, matches: false, flags: [], dropped: [], refusal: null };
  if (found.result._tag === "Refused")
    return { ...base, matches: true, flags: [], dropped: [], refusal: found.result.refusal };
  const { skill } = found.result;
  return {
    ...base,
    matches: skill.hash === revision.hash,
    flags: skill.flags,
    dropped: carriedDropped(skill, revision),
    refusal: null,
  };
};

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

    /** What an export says of a candidate: older revisions come only with a skill new to this library. */
    const exportedOf = (
      { skill, matches }: FromExport,
      context: { readonly set: ExportedSet | null; readonly checked: ReadonlyArray<Checked> },
      isNew: boolean,
    ) => {
      if (skill === null || context.set === null) return null;
      const set = context.set;
      const older = isNew ? olderOf(skill).map((revision) => olderCheck(context.checked, set, revision)) : [];
      return { matches, older, assignments: skill.assignments.length };
    };

    const candidateOf = (
      { result, locked, fromExport }: Checked,
      context: { readonly set: ExportedSet | null; readonly checked: ReadonlyArray<Checked> },
    ) =>
      Effect.gen(function* () {
        if (result._tag === "Refused") {
          const exported = exportedOf(fromExport, context, false);
          const none = {
            name: null,
            description: null,
            hash: null,
            label: null,
            set: null,
            shared: [],
            locked: null,
            existing: null,
          };
          return {
            folder: result.folder,
            ...none,
            exported,
            flags: [],
            dropped: [],
            charms: [],
            refusal: result.refusal,
          };
        }
        const { skill } = result;
        const existing = yield* existingOf(skill);
        const exported = exportedOf(fromExport, context, existing === null);
        return {
          folder: skill.folder,
          name: skill.name,
          description: skill.description,
          hash: skill.hash,
          flags: skill.flags,
          dropped: skill.dropped,
          charms: skill.charms,
          label: skill.label,
          set: skill.set,
          shared: sharedOf(skill),
          refusal: null,
          locked: lockedOf(skill, locked),
          exported,
          existing,
        } satisfies SkillCandidate;
      });

    const scan = (source: SkillImportSource) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* openTree(source);
          const { results, set } = yield* checkAll(tree, topNameOf(source));
          return {
            commit: tree.commit,
            candidates: yield* Effect.forEach(
              results.filter((one) => !one.fromExport.older),
              (one) => candidateOf(one, { set, checked: results }),
            ),
            exported:
              set === null
                ? null
                : {
                    exportedAt: set.lock.exportedAt,
                    skills: set.lock.skills.length,
                    assignments: set.lock.skills.reduce((sum, skill) => sum + skill.assignments.length, 0),
                    lock: set.digest,
                  },
          } satisfies SkillScan;
        }),
      );

    const read = (source: SkillImportSource) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* openTree(source);
          const { results } = yield* checkAll(tree, topNameOf(source));
          const skills = results.map(
            ({ result }): SourceSkill =>
              result._tag === "Passed"
                ? { folder: result.skill.folder, skill: result.skill, refusal: null }
                : { folder: result.folder, skill: null, refusal: result.refusal },
          );
          return { commit: tree.commit, skills } satisfies SourceRead;
        }),
      );

    /** The checked skills to take, failing on the first refusal or a folder the source does not hold. */
    const picked = (checked: ReadonlyArray<Checked>, options: SkillImportOptions) =>
      Effect.gen(function* () {
        const folders = options.folders ?? checked.filter((one) => !one.fromExport.older).map(folderOf);
        const chosen = [];
        for (const folder of folders) {
          const one = checked.find((each) => !each.fromExport.older && folderOf(each) === folder);
          if (one === undefined) return yield* new SkillNotFound({ id: folder });
          if (one.result._tag === "Refused") return yield* one.result.refusal;
          chosen.push({ skill: one.result.skill, locked: one.locked, fromExport: one.fromExport });
        }
        if (chosen.length === 0) return yield* new SkillSourceUnreadable({ message: "There is no SKILL.md in it." });
        if (options.skillId !== undefined && chosen.length > 1) {
          return yield* new SkillSourceUnreadable({ message: "Pick the one skill to take a new revision from." });
        }
        return chosen;
      });

    /** Fails on a name another skill has, before any file is written. */
    /** Fails on an edit in Hobbots of a set: a set changes only with a new version from its source. */
    const checkNotSet = (skillId: SkillId) =>
      Effect.gen(function* () {
        const [latest] = yield* library.revisions(skillId);
        if (latest?.set != null) return yield* setRefusal(latest.name, false);
      });
    const checkName = (skill: CheckedSkill, skillId: SkillId | undefined, written: boolean) =>
      Effect.gen(function* () {
        if (skillId !== undefined) {
          const target = yield* library.get(skillId);
          if (target === null) return yield* new SkillNotFound({ id: skillId });
          if (target.name !== skill.name) {
            return yield* new SkillNameChanged({ skillId, name: target.name, given: skill.name });
          }
          // A set changes only as a whole, with a new version from its source; a loose skill never becomes one.
          const [latest] = yield* library.revisions(skillId);
          const toSet = !written && skill.set !== null;
          if ((latest?.set != null) !== toSet) return yield* setRefusal(target.name, toSet);
          return;
        }
        const existing = yield* existingOf(skill);
        if (existing !== null && existing.number === null) {
          return yield* new SkillNameTaken({ name: skill.name, skillId: existing.skillId });
        }
      });

    /** Writes a checked revision's files, then adds it, journaled and announced. */
    const addOne = (
      skillId: SkillId | null,
      skill: CheckedSkill,
      input: Omit<SkillRevisionInput, "hash" | "name" | "description" | "files" | "flags">,
    ) =>
      Effect.gen(function* () {
        yield* objects.put(skill.hash, skill.contents);
        const committed = yield* library.addRevision(skillId, {
          hash: skill.hash,
          name: skill.name,
          description: skill.description,
          files: skill.files,
          flags: skill.flags,
          set: skill.set,
          ...input,
        });
        yield* announce(committed.entries);
        return committed.value;
      });

    /**
     * An exported skill (ADR 029, Backups, exports and Diagnostics): a skill new to this library gets
     * every revision the export holds, oldest first, so the newest stays the newest; one the library
     * already has, with that content, keeps its own history. Each keeps the source, commit and label
     * the export recorded.
     */
    const addExported = (
      checked: ReadonlyArray<Checked>,
      skill: CheckedSkill,
      exported: ExportedSkill,
      set: ExportedSet,
      by: SkillBy,
    ) =>
      Effect.gen(function* () {
        let skillId = (yield* library.byName(skill.name))?.id ?? null;
        const isNew = skillId === null;
        const origin = exportedOrigin(exported.source);
        let newest: SkillRevisionAdded | null = null;
        for (const revision of exported.revisions) {
          const isNewest = revision.hash === exported.revision;
          if (!isNewest && !isNew) continue;
          const found = isNewest ? null : olderFolder(checked, set, revision);
          const files = isNewest ? skill : found?.result._tag === "Passed" ? found.result.skill : null;
          // Checked before anything was written (`checkOlder`), so every older revision is here as it was.
          if (files === null) return yield* new SkillSourceChanged({ folder: inExport(set, revision.folder) });
          const added = yield* addOne(skillId, files, {
            charms: [...new Set([...files.charms, ...revision.charms])].sort(),
            dropped: carriedDropped(files, revision),
            origin,
            commit: revision.commit,
            path: revision.path,
            label: revision.label,
            addedBy: by,
          });
          skillId = added.skill.id;
          if (isNewest) newest = added;
        }
        if (newest === null) return yield* new SkillNotFound({ id: skill.folder });
        return newest;
      });

    /**
     * Fails, before anything is written, on an older revision an export would add that is refused, or
     * whose files are gone or no longer that revision: the import takes every revision its lock names.
     */
    const checkOlder = (
      checked: ReadonlyArray<Checked>,
      set: ExportedSet,
      chosen: ReadonlyArray<{ readonly skill: CheckedSkill; readonly fromExport: FromExport }>,
    ) =>
      Effect.gen(function* () {
        for (const { skill, fromExport } of chosen) {
          if (fromExport.skill === null || !fromExport.matches || (yield* library.byName(skill.name)) !== null)
            continue;
          for (const revision of olderOf(fromExport.skill)) {
            const check = olderCheck(checked, set, revision);
            if (check.refusal !== null) return yield* check.refusal;
            if (!check.matches) return yield* new SkillSourceChanged({ folder: inExport(set, revision.folder) });
          }
        }
      });

    const addChosen = (source: SkillImportSource, options: SkillImportOptions) =>
      Effect.gen(function* () {
        const written = source._tag === "Written" || source._tag === "Edited" || source._tag === "Copied";
        if (written && options.skillId !== undefined) yield* checkNotSet(options.skillId);
        const tree = yield* openTree(source);
        const { results, set } = yield* checkAll(tree, topNameOf(source));
        const chosen = yield* picked(results, options);
        if (options.scanned !== undefined) {
          const scanned = options.scanned;
          const moved = chosen.find(({ skill }) => scanned.get(skill.folder) !== skill.hash);
          if (moved !== undefined) return yield* new SkillSourceChanged({ folder: moved.skill.folder });
          // An export's lock says who gets each skill and which older revisions come: it is what you looked at too.
          if ((set?.digest ?? null) !== (options.scannedLock ?? null)) {
            return yield* new SkillSourceChanged({
              folder: set === null ? SKILLS_LOCK_FILE : inExport(set, SKILLS_LOCK_FILE),
            });
          }
        }
        yield* Effect.forEach(chosen, ({ skill }) => checkName(skill, options.skillId, written), {
          discard: true,
        });
        if (set !== null && options.skillId === undefined) yield* checkOlder(results, set, chosen);
        const exported: Array<{ readonly skillId: SkillId; readonly skill: ExportedSkill }> = [];
        const imported = yield* Effect.forEach(chosen, ({ skill, locked, fromExport }) =>
          Effect.gen(function* () {
            if (set !== null && fromExport.skill !== null && fromExport.matches && options.skillId === undefined) {
              const added = yield* addExported(results, skill, fromExport.skill, set, options.by);
              exported.push({ skillId: added.skill.id, skill: fromExport.skill });
              return added;
            }
            const carried = carriedOf(source);
            return yield* addOne(options.skillId ?? null, skill, {
              charms: carried === null ? skill.charms : carriedCharms(skill, carried),
              dropped: carried === null ? skill.dropped : carriedDropped(skill, carried),
              origin: originOf(source, locked),
              commit: locked?.url != null ? null : tree.commit,
              path: locked?.url != null ? locked.path : skill.folder === "" ? null : skill.folder,
              label: skill.label,
              addedBy: options.by,
              ...(options.after === undefined ? {} : { after: options.after }),
            });
          }),
        );
        return { imported, exported };
      });

    const add = (source: SkillImportSource, options: SkillImportOptions) =>
      Effect.scoped(Effect.map(addChosen(source, options), ({ imported }) => imported));

    /** Gives one exported assignment out on this hub, or null when its hob, project or revision is not here. */
    const assignExported = (
      skillId: SkillId,
      assignment: LockedAssignment,
      place: Pick<Parameters<SkillImporterShape["addSet"]>[1], "placeHob" | "hasProject">,
      by: SkillBy,
    ) =>
      Effect.gen(function* () {
        if ((yield* library.revision(skillId, assignment.pin)) === null) return null;
        const { placeHob } = place;
        let scope = assignment.scope;
        if (scope._tag === "Project" && !(yield* place.hasProject(scope.identity))) return null;
        if (scope._tag === "Hob") {
          const agentId = yield* placeHob({ agentId: scope.agentId, name: assignment.hob?.name ?? null });
          if (agentId === null) return null;
          scope = { _tag: "Hob", agentId };
        }
        const committed = yield* library.assign({
          skillId,
          scope,
          pin: assignment.pin,
          held: assignment.held,
          onlyWhenAsked: assignment.onlyWhenAsked,
          by,
        });
        yield* announce(committed.entries);
        return committed.value;
      });

    const addSet: SkillImporterShape["addSet"] = (source, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { imported, exported } = yield* addChosen(source, options);
          const assigned: Array<SkillAssignment> = [];
          let leftOut = 0;
          for (const { skillId, skill } of exported) {
            for (const assignment of skill.assignments) {
              const given = yield* assignExported(skillId, assignment, options, options.by);
              if (given === null) leftOut += 1;
              else assigned.push(given);
            }
          }
          return { imported, assigned, leftOut };
        }),
      );

    return SkillImporter.of({ scan, read, add, addSet });
  }),
);
