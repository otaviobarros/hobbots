import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { MIGRATIONS_FOLDER, migrationFileName, secondId } from "./new-migration.mjs";

const at = new Date("2026-11-13T23:15:42.123Z");

test("a new migration is named by the UTC second it was made", () => {
  assert.equal(secondId(at), "20261113231542");
  assert.equal(
    migrationFileName("thread_members", at, ["0114_thread_members.ts", "index.ts"]),
    "20261113231542_thread_members.ts",
  );
});

test("two branches that each make a migration in the same minute get different ids", () => {
  // Neither branch sees the other's file, so only the clock keeps them apart.
  const one = migrationFileName("one", new Date("2026-11-13T23:15:03Z"), []);
  const two = migrationFileName("two", new Date("2026-11-13T23:15:41Z"), []);
  assert.notEqual(one.split("_")[0], two.split("_")[0]);
});

test("a second already taken moves to the next free one", () => {
  const taken = ["20261113231542_one.ts", "20261113231543_two.ts"];
  assert.equal(migrationFileName("three", at, taken), "20261113231544_three.ts");
});

test("a name must be lowercase words joined by _", () => {
  for (const name of ["Thread", "thread-members", "_x", "x__y", ""]) {
    assert.throws(() => migrationFileName(name, at, []), /is not a migration name/);
  }
});

test("the migrations folder holds only migrations and its index", () => {
  for (const file of readdirSync(MIGRATIONS_FOLDER)) {
    assert.match(file, /^(index\.ts|\d{4}_[a-z0-9_]+\.ts|\d{14}_[a-z0-9_]+\.ts)$/);
  }
});
