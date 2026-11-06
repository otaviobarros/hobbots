import { rm, writeFile } from "node:fs/promises";
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

  it("[TC-AG-133] reads nothing, and fails nothing, while the folder is not there", async () => {
    const layer = await layerFor(join(await temp("home"), ".agents", "skills"));
    await Effect.gen(function* () {
      const library = yield* SkillLibrary;
      expect(yield* library.list).toEqual([]);
      expect(yield* (yield* AgentsFolder).problems).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.runPromise);
  });
});
