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
 * The tags of the tests a spec file declares with a literal title, such as
 * `test("[TC-CH-001] streams a turn", …)`. A title built from a template, such as
 * `` `[TC-UX-${id}] …` ``, is left out: its test still runs, in the last shard.
 */
export const tagsInSource = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/\btest(?:\.(?:only|skip|fixme|fail|slow))?\(\s*["'`](\[[^\]$`"']+\])/g)].map(
    (match) => match[1] ?? "",
  );

// FNV-1a: a tag lands in the same shard on every machine and every run.
const hashOf = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * Deals the recorded tests out to `total` shards, longest first, each to the shard with the least
 * time so far. Each of `tags` with no recorded time yet goes to a shard picked by a hash of the
 * tag, so new tests spread over every shard and a new test never moves another. The same
 * durations and tags always give the same shards.
 */
export const planShards = (
  durations: Durations,
  total: number,
  tags: ReadonlyArray<string> = [],
): ReadonlyArray<ReadonlyArray<string>> => {
  const shards = Array.from({ length: total }, () => ({ load: 0, tags: [] as string[] }));
  const longestFirst = Object.entries(durations).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  for (const [tag, duration] of longestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.load += duration;
    lightest.tags.push(tag);
  }
  const unrecorded = [...new Set(tags)].filter((tag) => !Object.hasOwn(durations, tag)).sort();
  for (const tag of unrecorded) shards[hashOf(tag) % total]?.tags.push(tag);
  return shards.map((shard) => shard.tags);
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An empty list matches no test: an empty pattern would match every one.
const anyOf = (tags: ReadonlyArray<string>) => (tags.length === 0 ? /(?!)/ : new RegExp(tags.map(literal).join("|")));

/** The config that runs one shard: `grep` options from recorded times, or Playwright's `shard`. */
export interface ShardFilter {
  readonly grep?: RegExp;
  readonly grepInvert?: RegExp;
  readonly shard?: { readonly current: number; readonly total: number };
}

/**
 * Runs the tests planned for shard `current`, from the recorded `durations` and the `tags` found
 * in the spec files. The last shard also runs every test the others do not, so a test whose tag
 * could not be read from its source still runs once. With no recorded times at all, it falls back
 * to Playwright's own sharding by test count.
 */
export const shardFilter = (
  durations: Durations | undefined,
  current: number,
  total: number,
  tags: ReadonlyArray<string> = [],
): ShardFilter => {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(current) || current < 1 || current > total) {
    throw new Error(`A shard is current/total with 1 <= current <= total, not ${current}/${total}.`);
  }
  if (durations === undefined || Object.keys(durations).length === 0) return { shard: { current, total } };
  const shards = planShards(durations, total, tags);
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
