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

test("a collection keyed by an id in its declared type fails", () => {
  assert.equal(checkFile("a.ts", service("  const busy: Set<ThreadId> = new Set();")).length, 1);
  assert.equal(checkFile("a.ts", "const waiting: Map<TaskId, number> = new Map();").length, 1);
});

test("an opt-out with no reason still fails", () => {
  const body = "  // standards-allow STD-ARCH-013:\n  const open = new Map<DeviceId, Socket>();";
  assert.equal(checkFile("a.ts", service(body)).length, 1);
});

test("an opt-out inside a string is not an opt-out", () => {
  const body =
    '  const note = "standards-allow STD-ARCH-013: not a comment";\n  const open = new Map<DeviceId, Socket>();';
  assert.equal(checkFile("a.ts", service(body)).length, 1);
});

const machines = [{ name: "Task", field: "state", states: ["queued", "active"], module: "task.ts" }];

test("a comparison of a machine's state outside its module fails", () => {
  const problems = checkFile("a.ts", 'const busy = task.state === "active";', machines);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^a\.ts:1: compares `\.state` with "active", a state of the Task machine in task\.ts/);
  assert.equal(checkFile("a.ts", 'const busy = "queued" !== task?.state;', machines).length, 1);
});

test("a switch on a machine's state outside its module fails once per case", () => {
  const text = 'switch (task.state) {\n  case "queued":\n  case "active":\n    break;\n  case "done":\n}';
  assert.equal(checkFile("a.ts", text, machines).length, 2);
});

test("a comparison in the machine's own module passes", () => {
  assert.deepEqual(checkFile("task.ts", 'const busy = task.state === "active";', machines), []);
});

test("a comparison with a value that is not one of the machine's states passes", () => {
  assert.deepEqual(checkFile("a.ts", 'const busy = task.state === "running" || task.kind === "active";', machines), []);
});

test("a comparison opted out with a reason passes", () => {
  const text =
    "// standards-allow STD-ARCH-013: an Attempt's state, not a Task's\nconst live = attempt.state === \"active\";";
  assert.deepEqual(checkFile("a.ts", text, machines), []);
});
