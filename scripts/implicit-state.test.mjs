import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile } from "./implicit-state.mjs";

const service = (body) => `
export const make = Effect.gen(function* () {
${body}
  return { run: () => Effect.void };
});
`;

// covers ADR 037 (Validation), #1360
test("[TC-GEN-1360-02] a Set keyed by an id in a service's body fails", () => {
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

const machines = [
  { name: "Task", exportName: "TaskMachine", field: "state", states: ["queued", "active"], module: "task.ts" },
];
/** A file that uses Task, so the Task machine's comparisons are checked in it. */
const usingTask = (code) => `import type { Task } from "@hobbots/domain";\n${code}`;

// covers ADR 037 (Validation), #1360
test("[TC-GEN-1360-03] a comparison of a machine's state outside its module fails", () => {
  const problems = checkFile("a.ts", usingTask('const busy = task.state === "active";'), machines);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^a\.ts:2: compares `\.state` with "active", a state of the Task machine in task\.ts/);
  assert.equal(checkFile("a.ts", usingTask('const busy = "queued" !== task?.state;'), machines).length, 1);
});

test("a switch on a machine's state outside its module fails once per case", () => {
  const text = 'switch (task.state) {\n  case "queued":\n  case "active":\n    break;\n  case "done":\n}';
  assert.equal(checkFile("a.ts", usingTask(text), machines).length, 2);
});

test("a list of a machine's states checked with includes fails once per state", () => {
  const text = 'const open = ["queued", "active", "done"].includes(task.state);';
  assert.equal(checkFile("a.ts", usingTask(text), machines).length, 2);
});

test("a file that imports the machine itself is checked too", () => {
  const text = 'import { TaskMachine } from "@hobbots/domain";\nconst busy = task.state === "active";';
  assert.equal(checkFile("a.ts", text, machines).length, 1);
});

test("a file that names neither the record nor the machine is not checked", () => {
  const text = 'import { Socket } from "./socket.ts";\nconst busy = socket.state === "active";';
  assert.deepEqual(checkFile("a.ts", text, machines), []);
});

test("a comparison in the machine's own module passes", () => {
  assert.deepEqual(checkFile("task.ts", 'const busy = task.state === "active";', machines), []);
});

test("a comparison with a value that is not one of the machine's states passes", () => {
  const text = 'const busy = task.state === "running" || task.kind === "active";';
  assert.deepEqual(checkFile("a.ts", usingTask(text), machines), []);
});

test("a comparison opted out with a reason passes", () => {
  const text =
    "// standards-allow STD-ARCH-013: an Attempt's state, not a Task's\nconst live = attempt.state === \"active\";";
  assert.deepEqual(checkFile("a.ts", usingTask(text), machines), []);
});

test("with two machines sharing a field and a state, each module compares its own and not the other's", () => {
  const two = [
    { name: "Task", field: "state", states: ["queued", "failed"], module: "task.ts" },
    { name: "Backpack", field: "state", states: ["claimed", "failed"], module: "backpack.ts" },
  ];
  const usingBoth = (code) => `import type { Backpack, Task } from "@hobbots/domain";\n${code}`;
  assert.deepEqual(checkFile("backpack.ts", usingBoth('const lost = item.state === "failed";'), two), []);
  assert.deepEqual(checkFile("task.ts", usingBoth('const lost = task.state === "failed";'), two), []);
  const foreign = checkFile("backpack.ts", usingBoth('const waiting = task.state === "queued";'), two);
  assert.equal(foreign.length, 1);
  assert.match(foreign[0], /a state of the Task machine in task\.ts/);
  assert.equal(checkFile("other.ts", usingBoth('const lost = item.state === "failed";'), two).length, 1);
});

test("a comparison through a cast or a destructured binding fails", () => {
  assert.equal(checkFile("a.ts", usingTask('const busy = (task.state as string) === "active";'), machines).length, 1);
  assert.equal(
    checkFile("a.ts", usingTask('const { state } = task;\nconst busy = state === "active";'), machines).length,
    1,
  );
});
