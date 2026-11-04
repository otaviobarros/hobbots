/**
 * Splits the browser tests into shards of about equal running time. Playwright's own `--shard`
 * splits by test count in file order, which put the long orchestration tests in one shard.
 *
 * A test is known by the tag its title starts with (`[TC-CH-001]`, STD-TEST-001), or by its whole
 * title when it has none. Tests that share a tag run in the same shard.
 */

/** How long each test took in a recorded run, in milliseconds, by its tag. */
export type Durations = Readonly<Record<string, number>>;

/** The tag that names a test: the bracketed case ID its title starts with, else the whole title. */
export const tagOf = (title: string): string => /^\[[^\]]+\]/.exec(title)?.[0] ?? title;

/**
 * Deals the recorded tests out to `total` shards, longest first, each to the shard with the least
 * time so far. The same durations always give the same shards.
 */
export const planShards = (durations: Durations, total: number): ReadonlyArray<ReadonlyArray<string>> => {
  const shards = Array.from({ length: total }, () => ({ load: 0, tags: [] as string[] }));
  const longestFirst = Object.entries(durations).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  for (const [tag, duration] of longestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.load += duration;
    lightest.tags.push(tag);
  }
  return shards.map((shard) => shard.tags);
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An empty list matches no test: an empty pattern would match every one.
const anyOf = (tags: ReadonlyArray<string>) => (tags.length === 0 ? /(?!)/ : new RegExp(tags.map(literal).join("|")));

/** The `grep` options that run one shard: `current` of `total`, counted from 1. */
export interface ShardFilter {
  readonly grep?: RegExp;
  readonly grepInvert?: RegExp;
}

/**
 * Runs the tests planned for shard `current`. The last shard runs every test the others do not,
 * so a test with no recorded duration yet still runs once.
 */
export const shardFilter = (durations: Durations, current: number, total: number): ShardFilter => {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(current) || current < 1 || current > total) {
    throw new Error(`A shard is current/total with 1 <= current <= total, not ${current}/${total}.`);
  }
  const shards = planShards(durations, total);
  if (current < total) return { grep: anyOf(shards[current - 1] ?? []) };
  const others = shards.slice(0, -1).flat();
  return others.length === 0 ? {} : { grepInvert: anyOf(others) };
};

/** Reads `HOBBOTS_E2E_SHARD`, shaped `current/total`, such as `2/4`. */
export const parseShard = (value: string): { readonly current: number; readonly total: number } => {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (match === null) throw new Error(`HOBBOTS_E2E_SHARD is current/total, such as 2/4, not "${value}".`);
  return { current: Number(match[1]), total: Number(match[2]) };
};
