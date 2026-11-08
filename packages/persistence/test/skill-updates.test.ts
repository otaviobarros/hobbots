import { SkillLibrary, SkillUpdateLog } from "@hobbots/agents";
import { SkillName, SkillRevisionHash, SkillSourceId, SkillUpdate } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { EventJournal, SkillLibraryLive, SkillUpdateLogLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// #1097: updates from a skill's Git source (ADR 029, Updates from a source), on SQLite and PostgreSQL.

const TestLayer = Layer.mergeAll(SkillLibraryLive, SkillUpdateLogLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, SkillLibrary | SkillUpdateLog | EventJournal>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const H1 = SkillRevisionHash.make("a".repeat(64));
const H2 = SkillRevisionHash.make("b".repeat(64));
const H3 = SkillRevisionHash.make("c".repeat(64));
const H4 = SkillRevisionHash.make("d".repeat(64));

/** A skill from Git at r1, and an update of it to `hash`. */
const seeded = Effect.gen(function* () {
  const library = yield* SkillLibrary;
  const { value } = yield* library.addRevision(null, {
    hash: H1,
    name: SkillName.make("release"),
    description: "How this repository releases.",
    charms: [],
    files: [{ path: "SKILL.md", mode: "regular", size: 10, sha256: "0".repeat(64) }],
    flags: [],
    dropped: [],
    origin: { _tag: "Git", url: "https://github.com/acme/skills", ref: null },
    commit: "1234567",
    path: "skills/release",
    label: null,
    addedBy: { _tag: "You" },
  });
  const sourceId = value.skill.sourceId ?? SkillSourceId.make("none");
  const updateTo = (hash: SkillRevisionHash, base: SkillRevisionHash = H1) =>
    new SkillUpdate({
      skillId: value.skill.id,
      name: value.skill.name,
      sourceId,
      base,
      baseNumber: base === H1 ? 1 : 2,
      hash,
      commit: "89abcde",
      label: "v1.1.0",
      path: "skills/release",
      files: [{ path: "scripts/tag.sh", change: "added", mode: "executable", size: 20 }],
      instructions: [{ path: "SKILL.md", before: "Tag.", after: "Tag, then push.", cut: false }],
      flags: [{ _tag: "Script", path: "scripts/tag.sh" }],
      state: "waiting",
      foundAt: "2026-11-08T09:00:00.000Z",
    });
  return { skill: value.skill, updateTo };
});

describe("skill updates", () => {
  // covers ADR 029 (Updates from a source), #1097
  it("[TC-DP-1097-01] keeps one update per skill, journals what changes, and keeps a dismissed one dismissed", () =>
    run(
      Effect.gen(function* () {
        const { skill, updateTo } = yield* seeded;
        const log = yield* SkillUpdateLog;
        const found = yield* log.found(updateTo(H2));
        expect(found?.entries.map((entry) => entry.type)).toEqual(["SkillUpdateFound"]);
        expect(yield* log.waiting).toEqual([updateTo(H2)]);
        // The same content found again changes nothing.
        expect(yield* log.found(updateTo(H2))).toBeNull();
        // Against a newer revision of the skill, the waiting one is reviewed again, so Update compares
        // it with the newest; found again against the first, it goes back.
        const rebased = yield* log.found(updateTo(H2, H4));
        expect(rebased?.entries.map((entry) => entry.type)).toEqual(["SkillUpdateFound"]);
        expect((yield* log.get(skill.id))?.base).toBe(H4);
        yield* log.found(updateTo(H2));

        const dismissed = yield* log.dismiss(skill.id, H2);
        expect(dismissed?.value.state).toBe("dismissed");
        expect(dismissed?.entries.map((entry) => entry.type)).toEqual(["SkillUpdateDismissed"]);
        expect(yield* log.dismiss(skill.id, H2)).toBeNull();
        expect(yield* log.found(updateTo(H2))).toBeNull();
        // Not now holds whatever the skill's newest revision is.
        expect(yield* log.found(updateTo(H2, H4))).toBeNull();
        expect(yield* log.waiting).toEqual([]);
        expect((yield* log.get(skill.id))?.state).toBe("dismissed");

        // A newer upstream change replaces it, waiting.
        yield* log.found(updateTo(H3));
        expect((yield* log.waiting).map((one) => one.hash)).toEqual([H3]);
        // Clearing another content leaves it; clearing its own takes it away.
        expect(yield* log.clear(skill.id, H2)).toBeNull();
        const cleared = yield* log.clear(skill.id, H3);
        expect(cleared?.entries.map((entry) => entry.type)).toEqual(["SkillUpdateCleared"]);
        expect(yield* log.get(skill.id)).toBeNull();
      }),
    ));

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-DP-1097-02] keeps Update automatically per skill and the last check, journaling only a change", () =>
    run(
      Effect.gen(function* () {
        const { skill } = yield* seeded;
        const log = yield* SkillUpdateLog;
        expect(yield* log.automatic).toEqual([]);
        const on = yield* log.setAutomatic(skill.id, true);
        expect(on?.entries.map((entry) => entry.type)).toEqual(["SkillAutoUpdateChanged"]);
        expect(yield* log.setAutomatic(skill.id, true)).toBeNull();
        expect(yield* log.automatic).toEqual([skill.id]);
        yield* log.setAutomatic(skill.id, false);
        expect(yield* log.automatic).toEqual([]);

        expect(yield* log.lastCheck).toEqual({ checkedAt: null, problems: [] });
        const problems = [{ sourceId: skill.sourceId ?? SkillSourceId.make("none"), message: "Could not fetch." }];
        yield* log.checked("2026-11-08T09:00:00.000Z", problems);
        yield* log.checked("2026-11-08T10:00:00.000Z", problems);
        expect(yield* log.lastCheck).toEqual({ checkedAt: "2026-11-08T10:00:00.000Z", problems });
      }),
    ));
});
