import assert from "node:assert/strict";
import { test } from "node:test";
import { declarationsIn, unreadUse } from "./machine-registry.mjs";

test("finds an exported machine and one that is not exported", () => {
  const text = [
    "export const TaskMachine = defineMachine<TaskState, TaskEvent, Task, Err>({",
    "const RunMachine: Machine<A, B, C, D> = defineMachine({",
    "const notAMachine = define({",
  ].join("\n");
  assert.deepEqual(declarationsIn(text), [
    { exportName: "TaskMachine", exported: true, typed: true },
    { exportName: "RunMachine", exported: false, typed: false },
  ]);
});

test("a machine declared on its own is read", () => {
  assert.equal(unreadUse("export const TaskMachine = defineMachine<A, B, C, D>({});"), undefined);
  assert.equal(unreadUse('export { defineMachine } from "./machine.ts";'), undefined);
});

test("a machine wrapped with helpers, assigned or aliased is refused", () => {
  assert.match(
    unreadUse("export const ThreadRun = { ...defineMachine<A, B, C, D>({}), isRunning };"),
    /declare the machine on its own/,
  );
  assert.match(
    unreadUse("export const ThreadRun = Object.assign(defineMachine<A, B, C, D>({}), { isRunning });"),
    /declare the machine on its own/,
  );
  assert.match(
    unreadUse('import { defineMachine as machine } from "@hobbots/domain";\nexport const X = machine<A, B, C, D>({});'),
    /under another name/,
  );
});
