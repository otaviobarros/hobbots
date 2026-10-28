#!/usr/bin/env node
// Runs the persistence and server suites on the PostgreSQL in infrastructure/local (ADR 011).
// Requires Docker. Starts the database if it is not running, and leaves it running afterwards.
// Usage: pnpm test:pg [turbo options, for example --force]

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// pnpm is a .cmd shim on Windows, which only runs through a shell.
const run = (command, args, env) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });

try {
  run("docker", ["compose", "-f", "infrastructure/local/compose.yaml", "up", "--detach", "--wait"]);
  run(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "test",
      "--filter=@hobbots/persistence",
      "--filter=@hobbots/server",
      ...process.argv.slice(2),
    ],
    {
      ...process.env,
      HOBBOTS_TEST_DB: "postgres",
      HOBBOTS_TEST_DATABASE_URL: "postgres://postgres@127.0.0.1:54329/hobbots_test",
    },
  );
} catch (error) {
  // A command that never started (for example docker missing from PATH) printed nothing itself.
  if (error.status == null) console.error(error.message);
  process.exit(error.status ?? 1);
}
