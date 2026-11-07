import { rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillLibrary } from "@hobbots/agents";
import { SkillName } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentsFolder, AgentsFolderLive, SkillObjectsLive } from "../src/index.ts";
import { SkillLibraryFake } from "../src/testing.ts";
import { folderOf, skillMd, temp } from "./fixtures.ts";

// #1060: ~/.agents/skills, read by the hub into the library under Everyone (ADR 029).

const layerFor = async (path: string) =>
  AgentsFolderLive(path).pipe(
    Layer.provideMerge(Layer.mergeAll(SkillObjectsLive(await temp("data")), SkillLibraryFake)),
  );

describe("~/.agents/skills", () => {
  // covers ADR 029 (The clean-runtime rule: ~/.agents/skills stays, through Hobbots), #1060
  it("[TC-AG-132] lists each skill under Everyone, from that folder, and rolls a change out as a new revision", async () => {
    const folder = await folderOf({
      "release/SKILL.md": skillMd("release"),
      "review/SKILL.md": skillMd("review"),
      "broken/SKILL.md": "no front matter",
    });
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const agents = yield* AgentsFolder;
      const skills = yield* library.list;
      expect(skills.map((skill) => skill.name)).toEqual(["release", "review"]);
      const [source] = yield* library.sources;
      expect(source?.origin).toEqual({ _tag: "AgentsFolder", path: folder });
      const assignments = yield* library.assignments();
      expect(assignments.map((one) => one.scope)).toEqual([{ _tag: "Everyone" }, { _tag: "Everyone" }]);
      expect((yield* agents.problems).map((one) => [one.folder, one.refusal?.check])).toEqual([
        ["broken", "front-matter"],
      ]);

      // A change there is a new revision, rolled out to the skill's assignments that are not held.
      const release = skills[0];
      if (release === undefined) return expect.unreachable();
      yield* library.assign({
        skillId: release.id,
        scope: { _tag: "Project", identity: "github.com/acme/web" as never },
        pin: release.latest,
        held: true,
        onlyWhenAsked: false,
        by: { _tag: "You" },
      });
      yield* Effect.promise(() => writeFile(join(folder, "release/SKILL.md"), skillMd("release", "Releases, now.")));
      yield* agents.sync;
      const after = yield* library.get(release.id);
      expect(after).toMatchObject({ revisions: 2, description: "Releases, now." });
      const pins = (yield* library.assignments(release.id)).map((one) => [one.scope._tag, one.pin === after?.latest]);
      expect(pins).toEqual([
        ["Everyone", true],
        ["Project", false],
      ]);
      // Syncing again with nothing changed adds nothing.
      yield* agents.sync;
      expect((yield* library.get(release.id))?.revisions).toBe(2);

      // A skill taken out of the folder leaves Everyone, and stays in the library.
      yield* Effect.promise(() => rm(join(folder, "review"), { recursive: true }));
      yield* agents.sync;
      const review = yield* library.byName(SkillName.make("review"));
      expect(review).not.toBeNull();
      expect(yield* library.assignments(review?.id)).toEqual([]);
    }).pipe(Effect.provide(await layerFor(folder)), Effect.runPromise);
  });

  // covers ADR 029 (Pins and rollout), #1061
  it("[TC-AG-141] a rollback stays while the folder still holds the revision it rolled back from", async () => {
    const folder = await folderOf({ "release/SKILL.md": skillMd("release") });
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const agents = yield* AgentsFolder;
      const [first] = yield* library.list;
      if (first === undefined) return expect.unreachable();
      yield* Effect.promise(() => writeFile(join(folder, "release/SKILL.md"), skillMd("release", "Releases, now.")));
      yield* agents.sync;
      const [everyone] = yield* library.assignments(first.id);
      if (everyone === undefined) return expect.unreachable();
      expect(everyone.pin).not.toBe(first.latest);
      // Roll back to r1; the folder, unchanged, never rolls r2 out again.
      yield* library.rollOut(everyone.id, first.latest, { _tag: "You" });
      yield* agents.sync;
      expect((yield* library.assignments(first.id)).map((one) => one.pin)).toEqual([first.latest]);
    }).pipe(Effect.provide(await layerFor(folder)), Effect.runPromise);
  });

  it("[TC-AG-139] keeps every assignment, and says why, while the folder cannot be read", async () => {
    const folder = await folderOf({ "release/SKILL.md": skillMd("release") });
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const agents = yield* AgentsFolder;
      const [release] = yield* library.list;
      if (release === undefined) return expect.unreachable();
      const [everyone] = yield* library.assignments(release.id);
      if (everyone === undefined) return expect.unreachable();
      yield* library.hold(everyone.id, true);

      // Something that is there but is not a folder is not a missing folder: nothing is let go.
      yield* Effect.promise(async () => {
        await rm(folder, { recursive: true });
        await writeFile(folder, "not a folder");
      });
      yield* agents.sync;
      expect(yield* library.assignments(release.id)).toMatchObject([{ id: everyone.id, held: true }]);
      const problems = yield* agents.problems;
      expect(problems).toMatchObject([{ folder: "", unreadable: `${folder} is not a folder.` }]);

      // Once it reads again, the same assignment carries on, still held.
      yield* Effect.promise(async () => {
        await rm(folder);
        await mkdir(join(folder, "release"), { recursive: true });
        await writeFile(join(folder, "release/SKILL.md"), skillMd("release"));
      });
      yield* agents.sync;
      expect(yield* library.assignments(release.id)).toMatchObject([{ id: everyone.id, held: true }]);
      expect(yield* agents.problems).toEqual([]);
    }).pipe(Effect.provide(await layerFor(folder)), Effect.runPromise);
  });

  // covers ADR 029 (The clean-runtime rule: ~/.agents/skills stays, through Hobbots), #1060
  it("[TC-AG-146] notices a change on its own, and outlives the folder being replaced by a file", async () => {
    const folder = await folderOf({ "release/SKILL.md": skillMd("release"), "release/notes/a.md": "a" });
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      const agents = yield* AgentsFolder;
      const [release] = yield* library.list;
      if (release === undefined) return expect.unreachable();
      const revisionsOf = () => Effect.runPromise(Effect.map(library.get(release.id), (skill) => skill?.revisions));
      const poll = <A>(read: () => Promise<A>) => expect.poll(read, { timeout: 5_000, interval: 100 });

      // A change deep in a skill's folder, with no sync asked for, is a new revision.
      yield* Effect.promise(() => writeFile(join(folder, "release/notes/a.md"), "b"));
      yield* Effect.promise(() => poll(revisionsOf).toBe(2));

      // Swapped for a file in one go, while the watch still has events for it to come: nothing
      // throws, and the read that follows says why it could not read the folder.
      rmSync(folder, { recursive: true });
      writeFileSync(folder, "not a folder");
      yield* Effect.promise(() =>
        poll(() => Effect.runPromise(agents.problems)).toMatchObject([{ unreadable: `${folder} is not a folder.` }]),
      );

      // A folder again: the next read watches the new one, so its changes are noticed on their own.
      yield* Effect.promise(async () => {
        await rm(folder);
        await mkdir(join(folder, "release"), { recursive: true });
        await writeFile(join(folder, "release/SKILL.md"), skillMd("release"));
      });
      yield* agents.sync;
      expect(yield* agents.problems).toEqual([]);
      const before = (yield* Effect.promise(revisionsOf)) ?? 0;
      yield* Effect.promise(() => writeFile(join(folder, "release/SKILL.md"), skillMd("release", "Releases, now.")));
      yield* Effect.promise(() => poll(revisionsOf).toBe(before + 1));
    }).pipe(Effect.provide(await layerFor(folder)), Effect.runPromise);
  }, 20_000);

  it("[TC-AG-133] reads nothing, and fails nothing, while the folder is not there", async () => {
    const layer = await layerFor(join(await temp("home"), ".agents", "skills"));
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      expect(yield* library.list).toEqual([]);
      expect(yield* (yield* AgentsFolder).problems).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.runPromise);
  });
});
