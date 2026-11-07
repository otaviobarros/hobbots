import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillLibrary } from "@hobbots/agents";
import { AgentId, SkillName } from "@hobbots/domain";
import { Effect, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentsFolder,
  AgentsFolderLive,
  type AgentsFolderMove,
  AgentsFolderMoves,
  SkillImporter,
  SkillImporterLive,
  SkillObjects,
  SkillObjectsLive,
  writeSkillExport,
} from "../src/index.ts";
import { SkillLibraryFake } from "../src/testing.ts";
import { folderOf, skillMd, temp } from "./fixtures.ts";

// #1139: ~/.agents/skills is the only source of its skills: read-only in Hobbots, and out of
// backups and exports (ADR 029).

const you = { by: { _tag: "You" } } as const;
const pip = AgentId.make("pip");

/** The folder read into a fake library, with import, and the moves each read notes. */
const layerFor = async (path: string, moves: Ref.Ref<ReadonlyArray<AgentsFolderMove>>) => {
  const data = await temp("data");
  const noted = Layer.succeed(AgentsFolderMoves, {
    moved: (more) => Ref.update(moves, (all) => [...all, ...more]),
  });
  const base = SkillImporterLive.pipe(Layer.provideMerge(Layer.mergeAll(SkillObjectsLive(data), SkillLibraryFake)));
  return AgentsFolderLive(path).pipe(Layer.provide(noted), Layer.provideMerge(base));
};

/** Removes a revision's read-only folder from the object store, as a restore of a backup without it leaves it. */
const dropFiles = (folder: string) =>
  Effect.promise(async () => {
    const open = async (path: string) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory()) await open(join(path, entry.name));
    };
    await open(folder);
    await rm(folder, { recursive: true, force: true });
  });

describe("~/.agents/skills is read-only in Hobbots", () => {
  // covers ADR 029 (~/.agents/skills stays, through Hobbots; Make a copy), #1139
  it("[TC-AG-161] refuses an edit or another source's content, and Make a copy gives an editable skill with the same files", async () => {
    const folder = await folderOf({
      "pdf-forms/SKILL.md": skillMd("pdf-forms"),
      "pdf-forms/scripts/fields.py": { text: "print('fields')\n", executable: true },
    });
    const moves = await Effect.runPromise(Ref.make<ReadonlyArray<AgentsFolderMove>>([]));
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const importer = yield* SkillImporter;
      const objects = yield* SkillObjects;
      const pdf = yield* library.byName(SkillName.make("pdf-forms"));
      if (pdf === null) return expect.unreachable();
      const base = yield* objects.folder(pdf.latest);
      if (base === null) return expect.unreachable();
      const carried = { charms: [], dropped: [] };

      // An edit in Hobbots, as the web app, the desktop app and the API send it.
      const edit = {
        _tag: "Edited",
        folder: base,
        description: "Changed.",
        instructions: "# Changed\n",
        carried,
      } as const;
      const refused = yield* Effect.flip(importer.add(edit, { ...you, skillId: pdf.id, after: pdf.latest }));
      expect(refused).toMatchObject({ _tag: "SkillReadOnly", name: "pdf-forms", folder: `${folder}/pdf-forms` });
      // Written files, as a hob's proposal adds them, and a folder of other content.
      const written = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("pdf-forms", "Other.") }] } as const;
      expect((yield* Effect.flip(importer.add(written, { ...you, skillId: pdf.id })))._tag).toBe("SkillReadOnly");
      const other = yield* Effect.promise(() => folderOf({ "SKILL.md": skillMd("pdf-forms", "Elsewhere.") }));
      const fork = importer.add({ _tag: "Folder", path: other }, { ...you, skillId: pdf.id });
      expect((yield* Effect.flip(fork))._tag).toBe("SkillReadOnly");
      expect((yield* library.get(pdf.id))?.revisions).toBe(1);

      // Make a copy: r1, the same files under a new name, no source, given to no one.
      const name = SkillName.make("pdf-forms-copy");
      const [copied] = yield* importer.add({ _tag: "Copied", folder: base, name, carried }, you);
      if (copied === undefined) return expect.unreachable();
      expect(copied.skill).toMatchObject({ name: "pdf-forms-copy", revisions: 1, sourceId: null });
      expect(copied.revision.files.map((file) => [file.path, file.mode])).toEqual([
        ["SKILL.md", "regular"],
        ["scripts/fields.py", "executable"],
      ]);
      expect(yield* library.assignments(copied.skill.id)).toEqual([]);
      const copyFolder = yield* objects.folder(copied.revision.hash);
      if (copyFolder === null) return expect.unreachable();
      const text = yield* Effect.promise(() => readFile(join(copyFolder, "SKILL.md"), "utf8"));
      expect(text).toContain("name: pdf-forms-copy");
      expect(text).toContain("Steps for pdf-forms.");

      // The copy takes edits; the original keeps following its folder.
      const copyFrom = { ...edit, folder: copyFolder };
      const [edited] = yield* importer.add(copyFrom, { ...you, skillId: copied.skill.id, after: copied.revision.hash });
      expect(edited?.revision.number).toBe(2);
      yield* Effect.promise(() => writeFile(join(folder, "pdf-forms/SKILL.md"), skillMd("pdf-forms", "Forms, now.")));
      yield* (yield* AgentsFolder).sync;
      expect((yield* library.get(pdf.id))?.revisions).toBe(2);
    }).pipe(Effect.provide(await layerFor(folder, moves)), Effect.runPromise);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), ADR 026, #1139
  it("[TC-AG-162] after a restore without its files, a read moves each assignment, held ones too, to the folder's revision and notes it", async () => {
    const folder = await folderOf({ "release/SKILL.md": skillMd("release") });
    const moves = await Effect.runPromise(Ref.make<ReadonlyArray<AgentsFolderMove>>([]));
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const objects = yield* SkillObjects;
      const agents = yield* AgentsFolder;
      const release = yield* library.byName(SkillName.make("release"));
      if (release === null) return expect.unreachable();
      const r1 = release.latest;
      const held = { onlyWhenAsked: false, by: { _tag: "You" } } as const;
      yield* library.assign({
        ...held,
        skillId: release.id,
        scope: { _tag: "Hob", agentId: pip },
        pin: r1,
        held: true,
      });
      yield* Effect.promise(() => writeFile(join(folder, "release/SKILL.md"), skillMd("release", "Releases, now.")));
      yield* agents.sync;
      const r2 = (yield* library.get(release.id))?.latest;
      expect(yield* Ref.get(moves)).toEqual([]);

      // A restore brings back the rows but none of the files: both revisions' folders are gone.
      for (const hash of [r1, r2]) {
        const at = hash === undefined ? null : yield* objects.folder(hash);
        if (at !== null) yield* dropFiles(at);
      }
      yield* agents.sync;
      const pins = (yield* library.assignments(release.id)).map((one) => [one.scope._tag, one.pin === r2, one.held]);
      expect(pins).toEqual([
        ["Everyone", true, false],
        ["Hob", true, true],
      ]);
      // The folder's current revision has its files again.
      expect(r2 === undefined ? null : yield* objects.folder(r2)).not.toBeNull();
      expect(yield* Ref.get(moves)).toEqual([{ skill: "release", scope: { _tag: "Hob", agentId: pip } }]);
      // Reading again moves nothing more.
      yield* agents.sync;
      expect(yield* Ref.get(moves)).toHaveLength(1);
    }).pipe(Effect.provide(await layerFor(folder, moves)), Effect.runPromise);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1139
  it("[TC-OP-123] an export leaves out every skill from ~/.agents/skills and names it", async () => {
    const folder = await folderOf({ "pdf-forms/SKILL.md": skillMd("pdf-forms") });
    const mine = await folderOf({ "SKILL.md": skillMd("release") });
    const out = await temp("export");
    const moves = await Effect.runPromise(Ref.make<ReadonlyArray<AgentsFolderMove>>([]));
    await Effect.gen(function* () {
      const importer = yield* SkillImporter;
      yield* importer.add({ _tag: "Folder", path: mine }, you);
      const written = yield* writeSkillExport(out, {
        assignments: true,
        hobName: () => null,
        exportedAt: "2026-11-07",
      });
      expect(written).toEqual({ skills: 1, leftOut: ["pdf-forms"] });
      const entries = yield* Effect.promise(() => readdir(out));
      expect(entries.sort()).toEqual(["release", "skills.lock.json"]);
      const lock = JSON.parse(yield* Effect.promise(() => readFile(join(out, "skills.lock.json"), "utf8")));
      expect(lock.skills.map((one: { name: string }) => one.name)).toEqual(["release"]);
    }).pipe(Effect.provide(await layerFor(folder, moves)), Effect.runPromise);
  });
});
