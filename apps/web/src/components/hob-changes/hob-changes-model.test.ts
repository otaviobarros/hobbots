import {
  AgentConfiguration,
  AgentId,
  type ChangeActor,
  EMPTY_HOB_POLICY,
  type HobChange,
  roleFields,
  YOU,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  canRevert,
  changedByNote,
  fieldDiffs,
  filterChoices,
  filtersFromSearch,
  makerOf,
  matchesFilters,
  NO_FILTERS,
  searchFromFilters,
  type VersionChange,
} from "./hob-changes-model.ts";

const wren = AgentId.make("wren");
const chief = AgentId.make("chief");
const call = { scope: "task:hire", key: "k1" };
const byChief: ChangeActor = { _tag: "Hob", hobId: chief, call };

const config = (version: number, fields: Partial<AgentConfiguration> = {}) =>
  new AgentConfiguration({
    agentId: wren,
    version,
    name: "Wren",
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "Write well.",
    lookSeed: 7,
    lookColor: "moss",
    createdAt: `2026-11-0${version}T10:00:00.000Z`,
    ...fields,
  });

const version = (
  number: number,
  fields: Partial<AgentConfiguration> = {},
  actor: ChangeActor = YOU,
  previous: AgentConfiguration | null = number === 1 ? null : config(number - 1),
): VersionChange => ({
  _tag: "Version",
  hobId: wren,
  at: `2026-11-0${number}T10:00:00.000Z`,
  actor,
  origin: actor._tag === "You" ? null : { charm: "Summoning", taskId: null, threadId: null, messageId: null },
  config: config(number, { ...fields, actor }),
  previous,
});

describe("a hob's changes", () => {
  it("lists only the fields a version changed, instructions and folders line by line", () => {
    const change = version(2, {
      name: "Ash",
      instructions: "Write well.\nCite sources.",
      policy: { ...EMPTY_HOB_POLICY, ownFolders: ["/work/notes"] },
    });
    expect(fieldDiffs(change).map(({ key, before, after, lines }) => [key, before, after, lines])).toEqual([
      ["name", "Wren", "Ash", false],
      ["instructions", "Write well.", "Write well.\nCite sources.", true],
      ["ownFolders", "", "/work/notes", true],
    ]);
  });

  it("shows a change to which hobs Summoning manages, and to the Charms taken away", () => {
    const summoning = (scope: { summoned: boolean; hobs: ReadonlyArray<string>; self: boolean }) => ({
      ...EMPTY_HOB_POLICY,
      charms: { granted: ["summoning" as const], summoning: scope },
    });
    const held = config(1, { policy: summoning({ summoned: true, hobs: [], self: false }) });
    const narrowed = version(2, { policy: summoning({ summoned: false, hobs: [chief], self: false }) }, YOU, held);
    const names = (id: string) => (id === chief ? "Chief" : "another hob");
    expect(fieldDiffs(narrowed, names).map(({ key, before, after }) => [key, before, after])).toEqual([
      ["summoning", "Hobs it summoned: Yes\nItself: No", "Hobs it summoned: No\nItself: No\nPicked by you: Chief"],
    ]);

    const withheld = version(2, { policy: { ...EMPTY_HOB_POLICY, charms: { withheld: ["github"] } } });
    expect(fieldDiffs(withheld).find((diff) => diff.key === "withheldCharms")).toMatchObject({
      before: "",
      after: "GitHub",
    });
  });

  it("shows the first version's fields as added", () => {
    const diffs = fieldDiffs(version(1));
    expect(diffs.find((diff) => diff.key === "name")).toMatchObject({ before: "", after: "Wren" });
    expect(diffs.find((diff) => diff.key === "brain")).toMatchObject({
      after: "Claude Code · Default model · Default effort",
    });
  });

  it("names who made a change and offers Revert only for the latest version after the first", () => {
    expect(makerOf(version(2))).toEqual({ kind: "you" });
    expect(makerOf(version(2, {}, byChief))).toEqual({ kind: "hob", hobId: chief });
    const proposed: ChangeActor = { _tag: "YouApplyingProposal", hobId: chief, proposalId: "p1", call };
    expect(makerOf(version(2, {}, proposed))).toEqual({ kind: "proposal", hobId: chief });

    expect(canRevert(version(2), { configVersion: 2 })).toBe(true);
    expect(canRevert(version(2), { configVersion: 3 })).toBe(false);
    expect(canRevert(version(1), { configVersion: 1 })).toBe(false);
    expect(canRevert(version(2), undefined)).toBe(false);
  });

  it("filters the Changes log by hob, maker and Charm, and lists the choices each filter has", () => {
    const paused: HobChange = {
      _tag: "Status",
      hobId: chief,
      at: "2026-11-05T10:00:00.000Z",
      actor: YOU,
      origin: null,
      from: "active",
      status: "paused",
    };
    const changes = [version(3, {}, byChief), paused, version(2)];
    expect(filterChoices(changes)).toEqual({ hobs: [wren, chief], actors: [chief, "you"], charms: ["Summoning", ""] });
    const shown = (filters: Partial<typeof NO_FILTERS>) =>
      changes.filter((change) => matchesFilters(change, { ...NO_FILTERS, ...filters }));
    expect(shown({})).toHaveLength(3);
    expect(shown({ hob: chief })).toEqual([paused]);
    expect(shown({ actor: "you" })).toEqual([paused, changes[2]]);
    expect(shown({ actor: chief, charm: "Summoning" })).toEqual([changes[0]]);
    expect(shown({ charm: "" })).toEqual([paused, changes[2]]);
  });

  it("notes on Home the hob behind the newest change until you open the profile", () => {
    const changes = [version(3, {}, byChief), version(2)];
    expect(changedByNote(wren, changes, undefined)).toBe(chief);
    expect(changedByNote(wren, changes, "2026-11-02T00:00:00.000Z")).toBe(chief);
    expect(changedByNote(wren, changes, "2026-11-03T10:00:00.000Z")).toBeNull();
    expect(changedByNote(wren, [version(2)], undefined)).toBeNull();
    expect(changedByNote(chief, changes, undefined)).toBeNull();
  });
});

describe("the Changes log's address", () => {
  it("keeps each filter, and a change made through no Charm as none", () => {
    const filters = { hob: AgentId.make("pip"), actor: "you", charm: "" } as const;
    expect(searchFromFilters(filters)).toEqual({ hob: "pip", by: "you", charm: "none" });
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
  });

  it("leaves out a filter that shows every value", () => {
    expect(searchFromFilters(NO_FILTERS)).toEqual({});
    expect(filtersFromSearch({})).toEqual(NO_FILTERS);
    expect(filtersFromSearch({ charm: "github" })).toEqual({ ...NO_FILTERS, charm: "github" });
  });
});
