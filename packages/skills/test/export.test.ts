import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillLibrary } from "@hobbots/agents";
import {
  AgentId,
  MemoryProjectIdentity,
  type SkillId,
  type SkillRevisionHash,
  SkillSourceChanged,
} from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSkillsLock, SKILLS_LOCK_FILE, SkillImporter, writeSkillExport } from "../src/index.ts";
import { archiveOf, folderOf, importerLayer, runWith, skillMd, temp } from "./fixtures.ts";

// #1064: exporting skills as a folder with `skills.lock.json`, and importing it on another hub
// (ADR 029, Backups, exports and Diagnostics).

const you = { by: { _tag: "You" } } as const;
const pip = AgentId.make("pip");
const site = MemoryProjectIdentity.make("github.com/acme/site");
const HOBS: Record<string, string> = { pip: "Pip" };

/** Every file under `folder`, relative, sorted. */
const filesIn = async (folder: string): Promise<ReadonlyArray<string>> =>
  (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
    .sort();

/**
 * A library with Release steps at r1 and r2, given to Everyone and the site project on r2 and held
 * on r1 for Pip, and Commit style at r1 with no one using it.
 */
const seedLibrary = Effect.gen(function* () {
  const importer = yield* SkillImporter;
  const library = yield* SkillLibrary;
  const script = { text: "git tag v1\n", executable: true };
  const one = yield* Effect.promise(() => folderOf({ "SKILL.md": skillMd("release"), "scripts/tag.sh": script }));
  const two = yield* Effect.promise(() =>
    folderOf({ "SKILL.md": skillMd("release", "How releases go now."), "scripts/tag.sh": script }),
  );
  const commit = yield* Effect.promise(() => folderOf({ "SKILL.md": skillMd("commit-style") }));
  const [r1] = yield* importer.add({ _tag: "Folder", path: one }, you);
  if (r1 === undefined) throw new Error("no r1");
  const [r2] = yield* importer.add({ _tag: "Folder", path: two }, { ...you, skillId: r1.skill.id });
  const [style] = yield* importer.add({ _tag: "Folder", path: commit }, you);
  if (r2 === undefined || style === undefined) throw new Error("nothing imported");
  const base = { skillId: r1.skill.id, onlyWhenAsked: false, by: { _tag: "You" } } as const;
  yield* library.assign({ ...base, scope: { _tag: "Everyone" }, pin: r2.revision.hash, held: false });
  yield* library.assign({ ...base, scope: { _tag: "Project", identity: site }, pin: r2.revision.hash, held: false });
  yield* library.assign({ ...base, scope: { _tag: "Hob", agentId: pip }, pin: r1.revision.hash, held: true });
  return { release: r1.skill.id, style: style.skill.id, r1: r1.revision.hash, r2: r2.revision.hash };
});

const exportTo = (folder: string, more: { skillIds?: ReadonlyArray<SkillId>; assignments?: boolean } = {}) =>
  writeSkillExport(folder, {
    assignments: true,
    hobName: (agentId) => HOBS[agentId] ?? null,
    exportedAt: "2026-11-07T10:00:00.000Z",
    ...more,
  });

/** What a library holds, as the done-when compares it: each skill's revisions, oldest first, and its assignments. */
const libraryOf = Effect.gen(function* () {
  const library = yield* SkillLibrary;
  const skills = yield* library.list;
  return yield* Effect.forEach(skills, (skill) =>
    Effect.gen(function* () {
      const revisions = (yield* library.revisions(skill.id)).map((revision) => revision.hash).reverse();
      const assignments = (yield* library.assignments(skill.id))
        .map((one) => `${JSON.stringify(one.scope)} ${one.pin} ${one.held ? "held" : "follows"}`)
        .sort();
      return { name: skill.name, latest: skill.latest, revisions, assignments };
    }),
  );
});

describe("skill export", () => {
  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-116] writes each skill's newest revision, any older one an assignment pins, and a lock that names them", async () => {
    const { layer } = await importerLayer();
    const folder = await temp("export");
    await runWith(layer)(
      Effect.gen(function* () {
        const seeded = yield* seedLibrary;
        expect(yield* exportTo(folder)).toEqual({ skills: 2, leftOut: [] });
        expect(yield* Effect.promise(() => filesIn(folder))).toEqual([
          ".revisions/release/r1/SKILL.md",
          ".revisions/release/r1/scripts/tag.sh",
          "commit-style/SKILL.md",
          "release/SKILL.md",
          "release/scripts/tag.sh",
          SKILLS_LOCK_FILE,
        ]);
        // A script stays one, since the revision's hash covers it.
        expect((yield* Effect.promise(() => stat(join(folder, "release/scripts/tag.sh")))).mode & 0o111).not.toBe(0);
        const lock = decodeSkillsLock(yield* Effect.promise(() => readFile(join(folder, SKILLS_LOCK_FILE), "utf8")));
        if (lock._tag === "None") throw new Error("the lock does not read back");
        const release = lock.value.skills.find((skill) => skill.name === "release");
        expect(release).toMatchObject({
          revision: seeded.r2,
          source: { _tag: "Folder" },
          revisions: [
            { hash: seeded.r1, number: 1, folder: ".revisions/release/r1" },
            { hash: seeded.r2, number: 2, folder: "release" },
          ],
        });
        expect(release?.assignments).toHaveLength(3);
        expect(release?.assignments.find((one) => one.scope._tag === "Hob")).toEqual({
          scope: { _tag: "Hob", agentId: pip },
          hob: { name: "Pip" },
          pin: seeded.r1,
          held: true,
          onlyWhenAsked: false,
        });

        // A chosen set without who gets each skill: only its newest revision, and no assignments.
        const picked = yield* Effect.promise(() => temp("picked"));
        expect(yield* exportTo(picked, { skillIds: [seeded.release], assignments: false })).toEqual({
          skills: 1,
          leftOut: [],
        });
        expect(yield* Effect.promise(() => filesIn(picked))).toEqual([
          "release/SKILL.md",
          "release/scripts/tag.sh",
          SKILLS_LOCK_FILE,
        ]);
        const bare = decodeSkillsLock(yield* Effect.promise(() => readFile(join(picked, SKILLS_LOCK_FILE), "utf8")));
        expect(bare._tag === "Some" && bare.value.skills.map((skill) => skill.assignments)).toEqual([[]]);
      }),
    );
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-117] gives a fresh hub the same revisions and assignments, finding a hob by its name", async () => {
    const from = await importerLayer();
    const folder = await temp("export");
    const before = await runWith(from.layer)(
      Effect.gen(function* () {
        yield* seedLibrary;
        yield* exportTo(folder);
        return yield* libraryOf;
      }),
    );

    // On the other hub Pip has another id: its exported assignment finds it by name.
    const pipThere = AgentId.make("pip-on-the-other-hub");
    const to = await importerLayer();
    const after = await runWith(to.layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const scan = yield* importer.scan({ _tag: "Folder", path: folder });
        // The older revision comes with its skill and is not offered on its own.
        // It is shown with what import notes of it, here the script it holds, as the newest is.
        const script = [{ _tag: "Script", path: "scripts/tag.sh" }];
        expect(scan.candidates.map((one) => [one.folder, one.exported])).toEqual([
          ["commit-style", { matches: true, older: [], assignments: 0 }],
          [
            "release",
            {
              matches: true,
              older: [
                { number: 1, hash: expect.any(String), matches: true, flags: script, dropped: [], refusal: null },
              ],
              assignments: 3,
            },
          ],
        ]);
        expect(scan.exported).toEqual({
          exportedAt: "2026-11-07T10:00:00.000Z",
          skills: 2,
          assignments: 3,
          lock: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        const set = yield* importer.addSet(
          { _tag: "Folder", path: folder },
          {
            ...you,
            scanned: new Map(scan.candidates.flatMap((one) => (one.hash === null ? [] : [[one.folder, one.hash]]))),
            scannedLock: scan.exported?.lock ?? null,
            placeHob: (hob) => Effect.succeed(hob.name === "Pip" ? pipThere : null),
            hasProject: (identity) => Effect.succeed(identity === site),
          },
        );
        expect(set.assigned).toHaveLength(3);
        expect(set.leftOut).toBe(0);
        return yield* libraryOf;
      }),
    );
    const there = (text: string) => text.replace(pipThere, pip);
    expect(after.map((skill) => ({ ...skill, assignments: skill.assignments.map(there) }))).toEqual(before);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-118] imports a zipped export, and keeps in the library only what a hub without the hob or the project can take", async () => {
    const { layer } = await importerLayer();
    const folder = await temp("export");
    const seeded = await runWith(layer)(Effect.flatMap(seedLibrary, (made) => Effect.as(exportTo(folder), made)));
    const fixture: Record<string, string | { text: string; executable: boolean }> = {};
    for (const file of await filesIn(folder)) {
      const text = await readFile(join(folder, file), "utf8");
      fixture[`hobbots-skills-2026-11-07/${file}`] = file.endsWith(".sh") ? { text, executable: true } : text;
    }
    const bytes = await archiveOf(fixture);
    const fresh = await importerLayer();
    await runWith(fresh.layer)(
      Effect.gen(function* () {
        const set = yield* (yield* SkillImporter).addSet(
          { _tag: "Archive", fileName: "hobbots-skills-2026-11-07.zip", bytes },
          { ...you, placeHob: () => Effect.succeed(null), hasProject: () => Effect.succeed(false) },
        );
        // No Pip and no site project here: their assignments are left out, and the skill stays in the library.
        expect(set.leftOut).toBe(2);
        expect(set.assigned.map((one) => one.scope._tag)).toEqual(["Everyone"]);
        const library = yield* SkillLibrary;
        const release = (yield* library.list).find((skill) => skill.name === "release");
        const hashes: ReadonlyArray<SkillRevisionHash> = (yield* library.revisions(release?.id ?? ("" as SkillId)))
          .map((revision) => revision.hash)
          .reverse();
        expect(hashes).toEqual([seeded.r1, seeded.r2]);
      }),
    );
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-121] imports only the export that was scanned: a changed lock or older revision is refused, writing nothing", async () => {
    const { layer } = await importerLayer();
    const folder = await temp("export");
    await runWith(layer)(Effect.flatMap(seedLibrary, () => exportTo(folder)));
    const lockFile = join(folder, SKILLS_LOCK_FILE);
    const exported = await readFile(lockFile, "utf8");
    const fresh = await importerLayer();
    await runWith(fresh.layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const source = { _tag: "Folder", path: folder } as const;
        const place = { placeHob: () => Effect.succeed(pip), hasProject: () => Effect.succeed(true) };
        const scan = yield* importer.scan(source);
        const scanned = {
          scanned: new Map(scan.candidates.flatMap((one) => (one.hash === null ? [] : [[one.folder, one.hash]]))),
          scannedLock: scan.exported?.lock ?? null,
        };

        // Pip's assignment now goes to Everyone: the skills' files are the same, but who gets them is not.
        const toEveryone = exported.replace('"_tag": "Hob"', '"_tag": "Everyone"');
        expect(toEveryone).not.toBe(exported);
        yield* Effect.promise(() => writeFile(lockFile, toEveryone));
        const changedLock = yield* Effect.flip(importer.addSet(source, { ...you, ...scanned, ...place }));
        expect(changedLock).toBeInstanceOf(SkillSourceChanged);

        // The lock is back as scanned, but an older revision's files changed: the lock names its hash,
        // so new files would need a new lock, and that is refused as above.
        yield* Effect.promise(() => writeFile(lockFile, exported));
        const older = join(folder, ".revisions/release/r1/SKILL.md");
        yield* Effect.promise(() => writeFile(older, skillMd("release", "Something else.")));
        const changedOlder = yield* Effect.flip(importer.addSet(source, { ...you, ...scanned, ...place }));
        expect(changedOlder).toBeInstanceOf(SkillSourceChanged);
        const rescan = yield* importer.scan(source);
        const release = rescan.candidates.find((one) => one.folder === "release");
        expect(release?.exported?.older.map((one) => one.matches)).toEqual([false]);
        expect(yield* (yield* SkillLibrary).list).toEqual([]);
      }),
    );
  });
});
