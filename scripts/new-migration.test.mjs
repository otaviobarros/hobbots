import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { MIGRATIONS_FOLDER, migrationFileName, minuteId } from "./new-migration.mjs";

const at = new Date("2026-11-13T23:15:42.123Z");

test("a new migration is named by the UTC minute it was made", () => {
  assert.equal(minuteId(at), "202611132315");
  assert.equal(
    migrationFileName("thread_members", at, ["0114_thread_members.ts", "index.ts"]),
    "202611132315_thread_members.ts",
  );
});

test("a minute already taken moves to the next free one", () => {
  const taken = ["202611132315_one.ts", "202611132316_two.ts"];
  assert.equal(migrationFileName("three", at, taken), "202611132317_three.ts");
});

test("a name must be lowercase words joined by _", () => {
  for (const name of ["Thread", "thread-members", "_x", "x__y", ""]) {
    assert.throws(() => migrationFileName(name, at, []), /is not a migration name/);
  }
});

test("the migrations folder holds only migrations and its index", () => {
  for (const file of readdirSync(MIGRATIONS_FOLDER)) {
    assert.match(file, /^(index\.ts|\d{4}_[a-z0-9_]+\.ts|\d{12}_[a-z0-9_]+\.ts)$/);
  }
});
