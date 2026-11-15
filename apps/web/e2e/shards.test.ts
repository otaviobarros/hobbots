import { describe, expect, it } from "vitest";
import { durationsOf } from "./record-durations.ts";
import { parseShard, planShards, shardFilter } from "./shards.ts";

const durations = { "a.e2e.ts": 90, "b.e2e.ts": 60, "c.e2e.ts": 50, "d.e2e.ts": 40, "e.e2e.ts": 30, "f.e2e.ts": 10 };

describe("planShards", () => {
  it("deals the longest tests first to the shard with the least time", () => {
    expect(planShards(durations, 2)).toEqual([
      ["a.e2e.ts", "d.e2e.ts", "f.e2e.ts"],
      ["b.e2e.ts", "c.e2e.ts", "e.e2e.ts"],
    ]);
  });

  it("with two workers, keeps a long test that runs last from ending its shard late", () => {
    const timed = { "[M]": 40, "[S-1]": 10, "[S-2]": 10, "[S-3]": 10, "[S-4]": 10, "[L]": 40 };
    const runOrder = ["[M]", "[S-1]", "[S-2]", "[S-3]", "[S-4]", "[L]"];
    // By time alone each shard holds 60 s, but [L] starts only after two short tests: 50 s.
    expect(planShards(timed, 2, runOrder)).toEqual([
      ["[L]", "[S-1]", "[S-3]"],
      ["[M]", "[S-2]", "[S-4]"],
    ]);
    // With the order counted, [L] starts at once and both shards end at 40 s.
    expect(planShards(timed, 2, runOrder, 2)).toEqual([
      ["[L]", "[S-1]"],
      ["[M]", "[S-2]", "[S-3]", "[S-4]"],
    ]);
  });

  it("places every test once", () => {
    const shards = planShards(durations, 4);
    expect(shards.flat().sort()).toEqual(Object.keys(durations).sort());
  });

  it("spreads the tests with no recorded time over every shard, not only the last", () => {
    const unrecorded = Array.from({ length: 40 }, (_, index) => `new-${String(index).padStart(3, "0")}.e2e.ts`);
    const shards = planShards(durations, 4, [...Object.keys(durations), ...unrecorded]);
    expect(shards.flat().sort()).toEqual([...Object.keys(durations), ...unrecorded].sort());
    for (const shard of shards) expect(shard.some((file) => file.startsWith("new-"))).toBe(true);
  });

  it("keeps a test with no recorded time in its shard when other tests are added", () => {
    const shardOf = (files: ReadonlyArray<string>, file: string) =>
      planShards(durations, 4, files).findIndex((shard) => shard.includes(file));
    const before = shardOf(["new-001.e2e.ts"], "new-001.e2e.ts");
    expect(shardOf(["new-000.e2e.ts", "new-001.e2e.ts", "new-002.e2e.ts"], "new-001.e2e.ts")).toBe(before);
  });
});

describe("shardFilter", () => {
  const paths = ["a", "b", "c", "d", "e"].map((name) => `/repo/apps/web/e2e/${name}.e2e.ts`);
  const runs = (filter: { testMatch?: RegExp; testIgnore?: RegExp }, path: string) =>
    (filter.testMatch?.test(path) ?? true) && !(filter.testIgnore?.test(path) ?? false);
  const run = (current: number, total: number, all: ReadonlyArray<string>, files?: ReadonlyArray<string>) => {
    const filter = shardFilter(durations, current, total, files);
    return all.filter((path) => runs(filter, path));
  };

  it("runs every spec file in exactly one shard, a new one in the last", () => {
    const all = [...paths, "/repo/apps/web/e2e/new.e2e.ts"];
    const shards = [1, 2, 3].map((current) => run(current, 3, all));
    expect(shards.flat().sort()).toEqual([...all].sort());
    expect(shards.at(-1)).toContain("/repo/apps/web/e2e/new.e2e.ts");
  });

  it("matches a whole file name literally, not as a pattern or a suffix", () => {
    expect(run(1, 2, ["/repo/e2e/xa.e2e.ts", "/repo/e2e/aXe2e.ts"])).toEqual([]);
  });

  it("runs a file with no recorded time in the shard its name hashes to, and in no other", () => {
    const all = [...paths, "/repo/apps/web/e2e/new.e2e.ts"];
    const files = all.map((path) => path.split("/").at(-1) ?? "");
    const shards = [1, 2, 3].map((current) => run(current, 3, all, files));
    expect(shards.flat().sort()).toEqual([...all].sort());
    expect(shards.filter((shard) => shard.includes("/repo/apps/web/e2e/new.e2e.ts"))).toHaveLength(1);
  });

  it("runs no file in a shard that got none", () => {
    expect(shardFilter({ "a.e2e.ts": 10 }, 1, 2).testMatch?.test("/e2e/a.e2e.ts")).toBe(true);
    expect(shardFilter({ "a.e2e.ts": 10 }, 2, 2).testMatch).toBeUndefined();
    expect(shardFilter({ "a.e2e.ts": 10, "b.e2e.ts": 5 }, 3, 3).testIgnore?.test("/e2e/c.e2e.ts")).toBe(false);
    expect(shardFilter({ "a.e2e.ts": 10, "b.e2e.ts": 5 }, 1, 3).testMatch?.test("/e2e/b.e2e.ts")).toBe(false);
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
  it("adds up each spec file's time across reports and nested suites, to a tenth of a second", () => {
    const spec = (title: string, duration: number) => ({ title, tests: [{ results: [{ duration }] }] });
    const reports = [
      { suites: [{ file: "a.e2e.ts", specs: [spec("one", 1234)], suites: [{ specs: [spec("two", 500)] }] }] },
      {
        suites: [
          { file: "a.e2e.ts", specs: [spec("again", 1000)] },
          { file: "b.e2e.ts", specs: [spec("b", 500)] },
        ],
      },
    ];
    expect(durationsOf(reports)).toEqual({ "a.e2e.ts": 2700, "b.e2e.ts": 500 });
  });
});
