import { HobbotsRepository, SkillLibrary, type SkillRevisionInput } from "@hobbots/agents";
import { Agent, AgentId, MemoryProjectIdentity, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, SkillLibraryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// #1060: the skills library (ADR 029, Storage and revisions), on SQLite and PostgreSQL.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, SkillLibraryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | SkillLibrary | EventJournal>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const pip = AgentId.make("pip");
const H1 = SkillRevisionHash.make("a".repeat(64));
const H2 = SkillRevisionHash.make("b".repeat(64));
const H3 = SkillRevisionHash.make("c".repeat(64));

const seed = HobbotsRepository.use((repo) =>
  repo.insertAgent(
    new Agent({
      id: pip,
      name: "Pip",
      roleTitle: "Builder",
      runtime: "codex",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  ),
);

const input = (hash: SkillRevisionHash, more: Partial<SkillRevisionInput> = {}): SkillRevisionInput => ({
  hash,
  name: SkillName.make("release"),
  description: "How this repository releases.",
  charms: ["github"],
  files: [{ path: "SKILL.md", mode: "regular", size: 10, sha256: "0".repeat(64) }],
  flags: [{ _tag: "Script", path: "scripts/tag.sh" }],
  dropped: [{ kind: "hooks", path: "hooks/hooks.json" }],
  origin: { _tag: "Git", url: "https://github.com/acme/skills", ref: null },
  commit: "1234567",
  path: "skills/release",
  label: "v1.0.0",
  addedBy: { _tag: "You" },
  ...more,
});

describe("skills library", () => {
  // covers ADR 029 (Storage and revisions), #1060
  it("[TC-DP-276] keeps one revision per content, numbered in order, and records a source once", () =>
    run(
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const first = yield* library.addRevision(null, input(H1));
        expect(first.value.added).toBe(true);
        expect(first.value.revision.number).toBe(1);
        expect(first.entries.map((entry) => entry.type)).toEqual(["SkillRevisionAdded"]);
        const skill = first.value.skill;
        expect(skill.latest).toBe(H1);
        expect(skill.revision).toBe(first.entries[0]?.sequence);

        // The same content again, as a new skill or as a revision, is the revision it already is.
        const again = yield* library.addRevision(null, input(H1));
        expect(again.value).toMatchObject({ added: false, revision: { number: 1 } });
        expect(again.entries).toEqual([]);
        expect((yield* library.addRevision(skill.id, input(H1))).value.added).toBe(false);

        const second = yield* library.addRevision(skill.id, input(H2, { commit: "89abcde", label: null }));
        expect(second.value.revision).toMatchObject({ number: 2, commit: "89abcde", label: null });
        expect(second.value.skill).toMatchObject({ id: skill.id, latest: H2, revisions: 2 });
        expect((yield* library.revisions(skill.id)).map((one) => one.number)).toEqual([2, 1]);
        const kept = yield* library.revision(skill.id, H1);
        expect(kept).toMatchObject({ flags: [{ _tag: "Script" }], dropped: [{ kind: "hooks" }], charms: ["github"] });

        const sources = yield* library.sources;
        expect(sources).toHaveLength(1);
        expect(first.value.revision.sourceId).toBe(sources[0]?.id);
        expect(second.value.revision.sourceId).toBe(sources[0]?.id);
        const journaled = (yield* EventJournal.use((journal) => journal.readAfter(0, 100))).map(
          (entry) => entry.payload,
        );
        expect(journaled.filter((event) => event._tag === "SkillRevisionAdded").map((event) => event.source)).toEqual([
          sources[0],
          null,
        ]);
      }),
    ));

  it("[TC-DP-277] refuses a new skill whose name is taken and a revision that renames its skill", () =>
    run(
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const { value } = yield* library.addRevision(null, input(H1, { origin: null }));
        const taken = yield* Effect.flip(library.addRevision(null, input(H2)));
        expect(taken).toMatchObject({ _tag: "SkillNameTaken", skillId: value.skill.id });
        const renamed = yield* Effect.flip(
          library.addRevision(value.skill.id, input(H2, { name: SkillName.make("ship") })),
        );
        expect(renamed._tag).toBe("SkillNameChanged");
        expect(yield* library.sources).toEqual([]);
        expect((yield* library.get(value.skill.id))?.revisions).toBe(1);
      }),
    ));

  it("[TC-DP-278] assigns a skill once per scope, rolls it out, holds it and takes it off", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        yield* library.addRevision(skill.id, input(H2));
        const project = { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/acme/web") } as const;
        const base = { skillId: skill.id, held: false, onlyWhenAsked: false, by: { _tag: "You" } } as const;
        const everyone = (yield* library.assign({ ...base, scope: { _tag: "Everyone" }, pin: H1 })).value;
        const own = yield* library.assign({ ...base, scope: { _tag: "Hob", agentId: pip }, pin: H1 });
        expect(own.entries[0]?.correlation.agentId).toBe(pip);
        yield* library.assign({ ...base, scope: project, pin: H1 });
        // Assigning again in a scope changes that assignment.
        const changed = (yield* library.assign({ ...base, scope: { _tag: "Everyone" }, pin: H1, onlyWhenAsked: true }))
          .value;
        expect(changed).toMatchObject({ id: everyone.id, onlyWhenAsked: true });
        expect(yield* library.assignments(skill.id)).toHaveLength(3);

        // A pin must be a revision of the skill.
        expect((yield* Effect.flip(library.rollOut(everyone.id, H3, { _tag: "You" })))._tag).toBe("SkillNotFound");
        const rolled = yield* library.rollOut(everyone.id, H2, { _tag: "You" });
        expect(rolled.value.pin).toBe(H2);
        expect(rolled.entries[0]?.payload).toMatchObject({ _tag: "SkillRolledOut", from: H1 });
        const held = yield* library.hold(own.value.id, true);
        expect(held.value.held).toBe(true);
        expect(held.entries[0]?.payload._tag).toBe("SkillHeld");

        const off = yield* library.unassign(own.value.id);
        expect(off?.entries[0]?.payload._tag).toBe("SkillUnassigned");
        expect(yield* library.unassign(own.value.id)).toBeNull();
        expect(yield* library.assignments()).toHaveLength(2);
      }),
    ));

  // covers ADR 029 (Pins and rollout), #1061
  it("[TC-DP-281] rolls a revision out to every assignment that is not held, in one change, and marks it rolled out", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const { skill } = (yield* library.addRevision(null, input(H1))).value;
        const assign = (scope: Parameters<typeof library.assign>[0]["scope"], held: boolean) =>
          library.assign({ skillId: skill.id, scope, pin: H1, held, onlyWhenAsked: false, by: { _tag: "You" } });
        const everyone = (yield* assign({ _tag: "Everyone" }, false)).value;
        const kept = (yield* assign({ _tag: "Hob", agentId: pip }, true)).value;
        const added = (yield* library.addRevision(skill.id, input(H2))).value.revision;
        // A revision just added waits for its rollout, so an interrupted save can finish it.
        expect(added.rolledOutAt).toBeNull();
        const rolled = yield* library.rollOutRevision(skill.id, H2, { _tag: "You" });
        expect(rolled.value.map((one) => [one.id, one.pin])).toEqual([[everyone.id, H2]]);
        expect(rolled.entries.map((entry) => entry.type)).toEqual(["SkillRolledOut"]);
        expect((yield* library.revision(skill.id, H2))?.rolledOutAt).not.toBeNull();
        expect((yield* library.assignments(skill.id)).find((one) => one.id === kept.id)?.pin).toBe(H1);
        // Nothing left to move: the rollout is done.
        expect((yield* library.rollOutRevision(skill.id, H2, { _tag: "You" })).value).toEqual([]);
        expect(yield* Effect.flip(library.rollOutRevision(skill.id, H3, { _tag: "You" }))).toMatchObject({
          _tag: "SkillNotFound",
        });
      }),
    ));

  it("[TC-DP-279] keeps a hob's opt-outs, journaling only a change", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        const out = yield* library.setOptOut(pip, skill.id, true);
        expect(out?.entries[0]?.payload).toMatchObject({ _tag: "SkillOptOutChanged", optedOut: true });
        expect(yield* library.setOptOut(pip, skill.id, true)).toBeNull();
        expect((yield* library.optOuts(pip)).map((one) => one.skillId)).toEqual([skill.id]);
        expect((yield* library.setOptOut(pip, skill.id, false))?.value.skillId).toBe(skill.id);
        expect(yield* library.optOuts()).toEqual([]);
      }),
    ));

  it("[TC-DP-280] refuses to remove a skill something assigns, naming who, and frees its name once removed", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        const assigned = (yield* library.assign({
          skillId: skill.id,
          scope: { _tag: "Hob", agentId: pip },
          pin: H1,
          held: false,
          onlyWhenAsked: false,
          by: { _tag: "You" },
        })).value;
        yield* library.setOptOut(pip, skill.id, true);
        const inUse = yield* Effect.flip(library.remove(skill.id));
        expect(inUse).toMatchObject({ _tag: "SkillInUse", assignments: [{ id: assigned.id }] });
        yield* library.unassign(assigned.id);
        const removed = yield* library.remove(skill.id);
        expect(removed.entries[0]?.payload._tag).toBe("SkillRemoved");
        expect(yield* library.get(skill.id)).toBeNull();
        expect(yield* library.list).toEqual([]);
        expect(yield* library.optOuts()).toEqual([]);
        expect((yield* Effect.flip(library.remove(skill.id)))._tag).toBe("SkillNotFound");
        // The name is free again, for a new skill.
        const next = (yield* library.addRevision(null, input(H1))).value;
        expect(next.added).toBe(true);
        expect(next.skill.id).not.toBe(skill.id);
      }),
    ));
});
