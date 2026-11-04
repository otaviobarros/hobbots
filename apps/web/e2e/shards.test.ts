import { describe, expect, it } from "vitest";
import { durationsOf } from "./record-durations.ts";
import { parseShard, planShards, shardFilter, tagOf } from "./shards.ts";

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

  it("runs no test in a shard that got none, and every test in a last shard alone", () => {
    expect(shardFilter({}, 1, 2).grep?.test("[TC-A-001] one")).toBe(false);
    expect(shardFilter({}, 2, 2)).toEqual({});
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
