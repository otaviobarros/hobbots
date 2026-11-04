import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { type Durations, parseShard, shardFilter } from "./e2e/shards.ts";

// Browser checks of the served web client against a real hub. Each test starts its own hub with
// an empty data folder on its worker's port (see e2e/hub.ts), so tests run in parallel.
//
// HOBBOTS_E2E_SHARD=2/4 runs one of four shards balanced by the times in e2e/durations.json
// (see e2e/shards.ts); CI runs each shard on its own runner.
const shardOf = (value: string) => {
  const { current, total } = parseShard(value);
  const durations = JSON.parse(readFileSync(new URL("e2e/durations.json", import.meta.url), "utf8")) as Durations;
  return shardFilter(durations, current, total);
};
const shard = process.env.HOBBOTS_E2E_SHARD;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  // A hung run stops itself and still writes its report, well inside the CI job's 15 minutes.
  globalTimeout: process.env.CI ? 12 * 60_000 : 0,
  // The tests mostly wait on their hubs, so a CI runner runs one worker per CPU, not half. With
  // four hubs and browsers sharing the CPUs a reply can take longer, so assertions wait longer.
  ...(process.env.CI ? { workers: "100%", expect: { timeout: 10_000 } } : {}),
  ...(shard === undefined ? {} : shardOf(shard)),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
