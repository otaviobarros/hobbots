import { defineConfig, devices } from "@playwright/test";

// Browser checks of the built site, served by `astro preview` in the local Workers runtime with local D1.
// Build first: `pnpm --filter @hobbots/site build`, and copy .dev.vars.example to .dev.vars.
const port = 4322;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `wrangler d1 migrations apply WAITLIST_DB --local && astro preview --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
