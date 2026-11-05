import { describe, expect, it } from "vitest";
import { durationsOf } from "./record-durations.ts";
import { parseShard, planShards, shardFilter, tagOf, tagsInSource } from "./shards.ts";

const durations = { "[TC-A-001]": 90, "[TC-A-002]": 60, "[TC-A-003]": 50, "[TC-A-004]": 40, "[#12]": 30, plain: 10 };

describe("tagOf", () => {
  it("names a test by the tag its title starts with, else by its whole title", () => {
    expect(tagOf("[TC-CH-001] streams a turn")).toBe("[TC-CH-001]");
    expect(tagOf("[#153] a tool step shows short output")).toBe("[#153]");
    expect(tagOf("no tag here [TC-CH-001]")).toBe("no tag here [TC-CH-001]");
  });
});

describe("planShards", () => {
  it("deals the longest tests first to the shard with the least time", () => {
    expect(planShards(durations, 2)).toEqual([
      ["[TC-A-001]", "[TC-A-004]", "plain"],
      ["[TC-A-002]", "[TC-A-003]", "[#12]"],
    ]);
  });

  it("places every test once", () => {
    const shards = planShards(durations, 4);
    expect(shards.flat().sort()).toEqual(Object.keys(durations).sort());
  });

  it("spreads the tests with no recorded time over every shard, not only the last", () => {
    const unrecorded = Array.from({ length: 40 }, (_, index) => `[TC-NEW-${String(index).padStart(3, "0")}]`);
    const shards = planShards(durations, 4, [...Object.keys(durations), ...unrecorded]);
    expect(shards.flat().sort()).toEqual([...Object.keys(durations), ...unrecorded].sort());
    for (const shard of shards) expect(shard.some((tag) => tag.startsWith("[TC-NEW-"))).toBe(true);
  });

  it("keeps a test with no recorded time in its shard when other tests are added", () => {
    const shardOf = (tags: ReadonlyArray<string>, tag: string) =>
      planShards(durations, 4, tags).findIndex((shard) => shard.includes(tag));
    const before = shardOf(["[TC-NEW-001]"], "[TC-NEW-001]");
    expect(shardOf(["[TC-NEW-000]", "[TC-NEW-001]", "[TC-NEW-002]"], "[TC-NEW-001]")).toBe(before);
  });
});

describe("tagsInSource", () => {
  it("reads the tag of each test with a literal title, across lines and modifiers", () => {
    const source = [
      'test("[TC-A-001] one", async () => {});',
      "test(\n  '[TC-A-002] two',\n  async () => {},\n);",
      "test.skip(`[#12] three`, async () => {});",
      'test.describe("[TC-A-009] a group", () => {});',
      "test(`[TC-A-$" + "{id}] built from a template`, async () => {});",
      'test("no tag", async () => {});',
    ].join("\n");
    expect(tagsInSource(source)).toEqual(["[TC-A-001]", "[TC-A-002]", "[#12]"]);
  });
});

describe("shardFilter", () => {
  const titles = ["[TC-A-001] one", "[TC-A-002] two", "[TC-A-003] three", "[TC-A-004] four", "[#12] five"];
  const run = (current: number, total: number, all: ReadonlyArray<string>) => {
    const { grep, grepInvert } = shardFilter(durations, current, total);
    return all.filter((title) => (grep?.test(title) ?? true) && !(grepInvert?.test(title) ?? false));
  };

  it("runs every test in exactly one shard, a new one in the last", () => {
    const all = [...titles, "[TC-A-999] new, with no recorded time"];
    const shards = [1, 2, 3].map((current) => run(current, 3, all));
    expect(shards.flat().sort()).toEqual([...all].sort());
    expect(shards.at(-1)).toContain("[TC-A-999] new, with no recorded time");
  });

  it("matches a tag literally, not as a pattern or a prefix", () => {
    expect(run(1, 2, ["[TC-A-0010] longer id", "TC-A-001 without brackets"])).toEqual([]);
  });

  it("runs a test with no recorded time in the shard its tag hashes to, and in no other", () => {
    const all = [...titles, "[TC-A-999] new, with no recorded time"];
    const tags = all.map(tagOf);
    const shards = [1, 2, 3].map((current) => {
      const { grep, grepInvert } = shardFilter(durations, current, 3, tags);
      return all.filter((title) => (grep?.test(title) ?? true) && !(grepInvert?.test(title) ?? false));
    });
    expect(shards.flat().sort()).toEqual([...all].sort());
    expect(shards.filter((shard) => shard.includes("[TC-A-999] new, with no recorded time"))).toHaveLength(1);
  });

  it("runs no test in a shard that got none", () => {
    expect(shardFilter({ "[TC-A-001]": 10 }, 1, 2)).toEqual({ grep: /\[TC-A-001\]/ });
    expect(shardFilter({ "[TC-A-001]": 10 }, 2, 2).grep).toBeUndefined();
    expect(shardFilter({ "[TC-A-001]": 10, "[TC-A-002]": 5 }, 3, 3).grepInvert?.test("[TC-A-003] new")).toBe(false);
  });

  it("falls back to Playwright's sharding by count when no times are recorded", () => {
    expect(shardFilter(undefined, 2, 4)).toEqual({ shard: { current: 2, total: 4 } });
    expect(shardFilter({}, 3, 4)).toEqual({ shard: { current: 3, total: 4 } });
  });

  it("refuses a shard outside 1..total", () => {
    expect(() => shardFilter(durations, 0, 4)).toThrow();
    expect(() => shardFilter(durations, 5, 4)).toThrow();
  });
});

describe("parseShard", () => {
  it("reads current/total", () => {
    expect(parseShard("2/4")).toEqual({ current: 2, total: 4 });
    expect(() => parseShard("2 of 4")).toThrow();
  });
});

describe("durationsOf", () => {
  it("adds up each tag's time across reports and nested suites, to a tenth of a second", () => {
    const spec = (title: string, duration: number) => ({ title, tests: [{ results: [{ duration }] }] });
    const reports = [
      { suites: [{ specs: [spec("[TC-A-001] one", 1234)], suites: [{ specs: [spec("[TC-A-002] two", 500)] }] }] },
      { suites: [{ specs: [spec("[TC-A-001] again", 1000)] }] },
    ];
    expect(durationsOf(reports)).toEqual({ "[TC-A-001]": 2200, "[TC-A-002]": 500 });
  });
});
