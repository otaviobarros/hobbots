import assert from "node:assert/strict";
import { test } from "node:test";
import { check, isChecked, ownerActorLines } from "./owner-actor.mjs";

test("finds OWNER_ACTOR imported and used, and not in a comment or a string", () => {
  const text = [
    'import { OWNER_ACTOR } from "@hobbots/domain";',
    "// OWNER_ACTOR names the owner.",
    'const label = "OWNER_ACTOR";',
    "const actor = OWNER_ACTOR;",
    "const kind = OWNER_ACTOR.kind;",
  ].join("\n");
  assert.deepEqual(ownerActorLines("a.ts", text), [1, 4, 5]);
});

test("reads the hub's and the apps' sources, not tests, fakes in testing folders or the allowed files", () => {
  assert.equal(isChecked("packages/agents/src/notes.ts"), true);
  assert.equal(isChecked("apps/web/src/components/find/find-model.ts"), true);
  assert.equal(isChecked("apps/web/src/components/find/find-model.test.ts"), false);
  assert.equal(isChecked("packages/agents/test/notes.test.ts"), false);
  assert.equal(isChecked("packages/runtimes/src/testing/fake.ts"), false);
  assert.equal(isChecked("packages/domain/src/actor.ts"), false);
  assert.equal(isChecked("packages/agents/src/users.ts"), false);
  assert.equal(isChecked("packages/persistence/src/migrations/0112_device_users.ts"), false);
  assert.equal(isChecked("scripts/owner-actor.mjs"), false);
});

test("fails a new direct use and names the rule", () => {
  const files = {
    "packages/agents/src/notes.ts": "import { OWNER_ACTOR } from '@hobbots/domain';\nexport const a = OWNER_ACTOR;\n",
    "packages/agents/src/users.ts": "import { OWNER_ACTOR } from '@hobbots/domain';\nexport const b = OWNER_ACTOR;\n",
  };
  const errors = check(Object.keys(files), (file) => files[file]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^packages\/agents\/src\/notes\.ts:1 names OWNER_ACTOR\..*STD-SEC-006/);
});
