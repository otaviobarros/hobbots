import { defineConfig } from "vitest/config";

// On CI a failed test runs once more; one that then passes is listed as flaky in the job summary
// by Vitest's GitHub Actions reporter, and is a bug to fix (STD-TEST-009).
export default defineConfig({
  test: { retry: process.env.CI ? 1 : 0 },
});
