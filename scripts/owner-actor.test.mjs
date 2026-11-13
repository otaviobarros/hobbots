import assert from "node:assert/strict";
import { test } from "node:test";
import { bareAuthorFields, check, checkRecords, isChecked, isRecordChecked, ownerActorLines } from "./owner-actor.mjs";

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

test("finds a field that says who did something with a bare user or hob id, and not an Actor, an owner or a value", () => {
  const text = [
    'import { Actor, AgentId, UserId } from "@hobbots/domain";',
    'export class Request extends Schema.Class<Request>("Request")({',
    "  requestedBy: UserId,",
    "  reviewedBy: Schema.NullOr(AgentId),",
    "  author: AgentId,",
    "  decidedBy: Actor,",
    "  userId: UserId,",
    "  pickedUpBy: Schema.NullOr(Schema.String),",
    "}) {}",
    "const made = { reachedBy: task.ownerId };",
  ].join("\n");
  assert.deepEqual(bareAuthorFields("a.ts", text), [
    { field: "requestedBy", line: 3 },
    { field: "reviewedBy", line: 4 },
    { field: "author", line: 5 },
  ]);
});

test("the record check reads sources, not tests or fakes", () => {
  assert.equal(isRecordChecked("packages/domain/src/quest.ts"), true);
  assert.equal(isRecordChecked("apps/server/src/fake-quest.ts"), false);
  assert.equal(isRecordChecked("apps/server/src/testing/people.ts"), false);
  assert.equal(isRecordChecked("packages/domain/test/quest.test.ts"), false);
});

test("fails a new record with a bare user or hob id, passes a known one and flags a known one that is gone", () => {
  const files = {
    "packages/domain/src/request.ts": "export const Request = Schema.Struct({ requestedBy: UserId });\n",
    "packages/domain/src/agent.ts": "export const fields = { summonedBy: Schema.NullOr(AgentId) };\n",
  };
  const known = new Set(["packages/domain/src/agent.ts summonedBy", "packages/domain/src/quest.ts reachedBy"]);
  const errors = checkRecords(Object.keys(files), (file) => files[file], known);
  assert.equal(errors.length, 2);
  assert.match(
    errors[0],
    /^packages\/domain\/src\/request\.ts:1 says who did something in "requestedBy".*STD-ARCH-020/,
  );
  assert.match(errors[1], /^"packages\/domain\/src\/quest\.ts reachedBy" no longer names a bare id/);
});
