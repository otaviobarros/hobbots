import { defineConfig, devices } from "@playwright/test";

// Browser checks of the served web client against a real hub. Each test starts its own hub with
// an empty data folder (see e2e/hub.ts), so the tests run one at a time on one port.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
