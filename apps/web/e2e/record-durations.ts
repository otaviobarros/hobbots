/**
 * Writes `e2e/durations.json` from Playwright JSON reports, so `shards.ts` can balance the CI
 * shards by time. Refresh it when the suite's slow tests change:
 *
 *   pnpm --filter @hobbots/web exec playwright test --reporter=json > report.json
 *   pnpm --filter @hobbots/web e2e:durations report.json
 *
 * Several reports, such as one per shard, can be passed at once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Durations, tagOf } from "./shards.ts";

interface Suite {
  readonly suites?: ReadonlyArray<Suite>;
  readonly specs?: ReadonlyArray<{
    readonly title: string;
    readonly tests: ReadonlyArray<{ readonly results: ReadonlyArray<{ readonly duration: number }> }>;
  }>;
}

/** Each test's time in the reports, by tag, rounded to a tenth of a second; shared tags add up. */
export const durationsOf = (reports: ReadonlyArray<{ readonly suites: ReadonlyArray<Suite> }>): Durations => {
  const totals = new Map<string, number>();
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const runs = spec.tests.flatMap((test) => test.results.map((result) => result.duration));
      totals.set(tagOf(spec.title), (totals.get(tagOf(spec.title)) ?? 0) + Math.max(0, ...runs));
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const report of reports) for (const suite of report.suites) visit(suite);
  return Object.fromEntries(
    [...totals].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, ms]) => [tag, Math.round(ms / 100) * 100]),
  );
};

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("Pass one or more Playwright JSON reports.");
  const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(resolve(import.meta.dirname, "durations.json"), `${JSON.stringify(durationsOf(reports), null, 2)}\n`);
}
