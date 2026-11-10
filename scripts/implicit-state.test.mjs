import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile } from "./implicit-state.mjs";

const service = (body) => `
export const make = Effect.gen(function* () {
${body}
  return { run: () => Effect.void };
});
`;

test("a Set keyed by an id in a service's body fails", () => {
  const problems = checkFile("a.ts", service("  const busy = new Set<ThreadId>();"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^a\.ts:3: `busy` .*ThreadId.*\(STD-ARCH-013\)$/);
});

test("a Map keyed by an id at module level fails", () => {
  assert.equal(checkFile("a.ts", "const waiting = new Map<TaskId, number>();").length, 1);
});

test("a fold inside a plain function passes", () => {
  const text = "export const count = (xs: Array<Task>) => { const seen = new Set<TaskId>(); return seen.size; };";
  assert.deepEqual(checkFile("a.ts", text), []);
});

test("a collection inside a nested block of a generator passes", () => {
  assert.deepEqual(checkFile("a.ts", service("  if (x) { const seen = new Set<TaskId>(); }")), []);
});

test("a collection keyed by something other than an id passes", () => {
  assert.deepEqual(checkFile("a.ts", service("  const names = new Map<string, number>();")), []);
});

test("an opt-out with a reason on the line above passes", () => {
  const body =
    "  // standards-allow STD-ARCH-013: a cache of open sockets, not lifecycle state\n  const open = new Map<DeviceId, Socket>();";
  assert.deepEqual(checkFile("a.ts", service(body)), []);
});
