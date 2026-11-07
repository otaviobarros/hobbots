import { HobbotsRepository, SkillLibrary, type SkillRevisionInput } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  MemoryProjectIdentity,
  Message,
  MessageId,
  SkillName,
  SkillRevisionHash,
  SkillUse,
  SkillUseId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
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
  it("[TC-DP-281] rolls a revision out once, to every assignment that is not held, and a later save never undoes a rollback", () =>
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
        const rolled = yield* library.rollOutRevision(skill.id, H2, { _tag: "You" }, "pending");
        expect(rolled.value.map((one) => [one.id, one.pin])).toEqual([[everyone.id, H2]]);
        expect(rolled.entries.map((entry) => entry.type)).toEqual(["SkillRolledOut"]);
        expect((yield* library.revision(skill.id, H2))?.rolledOutAt).not.toBeNull();
        expect((yield* library.assignments(skill.id)).find((one) => one.id === kept.id)?.pin).toBe(H1);
        // A second save of the same content, after a rollback, moves nothing: the rollback stays.
        yield* library.rollOut(everyone.id, H1, { _tag: "You" });
        expect((yield* library.rollOutRevision(skill.id, H2, { _tag: "You" }, "pending")).value).toEqual([]);
        expect((yield* library.assignments(skill.id)).find((one) => one.id === everyone.id)?.pin).toBe(H1);
        // Nor does a save of a revision that is no longer the newest, even one never rolled out.
        yield* library.addRevision(skill.id, input(H3));
        yield* library.rollOut(everyone.id, H1, { _tag: "You" });
        expect((yield* library.revision(skill.id, H1))?.rolledOutAt).toBeNull();
        expect((yield* library.rollOutRevision(skill.id, H1, { _tag: "You" }, "pending")).value).toEqual([]);
        // A rollout you ask for goes ahead whatever the revision's past: Roll back to r2.
        const back = yield* library.rollOutRevision(skill.id, H2, { _tag: "You" }, "always");
        expect(back.value.map((one) => [one.id, one.pin])).toEqual([[everyone.id, H2]]);
        expect(
          yield* Effect.flip(
            library.rollOutRevision(skill.id, H3.replace("c", "d") as never, { _tag: "You" }, "always"),
          ),
        ).toMatchObject({
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

  // covers ADR 029 (The use line), #1096
  it("[TC-DP-282] records each use with its hob, thread and reply, journals it, and reads a skill's or a hob's", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        const use = (at: string, threadId: string | null, source: "library" | "organization" = "library") =>
          new SkillUse({
            id: SkillUseId.make(`use-${at}`),
            source,
            skillId: source === "library" ? skill.id : null,
            name: source === "library" ? "release" : "security",
            pin: source === "library" ? H1 : null,
            number: source === "library" ? 1 : null,
            explicit: threadId !== null,
            agentId: pip,
            threadId: threadId === null ? null : ThreadId.make(threadId),
            messageId: threadId === null ? null : MessageId.make(`reply-${at}`),
            at,
          });
        const first = yield* library.recordUse(use("2026-11-06T10:00:00.000Z", "t1"));
        expect(first.entries[0]).toMatchObject({
          correlation: { agentId: pip, threadId: "t1", messageId: "reply-2026-11-06T10:00:00.000Z" },
          payload: { _tag: "SkillUsed", use: { name: "release", pin: H1, number: 1, explicit: true } },
        });
        yield* library.recordUse(use("2026-11-06T11:00:00.000Z", null));
        yield* library.recordUse(use("2026-11-06T12:00:00.000Z", null, "organization"));
        expect((yield* library.uses({ skillId: skill.id })).map((one) => one.at)).toEqual([
          "2026-11-06T11:00:00.000Z",
          "2026-11-06T10:00:00.000Z",
        ]);
        expect(yield* library.uses({ agentId: pip })).toHaveLength(3);
        expect(yield* library.uses({ agentId: AgentId.make("quill") })).toEqual([]);
        expect((yield* library.uses({})).at(0)).toMatchObject({ source: "organization", skillId: null, pin: null });
      }),
    ));

  // covers ADR 029 (The use line), STD-DATA-001
  it("[TC-DP-284] saves a reply's Used line and its use in one transaction, so a failed write keeps neither", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        const at = "2026-11-06T10:00:00.000Z";
        const threadId = ThreadId.make("t1");
        yield* repo.upsertThread(new Thread({ id: threadId, agentId: pip, title: "t", createdAt: at, updatedAt: at }));
        const used = {
          source: "library",
          skillId: skill.id,
          name: "release",
          pin: H1,
          number: 1,
          explicit: false,
        } as const;
        const reply = new Message({
          id: MessageId.make("reply"),
          threadId,
          role: "assistant",
          content: "",
          status: "streaming",
          error: null,
          configVersion: 1,
          createdAt: at,
          skillsUsed: [used],
        });
        const use = new SkillUse({
          id: SkillUseId.make("use-1"),
          ...used,
          agentId: pip,
          threadId,
          messageId: reply.id,
          at,
        });
        const saved = yield* repo.upsertMessage(reply, [use]);
        expect(saved.entries.map((entry) => entry.payload._tag)).toEqual(["MessageUpserted", "SkillUsed"]);
        expect((yield* library.uses({ messageId: reply.id })).map((one) => one.id)).toEqual(["use-1"]);

        // The same use again fails its insert, and the reply's new text is not saved either.
        const again = yield* Effect.exit(repo.upsertMessage(new Message({ ...saved.value, content: "Later" }), [use]));
        expect(again._tag).toBe("Failure");
        expect((yield* repo.listMessages(threadId)).map((one) => one.content)).toEqual([""]);
        expect(yield* library.uses({ messageId: reply.id })).toHaveLength(1);
      }),
    ));

  // covers ADR 029 (The use line)
  it("[TC-DP-283] counts a skill's uses, its week, and each hob's last uses in the database, one row per answer", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const library = yield* SkillLibrary;
        const skill = (yield* library.addRevision(null, input(H1))).value.skill;
        const use = (id: string, at: string, threadId: string | null, source: "library" | "organization" = "library") =>
          new SkillUse({
            id: SkillUseId.make(id),
            source,
            skillId: source === "library" ? skill.id : null,
            name: "release",
            pin: source === "library" ? H1 : null,
            number: source === "library" ? 1 : null,
            explicit: false,
            agentId: pip,
            threadId: threadId === null ? null : ThreadId.make(threadId),
            messageId: threadId === null ? null : MessageId.make(`reply-${id}`),
            at,
          });
        yield* library.recordUse(use("old", "2026-10-01T10:00:00.000Z", "t1"));
        yield* library.recordUse(use("a", "2026-11-05T10:00:00.000Z", "t1"));
        yield* library.recordUse(use("b", "2026-11-06T10:00:00.000Z", "t2"));
        yield* library.recordUse(use("step", "2026-11-06T11:00:00.000Z", null));
        // An organization skill of the same name is its own skill.
        yield* library.recordUse(use("org", "2026-11-06T12:00:00.000Z", "t2", "organization"));
        const since = "2026-10-31T00:00:00.000Z";
        expect(yield* library.useCounts(skill.id, since)).toEqual({
          skillId: skill.id,
          total: 4,
          thisWeek: 3,
          hobs: [{ agentId: pip, count: 4, lastAt: "2026-11-06T11:00:00.000Z" }],
          threads: [
            { threadId: "t2", agentId: pip, count: 1, lastAt: "2026-11-06T10:00:00.000Z" },
            { threadId: "t1", agentId: pip, count: 2, lastAt: "2026-11-05T10:00:00.000Z" },
          ],
        });
        expect(yield* library.usesSince(since)).toEqual([{ skillId: skill.id, count: 3 }]);
        expect((yield* library.lastUses(pip, 10)).map((one) => one.id)).toEqual(["org", "step"]);
        expect((yield* library.lastUses(pip, 1)).map((one) => one.id)).toEqual(["org"]);
        expect((yield* library.uses({ messageId: MessageId.make("reply-a") })).map((one) => one.id)).toEqual(["a"]);
        expect(yield* library.uses({ agentId: pip, limit: 2 })).toHaveLength(2);
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
