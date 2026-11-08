import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SkillLibrary, SkillUpdateLog } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { SkillImporter, SkillImporterLive, SkillObjectsLive, SkillUpdates, SkillUpdatesLive } from "../src/index.ts";
import { SkillLibraryFake, SkillUpdateLogFake } from "../src/testing.ts";
import { type Fixture, repositoryOf, skillMd, temp } from "./fixtures.ts";

// #1097: updates from a skill's Git source (ADR 029, Updates from a source).

const you = { _tag: "You" } as const;

const updatesLayer = async () => {
  const data = await temp("data");
  return SkillUpdatesLive.pipe(
    Layer.provideMerge(SkillImporterLive),
    Layer.provideMerge(Layer.mergeAll(SkillObjectsLive(data), SkillLibraryFake, SkillUpdateLogFake)),
  );
};

type Services = SkillUpdates | SkillImporter | SkillLibrary | SkillUpdateLog;

const run =
  (layer: Layer.Layer<Services, never, never>) =>
  <A, E>(effect: Effect.Effect<A, E, Services>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise);

/** A repository with `fixture`, and a way to commit a change to it. */
const upstreamOf = async (fixture: Fixture) => {
  const repository = await repositoryOf(fixture);
  const commit = async (files: Fixture, message = "change") => {
    for (const [path, file] of Object.entries(files)) {
      const target = join(repository.root, path);
      await mkdir(dirname(target), { recursive: true });
      const spec = typeof file === "string" ? { text: file } : file;
      await writeFile(target, spec.text);
      if (spec.executable === true) await chmod(target, 0o755);
    }
    repository.git("add", "--all");
    repository.git("commit", "--quiet", "--message", message);
    return repository.git("rev-parse", "HEAD");
  };
  return { ...repository, commit, source: { _tag: "Git", url: repository.url, ref: "main" } as const };
};

/** Imports `folder` of the upstream and gives it to every hob. */
const imported = (source: { readonly _tag: "Git"; readonly url: string; readonly ref: string }, folder: string) =>
  Effect.gen(function* () {
    const [added] = yield* (yield* SkillImporter).add(source, { by: you, folders: [folder] });
    if (added === undefined) return yield* Effect.die("nothing imported");
    const library = yield* SkillLibrary;
    yield* library.assign({
      skillId: added.skill.id,
      scope: { _tag: "Everyone" },
      pin: added.revision.hash,
      held: false,
      onlyWhenAsked: false,
      by: you,
    });
    return added;
  });

describe("skill updates from Git", () => {
  // covers ADR 029 (Updates from a source), #1097
  it("[TC-AG-1097-01] shows a new upstream commit as an update with its diff, and changes nothing until you accept it", async () => {
    const upstream = await upstreamOf({
      "skills/release/SKILL.md": skillMd("release"),
      "skills/release/notes.md": "Tag, then push.",
      "skills/release/old.md": "Gone soon.",
    });
    await run(await updatesLayer())(
      Effect.gen(function* () {
        const first = yield* imported(upstream.source, "skills/release");
        const updates = yield* SkillUpdates;
        const log = yield* SkillUpdateLog;
        const library = yield* SkillLibrary;

        // Nothing upstream moved: the check finds no update.
        const quiet = yield* updates.check;
        expect(quiet.problems).toEqual([]);
        expect(yield* log.waiting).toEqual([]);

        const commit = yield* Effect.promise(() =>
          upstream.commit({
            "skills/release/SKILL.md": skillMd("release", "What release is for.", "").replace(
              "Steps for release.",
              "Steps for release.\nWrite dates as Nov 4.",
            ),
            "skills/release/checklist.md": "Run the checks.",
          }),
        );
        upstream.git("rm", "--quiet", "skills/release/old.md");
        upstream.git("commit", "--quiet", "--message", "drop old notes");
        const head = upstream.git("rev-parse", "HEAD");
        expect(head).not.toBe(commit);

        const checked = yield* updates.check;
        expect(checked.updated).toEqual([]);
        const [update] = yield* log.waiting;
        expect(update).toMatchObject({
          skillId: first.skill.id,
          name: "release",
          base: first.revision.hash,
          baseNumber: 1,
          commit: head,
          path: "skills/release",
          state: "waiting",
          flags: [],
        });
        expect(update?.files.map((file) => [file.path, file.change])).toEqual([
          ["SKILL.md", "changed"],
          ["checklist.md", "added"],
          ["old.md", "removed"],
        ]);
        expect(update?.instructions).toHaveLength(1);
        expect(update?.instructions[0]?.before).not.toContain("Write dates");
        expect(update?.instructions[0]?.after).toContain("Write dates as Nov 4.");

        // The library and every pin are as they were.
        expect((yield* library.get(first.skill.id))?.latest).toBe(first.revision.hash);
        expect((yield* library.assignments(first.skill.id)).map((one) => one.pin)).toEqual([first.revision.hash]);

        // A second check of the same commit records nothing new.
        yield* updates.check;
        expect((yield* log.waiting).map((one) => one.hash)).toEqual([update?.hash]);

        // Accept adds it as r2 and rolls it out, and the update leaves Updates.
        if (update === undefined) return;
        const accepted = yield* updates.accept(first.skill.id, update.hash, you);
        expect(accepted.revision).toMatchObject({ number: 2, hash: update.hash, commit: head, addedBy: you });
        expect(accepted.rolledOut.map((one) => one.pin)).toEqual([update.hash]);
        expect(yield* log.waiting).toEqual([]);
        yield* updates.check;
        expect(yield* log.waiting).toEqual([]);
      }),
    );
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-AG-1097-02] with Update automatically on, rolls out a clean update by its source, and keeps one that adds a script waiting", async () => {
    const upstream = await upstreamOf({ "SKILL.md": skillMd("writing") });
    await run(await updatesLayer())(
      Effect.gen(function* () {
        const first = yield* imported(upstream.source, "");
        const updates = yield* SkillUpdates;
        const log = yield* SkillUpdateLog;
        const library = yield* SkillLibrary;
        yield* log.setAutomatic(first.skill.id, true);

        yield* Effect.promise(() => upstream.commit({ "SKILL.md": skillMd("writing", "Plain words, short lines.") }));
        const clean = yield* updates.check;
        expect(clean.updated).toEqual([first.skill.id]);
        expect((yield* library.get(first.skill.id))?.revisions).toBe(2);
        const [newest] = yield* library.revisions(first.skill.id);
        const sourceId = first.skill.sourceId;
        expect(newest?.addedBy).toEqual({ _tag: "Source", sourceId });
        const [assignment] = yield* library.assignments(first.skill.id);
        expect(assignment?.pin).toBe(newest?.hash);
        expect(yield* log.waiting).toEqual([]);

        // It can be rolled back like your own edit.
        if (assignment === undefined) return;
        const back = yield* library.rollOut(assignment.id, first.revision.hash, you);
        expect(back.value.pin).toBe(first.revision.hash);

        // One that adds a script waits for you, with the flag shown, and moves nothing.
        yield* Effect.promise(() =>
          upstream.commit({
            "SKILL.md": skillMd("writing", "Plain words, short lines.", "").replace("Steps", "Run scripts/check.sh"),
            "scripts/check.sh": { text: "#!/bin/sh\necho ok\n", executable: true },
          }),
        );
        const flagged = yield* updates.check;
        expect(flagged.updated).toEqual([]);
        const [waiting] = yield* log.waiting;
        expect(waiting?.flags).toEqual([{ _tag: "Script", path: "scripts/check.sh" }]);
        expect((yield* library.get(first.skill.id))?.revisions).toBe(2);
      }),
    );
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-AG-1097-03] flags only what an update changes, and Not now keeps it out until the source changes again", async () => {
    const upstream = await upstreamOf({
      "SKILL.md": skillMd("audit", "Audits pages.", "").replace("Steps for audit.", "See https://example.com/a."),
      "scripts/run.sh": { text: "#!/bin/sh\necho run\n", executable: true },
    });
    await run(await updatesLayer())(
      Effect.gen(function* () {
        const first = yield* imported(upstream.source, "");
        const updates = yield* SkillUpdates;
        const log = yield* SkillUpdateLog;

        // The script it always had, unchanged, and a URL it already had raise nothing.
        yield* Effect.promise(() =>
          upstream.commit({
            "SKILL.md": skillMd("audit", "Audits pages.", "").replace(
              "Steps for audit.",
              "See https://example.com/a.\nThen https://example.com/b.\nHidden​here.",
            ),
          }),
        );
        yield* updates.check;
        const [update] = yield* log.waiting;
        expect(update?.flags).toEqual([
          { _tag: "Url", path: "SKILL.md", url: "https://example.com/b" },
          { _tag: "HiddenText", path: "SKILL.md", codePoint: "U+200B" },
        ]);

        // Not now: the same upstream content stays out of Updates.
        if (update === undefined) return;
        expect((yield* log.dismiss(first.skill.id, update.hash))?.value.state).toBe("dismissed");
        yield* updates.check;
        expect(yield* log.waiting).toEqual([]);

        // A newer upstream change shows again.
        yield* Effect.promise(() => upstream.commit({ "notes.md": "More." }));
        yield* updates.check;
        expect((yield* log.waiting).map((one) => one.state)).toEqual(["waiting"]);
      }),
    );
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-AG-1097-04] refuses an update the source moved on from, and names a source it cannot read", async () => {
    const upstream = await upstreamOf({ "SKILL.md": skillMd("deploy") });
    await run(await updatesLayer())(
      Effect.gen(function* () {
        const first = yield* imported(upstream.source, "");
        const updates = yield* SkillUpdates;
        const log = yield* SkillUpdateLog;
        yield* Effect.promise(() => upstream.commit({ "notes.md": "One." }));
        yield* updates.check;
        const [update] = yield* log.waiting;
        if (update === undefined) return yield* Effect.die("no update");

        // The branch moved on since: accepting what you reviewed is refused, and nothing is added.
        yield* Effect.promise(() => upstream.commit({ "notes.md": "Two." }));
        const moved = yield* Effect.flip(updates.accept(first.skill.id, update.hash, you));
        expect(moved._tag).toBe("SkillSourceChanged");
        expect((yield* (yield* SkillLibrary).get(first.skill.id))?.revisions).toBe(1);

        // A source that cannot be read is a problem of the check, and the library is left as it is.
        upstream.git("branch", "--quiet", "--move", "main", "gone");
        const checked = yield* updates.check;
        expect(checked.problems).toHaveLength(1);
        expect(checked.problems[0]?.sourceId).toBe(first.skill.sourceId);
        expect((yield* log.lastCheck).problems).toEqual(checked.problems);
      }),
    );
  });
});
