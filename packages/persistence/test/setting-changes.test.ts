import { HobbotsRepository, HobChanges } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  HUB_ACTOR,
  OWNER_ACTOR,
  roleFields,
  SUMMONING_DEFAULTS,
  type SummoningForEveryHob,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, HobChangesLive, SetupRepository } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, HobChangesLive, SetupRepository.layer).pipe(
  Layer.provideMerge(TestDatabase),
);

const everyHob: SummoningForEveryHob = {
  scope: { summoned: true, self: false, hobs: [] },
  overrides: SUMMONING_DEFAULTS,
};

const hob = (id: string, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({
    id: AgentId.make(id),
    name: id,
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-08T00:00:00.000Z",
    ...extra,
  });

describe("Setting changes", () => {
  // covers PE-001, DP-003
  it("[TC-PE-1357-01] keeps one record with actor, time, before and after for each authority setting a change moves, journaled with it", async () => {
    const result = await Effect.gen(function* () {
      const setup = yield* SetupRepository;
      const sql = yield* SqlClient.SqlClient;
      const moved = yield* setup.update(
        { safetyPreset: "careful", approvedFolders: ["/a"], summoningForEveryHob: everyHob, completed: true },
        OWNER_ACTOR,
      );
      // Nothing an authority setting holds changes: the same preset, the providers, the same answers in another order.
      const still = yield* setup.update(
        {
          safetyPreset: "careful",
          connectedProviders: ["codex"],
          summoningForEveryHob: {
            scope: everyHob.scope,
            overrides: Object.fromEntries(Object.entries(SUMMONING_DEFAULTS).reverse()),
          },
        },
        OWNER_ACTOR,
      );
      const off = yield* setup.update({ summoningForEveryHob: null }, HUB_ACTOR);
      const rows = yield* sql<{ readonly revision: unknown }>`SELECT revision FROM setting_changes ORDER BY revision`;
      const journal = yield* sql<{ readonly sequence: unknown; readonly type: string }>`SELECT sequence, type
        FROM event_journal WHERE type = 'SettingChanged' ORDER BY sequence`;
      return { moved, still, off, changes: yield* setup.changes(10), rows, journal };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.moved.entries.map((entry) => entry.payload._tag)).toEqual([
      "SettingChanged",
      "SettingChanged",
      "SettingChanged",
    ]);
    expect(result.still.entries).toEqual([]);
    expect(result.changes.map((change) => [change.diff.setting, change.actor])).toEqual([
      ["summoningForEveryHob", HUB_ACTOR],
      ["summoningForEveryHob", OWNER_ACTOR],
      ["approvedFolders", OWNER_ACTOR],
      ["safetyPreset", OWNER_ACTOR],
    ]);
    expect(result.changes.map((change) => change.diff)).toEqual([
      { setting: "summoningForEveryHob", before: everyHob, after: null },
      { setting: "summoningForEveryHob", before: null, after: everyHob },
      { setting: "approvedFolders", before: [], after: ["/a"] },
      { setting: "safetyPreset", before: "balanced", after: "careful" },
    ]);
    expect(result.changes.every((change) => !Number.isNaN(Date.parse(change.at)))).toBe(true);
    // Each record takes the sequence of the event that announced it.
    expect(result.rows.map((row) => Number(row.revision))).toEqual(result.journal.map((row) => Number(row.sequence)));
  });

  // covers AG-002, DP-003
  it("[TC-PE-1357-02] shows a setting change in the History of each hob it reached, judged by the version the hob held then", async () => {
    const history = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const setup = yield* SetupRepository;
      yield* repo.insertAgent(hob("made"));
      yield* repo.insertAgent(hob("summoned", { summonedBy: AgentId.make("made") }));
      yield* repo.insertAgent(
        hob("withheld", { policy: { ...EMPTY_HOB_POLICY, charms: { withheld: ["summoning"] } } }),
      );
      // Made after the changes, so they reached it at creation and its History has none of them.
      yield* repo.insertAgent(hob("later", { createdAt: "2999-01-01T00:00:00.000Z" }));
      yield* setup.update({ summoningForEveryHob: everyHob }, OWNER_ACTOR);
      yield* setup.update({ safetyPreset: "trusting" }, OWNER_ACTOR);
      const changes = yield* HobChanges;
      const settingsOf = (id: string) =>
        Effect.map(changes.forHob(AgentId.make(id)), (list) =>
          list.flatMap((change) => (change._tag === "Setting" ? [change.setting.diff.setting] : [])),
        );
      return {
        made: yield* settingsOf("made"),
        summoned: yield* settingsOf("summoned"),
        withheld: yield* settingsOf("withheld"),
        later: yield* settingsOf("later"),
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(history).toEqual({
      made: ["safetyPreset", "summoningForEveryHob"],
      summoned: ["safetyPreset"],
      withheld: ["safetyPreset"],
      later: [],
    });
  });
});
