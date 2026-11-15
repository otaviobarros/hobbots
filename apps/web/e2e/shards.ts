/**
 * Splits the browser tests into shards of about equal running time. Playwright's own `--shard`
 * splits by test count in file order, which put the long orchestration tests in one shard.
 *
 * A shard is a set of spec files, each known by its file name (`chat.e2e.ts`), so a test needs
 * nothing in its title to be placed.
 */

/** How long each spec file's tests took in a recorded run, in milliseconds, by file name. */
export type Durations = Readonly<Record<string, number>>;

// FNV-1a: a file lands in the same shard on every machine and every run.
const hashOf = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * When a shard of `workers` workers finishes, if each worker takes the next test in `order` as
 * soon as it is free, as Playwright's workers do with fully parallel tests. A test late in that
 * order starts late, so a long one there sets the end of the whole shard.
 */
const finishOf = (
  durations: Durations,
  files: ReadonlyArray<string>,
  rank: ReadonlyMap<string, number>,
  workers: number,
): number => {
  const free = Array.from({ length: workers }, () => 0);
  const inOrder = [...files].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  for (const file of inOrder) {
    const next = free.indexOf(Math.min(...free));
    free[next] = (free[next] ?? 0) + (durations[file] ?? 0);
  }
  return Math.max(...free);
};

/**
 * Deals the recorded tests out to `total` shards, longest first, each to the shard that would
 * then finish soonest, with `workers` workers running the shard's tests in the order of `files`
 * (the order Playwright runs them in). With one worker that is the shard with the least time so
 * far. Each of `files` with no recorded time yet goes to a shard picked by a hash of the file, so
 * new tests spread over every shard and a new test never moves another. The same durations,
 * files and workers always give the same shards.
 */
export const planShards = (
  durations: Durations,
  total: number,
  files: ReadonlyArray<string> = [],
  workers = 1,
): ReadonlyArray<ReadonlyArray<string>> => {
  const rank = new Map<string, number>();
  for (const file of files) if (!rank.has(file)) rank.set(file, rank.size);
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
  const longestFirst = Object.entries(durations).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  for (const [file, duration] of longestFirst) {
    let best = shards[0];
    let bestFinish = Infinity;
    for (const shard of shards) {
      const finish = workers === 1 ? shard.load + duration : finishOf(durations, [...shard.files, file], rank, workers);
      if (finish < bestFinish || (finish === bestFinish && best !== undefined && shard.load < best.load)) {
        best = shard;
        bestFinish = finish;
      }
    }
    if (best === undefined) break;
    best.load += duration;
    best.files.push(file);
  }
  const unrecorded = [...rank.keys()].filter((file) => !Object.hasOwn(durations, file)).sort();
  for (const file of unrecorded) shards[hashOf(file) % total]?.files.push(file);
  return shards.map((shard) => shard.files);
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Matches the path of any of `files`, by its whole file name. An empty list matches no file: an
// empty pattern would match every one.
const anyOf = (files: ReadonlyArray<string>) =>
  files.length === 0 ? /(?!)/ : new RegExp(`(?:^|[\\\\/])(?:${files.map(literal).join("|")})$`);

/** The config that runs one shard: the files to run or skip from recorded times, or Playwright's `shard`. */
export interface ShardFilter {
  readonly testMatch?: RegExp;
  readonly testIgnore?: RegExp;
  readonly shard?: { readonly current: number; readonly total: number };
}

/**
 * Runs the spec files planned for shard `current`, from the recorded `durations` and the spec
 * `files` in the order they run, for shards of `workers` workers. The last shard also runs every
 * file the others do not, so a file missing from `files` still runs once. With no recorded times
 * at all, it falls back to Playwright's own sharding by test count.
 */
export const shardFilter = (
  durations: Durations | undefined,
  current: number,
  total: number,
  files: ReadonlyArray<string> = [],
  workers = 1,
): ShardFilter => {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(current) || current < 1 || current > total) {
    throw new Error(`A shard is current/total with 1 <= current <= total, not ${current}/${total}.`);
  }
  if (durations === undefined || Object.keys(durations).length === 0) return { shard: { current, total } };
  const shards = planShards(durations, total, files, workers);
  if (current < total) return { testMatch: anyOf(shards[current - 1] ?? []) };
  const others = shards.slice(0, -1).flat();
  return others.length === 0 ? {} : { testIgnore: anyOf(others) };
};

/** Reads `HOBBOTS_E2E_SHARD`, shaped `current/total`, such as `2/4`. */
export const parseShard = (value: string): { readonly current: number; readonly total: number } => {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (match === null) throw new Error(`HOBBOTS_E2E_SHARD is current/total, such as 2/4, not "${value}".`);
  return { current: Number(match[1]), total: Number(match[2]) };
};
