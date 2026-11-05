import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { type Durations, parseShard, shardFilter, tagsInSource } from "./e2e/shards.ts";

// Browser checks of the served web client against a real hub. Each test starts its own hub with
// an empty data folder on its worker's port (see e2e/hub.ts), so tests run in parallel.
//
// HOBBOTS_E2E_SHARD=2/6 runs one of six shards balanced by the times in e2e/durations.json, with
// the tests that have no time yet spread over every shard (see e2e/shards.ts); CI runs each shard
// on its own runner.
const testDir = new URL("e2e/", import.meta.url);
const recorded = new URL("durations.json", testDir);
const shardOf = (value: string) => {
  const { current, total } = parseShard(value);
  const durations = existsSync(recorded) ? (JSON.parse(readFileSync(recorded, "utf8")) as Durations) : undefined;
  const tags = readdirSync(testDir)
    .filter((file) => file.endsWith(".e2e.ts"))
    .flatMap((file) => tagsInSource(readFileSync(new URL(file, testDir), "utf8")));
  return shardFilter(durations, current, total, tags);
};
const shard = process.env.HOBBOTS_E2E_SHARD;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: ci,
  timeout: 60_000,
  // On CI a failed test runs once more, after the rest of the shard, on a quieter runner. One that
  // then passes is reported as flaky, not failed: the job stays green and its summary lists the
  // test, which is a bug to fix (STD-TEST-009). `--fail-on-flaky-tests` turns that into a failure.
  retries: ci ? 1 : 0,
  retryStrategy: "isolated",
  // A hung run stops itself and still writes its report, well inside the CI job's 15 minutes.
  globalTimeout: ci ? 12 * 60_000 : 0,
  // Each worker runs its own hub and its own browser, so on CI half the CPUs run tests and the
  // rest serve the hubs and the runner; more shards make up the difference (#985). A reply can
  // still take longer under load than on a laptop, so assertions wait longer.
  ...(ci ? { workers: "50%", expect: { timeout: 10_000 } } : {}),
  ...(shard === undefined ? {} : shardOf(shard)),
  // The JSON report feeds the job summary's list of flaky tests (scripts/flaky-tests.mjs) and the
  // recorded test times (e2e/record-durations.ts).
  reporter: ci
    ? [["list"], ["github"], ["html", { open: "never" }], ["json", { outputFile: "test-results/report.json" }]]
    : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
